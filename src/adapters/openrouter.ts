import { MediaError } from '../errors.js'
import { MediaJob, mapJobState } from '../media-job.js'
import { BaseAdapter, artifactsOrThrow, bearerHeaders, dataUris, makeModel, mergeOptions, requirePrompt } from './base.js'
import type { AdapterContext, AdapterResult, Capability, JobStatus, JsonObject, MediaRequest, ModelDescriptor, ModelDiscoveryContext, RemoteArtifact } from '../types.js'

const IMAGE_CAPS: Capability[] = ['image.text_to_image', 'image.image_to_image', 'image.edit', 'image.multi_reference']
const VIDEO_CAPS: Capability[] = ['video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.reference', 'video.native_audio']

interface CatalogModel {
  id?: string
  architecture?: { output_modalities?: string[] }
  supported_durations?: number[]
  supported_resolutions?: string[]
  supported_aspect_ratios?: string[]
  supported_parameters?: string[]
}

export class OpenRouterAdapter extends BaseAdapter {
  readonly id = 'openrouter'
  readonly displayName = 'OpenRouter'
  readonly envKey = 'OPENROUTER_API_KEY'
  private readonly baseUrl = 'https://openrouter.ai/api/v1'
  private readonly catalog = new Map<string, CatalogModel>()
  private readonly catalogCapabilities = new Map<string, Set<Capability>>()

  models(): ModelDescriptor[] {
    return [
      makeModel(this.id, 'multi-vendor', '<OpenRouter image model>', IMAGE_CAPS, 'Use /images/models to choose a current image model'),
      makeModel(this.id, 'multi-vendor', '<OpenRouter video model>', VIDEO_CAPS, 'Values are model-specific; discovery returns the current constraints'),
      makeModel(this.id, 'multi-vendor', '<OpenRouter TTS model>', ['speech.tts']),
    ]
  }

  async discoverModels(context: ModelDiscoveryContext): Promise<ModelDescriptor[]> {
    const key = this.keyFromOptions(context.providerOptions)
    const headers = bearerHeaders(key)
    const urls = [
      `${this.baseUrl}/images/models`,
      `${this.baseUrl}/videos/models`,
      `${this.baseUrl}/models?output_modalities=speech`,
    ]
    const results = await Promise.allSettled(urls.map(url => this.http.json<{ data?: CatalogModel[] }>(url, {
      headers, signal: context.signal, provider: this.id, secrets: [key], timeoutMs: 30_000,
    })))
    const models = new Map<string, ModelDescriptor>()
    results.forEach((result, index) => {
      if (result.status !== 'fulfilled') return
      for (const entry of result.value.data ?? []) {
        if (!entry.id) continue
        this.catalog.set(entry.id, entry)
        const capabilities: Capability[] = index === 0 ? imageCapabilities(entry) : index === 1 ? videoCapabilities(entry) : ['speech.tts']
        const catalogCaps = this.catalogCapabilities.get(entry.id) ?? new Set<Capability>()
        capabilities.forEach(capability => catalogCaps.add(capability))
        this.catalogCapabilities.set(entry.id, catalogCaps)
        const existing = models.get(entry.id)
        models.set(entry.id, makeModel(
          this.id,
          entry.id.split('/')[0] ?? 'multi-vendor',
          entry.id,
          [...new Set([...(existing?.capabilities ?? []), ...capabilities])],
          catalogNotes(entry),
        ))
      }
    })
    if (!models.size) throw new MediaError('PROVIDER', 'OpenRouter media model discovery returned no usable catalogs', { provider: this.id })
    return [...models.values()]
  }

  hasCatalogModel(model: string): boolean {
    return this.catalogCapabilities.has(model)
  }

  supports(capability: Capability, model: string): boolean {
    const discovered = this.catalogCapabilities.get(model)
    if (discovered) return discovered.has(capability)
    if (capability.startsWith('image.')) return IMAGE_CAPS.includes(capability) && /(?:image|flux|stable.?diffusion|ideogram|recraft|seedream|nano.?banana)/i.test(model)
    if (capability.startsWith('video.')) return VIDEO_CAPS.includes(capability) && /(?:video|veo|kling|wan|seedance|sora|hailuo|minimax)/i.test(model)
    return capability === 'speech.tts' && /(?:tts|speech|elevenlabs|audio)/i.test(model)
  }

  async execute(request: MediaRequest, context: AdapterContext): Promise<AdapterResult> {
    this.assertSupport(request)
    if (request.capability.startsWith('image.')) return this.image(request, context)
    if (request.capability.startsWith('video.')) return this.video(request, context)
    return this.tts(request, context)
  }

  private async image(request: MediaRequest, context: AdapterContext): Promise<AdapterResult> {
    if ((request.count ?? 1) > 10) throw new MediaError('INPUT', 'OpenRouter images support at most 10 outputs', { provider: this.id })
    if (request.mask) throw new MediaError('CAPABILITY_UNSUPPORTED', 'OpenRouter Images API does not expose mask editing', { provider: this.id })
    const key = this.key(request)
    const references = [request.inputImage, ...(request.referenceImages ?? [])].filter((value): value is string => Boolean(value))
    const inputReferences = await dataUris(this.input, references, context.signal)
    if (inputReferences.length > 16) throw new MediaError('INPUT', 'OpenRouter Images API supports at most 16 input references', { provider: this.id })
    const payload = mergeOptions({
      model: request.model,
      prompt: requirePrompt(request),
      n: request.count ?? 1,
      ...(inputReferences.length ? { input_references: inputReferences } : {}),
      ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}),
      ...(request.resolution ? { size: request.resolution } : {}),
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
      ...(request.background ? { background: request.background } : {}),
      ...(request.outputFormat ? { output_format: request.outputFormat } : {}),
      ...(request.quality ? { quality: request.quality } : {}),
      ...(request.compression !== undefined ? { output_compression: request.compression } : {}),
    }, request.providerOptions)
    const data = await this.http.json<unknown>(`${this.baseUrl}/images`, {
      method: 'POST', headers: bearerHeaders(key, { 'Content-Type': 'application/json' }), body: JSON.stringify(payload),
      signal: context.signal, provider: this.id, secrets: [key], timeoutMs: 180_000,
    })
    return artifactsOrThrow(this.result(request, data, 'image'))
  }

  private async tts(request: MediaRequest, context: AdapterContext): Promise<AdapterResult> {
    if (request.inputAudio) throw new MediaError('CAPABILITY_UNSUPPORTED', 'OpenRouter voice cloning is not exposed by the normalized speech tool', { provider: this.id })
    const text = request.text ?? request.prompt ?? ''
    if (!text.trim()) throw new MediaError('INPUT', 'OpenRouter TTS requires text', { provider: this.id })
    const key = this.key(request)
    const format = request.responseFormat ?? 'pcm'
    if (!['mp3', 'pcm'].includes(format.toLowerCase())) throw new MediaError('INPUT', 'OpenRouter TTS format must be mp3 or pcm', { provider: this.id })
    const payload = mergeOptions({
      model: request.model,
      input: text,
      ...(request.voice ? { voice: request.voice } : {}),
      response_format: format,
    }, request.providerOptions)
    const response = await this.http.request(`${this.baseUrl}/audio/speech`, {
      method: 'POST', headers: bearerHeaders(key, { 'Content-Type': 'application/json' }), body: JSON.stringify(payload),
      signal: context.signal, provider: this.id, secrets: [key], timeoutMs: 180_000,
    })
    if (!response.body) throw new MediaError('PROVIDER', 'OpenRouter TTS returned an empty response body', { provider: this.id })
    return {
      provider: this.id, model: request.model, capability: request.capability,
      artifacts: [{ kind: 'audio', stream: response.body, mimeType: response.headers.get('content-type') ?? `audio/${format}`, fileName: `speech.${format}` }],
    }
  }

  private async video(request: MediaRequest, context: AdapterContext): Promise<AdapterResult> {
    if (request.inputVideo || request.referenceVideos?.length || request.referenceAudios?.length || request.referenceAudioVoices?.length) {
      throw new MediaError('CAPABILITY_UNSUPPORTED', 'OpenRouter video supports frame and image references, not input/reference video or audio', { provider: this.id })
    }
    const key = this.key(request)
    const firstFrame = request.inputImage ? await this.input.asDataUri(request.inputImage, context.signal) : undefined
    const lastFrame = request.endImage ? await this.input.asDataUri(request.endImage, context.signal) : undefined
    const references = await dataUris(this.input, request.referenceImages, context.signal)
    if ((firstFrame || lastFrame) && references.length) {
      throw new MediaError('INPUT', 'OpenRouter frame_images and input_references are mutually exclusive generation modes', { provider: this.id })
    }
    validateCatalogOptions(request, this.catalog.get(request.model))
    const frameImages = [
      ...(firstFrame ? [{ type: 'image_url', image_url: { url: firstFrame }, frame_type: 'first_frame' }] : []),
      ...(lastFrame ? [{ type: 'image_url', image_url: { url: lastFrame }, frame_type: 'last_frame' }] : []),
    ]
    const inputReferences = references.map(url => ({ type: 'image_url', image_url: { url } }))
    const payload: JsonObject = mergeOptions({
      model: request.model,
      prompt: requirePrompt(request),
      ...(frameImages.length ? { frame_images: frameImages } : {}),
      ...(inputReferences.length ? { input_references: inputReferences } : {}),
      ...(request.duration ? { duration: request.duration } : {}),
      ...(request.resolution ? (/^\d+x\d+$/i.test(request.resolution) ? { size: request.resolution } : { resolution: request.resolution }) : {}),
      ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}),
      ...(request.generateAudio !== undefined ? { generate_audio: request.generateAudio } : {}),
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
    }, request.providerOptions)
    const submitted = await this.http.json<Record<string, unknown>>(`${this.baseUrl}/videos`, {
      method: 'POST', headers: bearerHeaders(key, { 'Content-Type': 'application/json' }), body: JSON.stringify(payload),
      signal: context.signal, provider: this.id, secrets: [key], timeoutMs: 60_000,
    })
    const jobId = typeof submitted.id === 'string' ? submitted.id : typeof submitted.job_id === 'string' ? submitted.job_id : undefined
    if (!jobId) return artifactsOrThrow(this.result(request, submitted, 'video'))
    const job = new MediaJob<Record<string, unknown>>({
      id: jobId, provider: this.id, signal: context.signal, timeoutMs: timeout(request), minDelayMs: 30_000, maxDelayMs: 30_000,
      onProgress: status => context.onProgress?.(`OpenRouter ${jobId}: ${status.state}`),
      poll: async signal => {
        const status = await this.http.json<Record<string, unknown>>(`${this.baseUrl}/videos/${encodeURIComponent(jobId)}`, {
          headers: bearerHeaders(key), signal, provider: this.id, secrets: [key], timeoutMs: 30_000,
        })
        const state = mapJobState(status.status)
        return { state, ...(state === 'succeeded' ? { result: status } : {}), ...(typeof status.error === 'string' ? { message: status.error } : {}) } satisfies JobStatus<Record<string, unknown>>
      },
    })
    const completed = await job.wait()
    const result = this.result(request, completed, 'video', { jobId })
    result.artifacts = result.artifacts.map(artifact => artifact.url && new URL(artifact.url).origin === new URL(this.baseUrl).origin
      ? { ...artifact, headers: bearerHeaders(key), headerOrigin: new URL(this.baseUrl).origin }
      : artifact)
    if (result.artifacts.length === 0) {
      const url = `${this.baseUrl}/videos/${encodeURIComponent(jobId)}/content`
      const artifact: RemoteArtifact = { kind: 'video', url, headers: bearerHeaders(key), headerOrigin: new URL(this.baseUrl).origin }
      result.artifacts.push(artifact)
    }
    return result
  }
}

function imageCapabilities(model: CatalogModel): Capability[] {
  const parameters = new Set(model.supported_parameters ?? [])
  return [
    'image.text_to_image',
    ...(parameters.has('input_references') ? ['image.image_to_image', 'image.edit', 'image.multi_reference'] as Capability[] : []),
  ]
}

function videoCapabilities(model: CatalogModel): Capability[] {
  const parameters = new Set(model.supported_parameters ?? [])
  return [
    'video.text_to_video',
    ...(parameters.has('frame_images') ? ['video.image_to_video', 'video.first_last_frame'] as Capability[] : []),
    ...(parameters.has('input_references') ? ['video.reference'] as Capability[] : []),
    ...(parameters.has('generate_audio') ? ['video.native_audio'] as Capability[] : []),
  ]
}

function validateCatalogOptions(request: MediaRequest, model?: CatalogModel): void {
  if (!model) return
  if (request.duration !== undefined && model.supported_durations?.length && !model.supported_durations.includes(request.duration)) {
    throw new MediaError('INPUT', `${request.model} supports durations: ${model.supported_durations.join(', ')}`, { provider: request.provider })
  }
  if (request.resolution && model.supported_resolutions?.length && !model.supported_resolutions.includes(request.resolution)) {
    throw new MediaError('INPUT', `${request.model} supports resolutions: ${model.supported_resolutions.join(', ')}`, { provider: request.provider })
  }
  if (request.aspectRatio && model.supported_aspect_ratios?.length && !model.supported_aspect_ratios.includes(request.aspectRatio)) {
    throw new MediaError('INPUT', `${request.model} supports aspect ratios: ${model.supported_aspect_ratios.join(', ')}`, { provider: request.provider })
  }
}

function catalogNotes(model: CatalogModel): string | undefined {
  const notes = [
    model.supported_durations?.length ? `duration=${model.supported_durations.join('|')}` : undefined,
    model.supported_resolutions?.length ? `resolution=${model.supported_resolutions.join('|')}` : undefined,
    model.supported_aspect_ratios?.length ? `ratio=${model.supported_aspect_ratios.join('|')}` : undefined,
  ].filter(Boolean)
  return notes.length ? notes.join('; ') : undefined
}

function timeout(request: MediaRequest): number {
  const value = request.providerOptions?.timeoutMs
  return typeof value === 'number' && value > 0 ? value : 40 * 60_000
}
