import { MediaError } from '../errors.js'
import { MediaJob, mapJobState } from '../media-job.js'
import { BaseAdapter, artifactsOrThrow, bearerHeaders, dataUris, makeModel, mergeOptions, requirePrompt } from './base.js'
import type { AdapterContext, AdapterResult, Capability, JobStatus, JsonObject, MediaRequest, ModelDescriptor, ModelDiscoveryContext } from '../types.js'

const ATLAS_CAPS: Capability[] = [
  'image.text_to_image', 'image.image_to_image', 'image.edit',
  'video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.reference',
  'video.native_audio',
]

export class AtlasAdapter extends BaseAdapter {
  readonly id = 'atlas'
  readonly displayName = 'Atlas API (aixoras.com)'
  readonly envKey = 'ATLAS_API_KEY'
  private readonly baseUrl = 'https://api.aixoras.com/v1'

  models(): ModelDescriptor[] {
    return [
      makeModel(this.id, 'openai', 'gpt-image-2', ['image.text_to_image', 'image.image_to_image', 'image.edit'], 'Use the exact model id returned for your Atlas account'),
      makeModel(this.id, 'bytedance', 'bytedance/seedance-2.0/text-to-video', ['video.text_to_video', 'video.reference', 'video.native_audio']),
      makeModel(this.id, 'bytedance', 'bytedance/seedance-2.0/image-to-video', ['video.image_to_video', 'video.first_last_frame', 'video.reference', 'video.native_audio']),
    ]
  }

  async discoverModels(context: ModelDiscoveryContext): Promise<ModelDescriptor[]> {
    const key = this.keyFromOptions(context.providerOptions)
    const payload = await this.http.json<{ data?: Array<{ id?: string; owned_by?: string }> }>(`${this.baseUrl}/models`, {
      headers: bearerHeaders(key), signal: context.signal, provider: this.id, secrets: [key], timeoutMs: 30_000,
    })
    return (payload.data ?? []).flatMap(entry => {
      if (!entry.id) return []
      const capabilities = atlasCapabilities(entry.id, this.models())
      return capabilities.length ? [makeModel(this.id, entry.owned_by ?? 'multi-vendor', entry.id, capabilities)] : []
    })
  }

  supports(capability: Capability): boolean { return ATLAS_CAPS.includes(capability) }

  async execute(request: MediaRequest, context: AdapterContext): Promise<AdapterResult> {
    this.assertSupport(request)
    if (request.capability.startsWith('video.')) return this.video(request, context)
    if (request.capability === 'image.text_to_image' && !request.inputImage && !request.referenceImages?.length) return this.imageGenerate(request, context)
    return this.imageEdit(request, context)
  }

  private async imageGenerate(request: MediaRequest, context: AdapterContext): Promise<AdapterResult> {
    const key = this.key(request)
    const asyncMode = request.providerOptions?.async === true
    const { async: _async, timeoutMs: _timeoutMs, ...nativeOptions } = request.providerOptions ?? {}
    const payload = mergeOptions({
      model: request.model, prompt: requirePrompt(request), n: request.count ?? 1,
      ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}),
      ...(request.resolution ? { size: request.resolution } : {}),
      response_format: 'url',
      ...(request.seed !== undefined ? { extra_fields: { seed: request.seed } } : {}),
    }, nativeOptions)
    const submitted = await this.http.json<Record<string, unknown>>(`${this.baseUrl}/images/generations${asyncMode ? '/async' : ''}`, {
      method: 'POST', headers: bearerHeaders(key, { 'Content-Type': 'application/json' }), body: JSON.stringify(payload),
      signal: context.signal, provider: this.id, secrets: [key], timeoutMs: 120_000,
    })
    return asyncMode ? this.waitImage(request, submitted, context) : artifactsOrThrow(this.result(request, submitted, 'image'))
  }

  private async imageEdit(request: MediaRequest, context: AdapterContext): Promise<AdapterResult> {
    const key = this.key(request)
    const sources = [request.inputImage, ...(request.referenceImages ?? [])].filter((value): value is string => Boolean(value))
    if (!sources.length) throw new MediaError('INPUT', 'Atlas image edit requires inputImage or referenceImages', { provider: this.id })
    if (sources.length > 1) throw new MediaError('CAPABILITY_UNSUPPORTED', 'Atlas documentation defines one image upload for image edits', { provider: this.id })
    const asyncMode = request.providerOptions?.async === true
    const form = new FormData()
    form.set('model', request.model)
    form.set('prompt', requirePrompt(request))
    form.set('n', String(request.count ?? 1))
    form.set('response_format', 'url')
    for (const source of sources) {
      const image = await this.input.asBlob(source, context.signal)
      form.append(sources.length === 1 ? 'image' : 'image[]', image.blob, image.fileName)
    }
    for (const [name, value] of Object.entries(request.providerOptions ?? {})) {
      if (!['async', 'timeoutMs'].includes(name) && value !== undefined) form.set(name, typeof value === 'string' ? value : JSON.stringify(value))
    }
    const submitted = await this.http.json<Record<string, unknown>>(`${this.baseUrl}/images/edits${asyncMode ? '/async' : ''}`, {
      method: 'POST', headers: bearerHeaders(key), body: form, signal: context.signal,
      provider: this.id, secrets: [key], timeoutMs: 120_000,
    })
    return asyncMode ? this.waitImage(request, submitted, context) : artifactsOrThrow(this.result(request, submitted, 'image'))
  }

  private async waitImage(request: MediaRequest, submitted: Record<string, unknown>, context: AdapterContext): Promise<AdapterResult> {
    const key = this.key(request)
    const taskId = stringId(submitted)
    if (!taskId) return artifactsOrThrow(this.result(request, submitted, 'image'))
    const completed = await this.pollTask<Record<string, unknown>>(
      taskId, `${this.baseUrl}/images/tasks/${encodeURIComponent(taskId)}`, key, request, context,
    )
    return artifactsOrThrow(this.result(request, completed, 'image', { jobId: taskId }))
  }

  private async video(request: MediaRequest, context: AdapterContext): Promise<AdapterResult> {
    const key = this.key(request)
    const inputImage = request.inputImage ? await this.input.asDataUri(request.inputImage, context.signal) : undefined
    const endImage = request.endImage ? await this.input.asDataUri(request.endImage, context.signal) : undefined
    const references = await dataUris(this.input, request.referenceImages, context.signal)
    const referenceVideos = await dataUris(this.input, request.referenceVideos, context.signal)
    const referenceAudios = await dataUris(this.input, request.referenceAudios, context.signal)
    const inputVideo = request.inputVideo ? await this.input.asDataUri(request.inputVideo, context.signal) : undefined
    const images = [...new Set([inputImage, endImage, ...references].filter((value): value is string => Boolean(value)))]
    const metadata: JsonObject = {
      ...(references.length ? { reference_images: references } : {}),
      ...(referenceVideos.length ? { reference_videos: referenceVideos } : {}),
      ...(referenceAudios.length ? { reference_audios: referenceAudios } : {}),
      ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}),
      ...(request.generateAudio !== undefined ? { generate_audio: request.generateAudio } : {}),
      ...(inputVideo ? { input_video: inputVideo } : {}),
      ...(request.operation ? { operation: request.operation } : {}),
      ...((request.providerOptions?.metadata && typeof request.providerOptions.metadata === 'object') ? request.providerOptions.metadata as JsonObject : {}),
    }
    const { metadata: _metadata, timeoutMs: _timeoutMs, ...nativeOptions } = request.providerOptions ?? {}
    const payload = mergeOptions({
      model: request.model, prompt: requirePrompt(request),
      ...(request.duration ? { duration: request.duration, seconds: String(request.duration) } : {}),
      ...(request.resolution ? { resolution: request.resolution, size: request.resolution } : {}),
      ...(images.length ? { images, image: images[0], input_reference: images[0] } : {}),
      metadata,
    }, nativeOptions)
    const submitted = await this.http.json<Record<string, unknown>>(`${this.baseUrl}/video/generations`, {
      method: 'POST', headers: bearerHeaders(key, { 'Content-Type': 'application/json' }), body: JSON.stringify(payload),
      signal: context.signal, provider: this.id, secrets: [key], timeoutMs: 60_000,
    })
    const taskId = stringId(submitted)
    if (!taskId) return artifactsOrThrow(this.result(request, submitted, 'video'))
    const completed = await this.pollTask<Record<string, unknown>>(
      taskId, `${this.baseUrl}/video/generations/${encodeURIComponent(taskId)}`, key, request, context,
    )
    return artifactsOrThrow(this.result(request, completed, 'video', { jobId: taskId }))
  }

  private async pollTask<T extends Record<string, unknown>>(taskId: string, url: string, key: string, request: MediaRequest, context: AdapterContext): Promise<T> {
    const job = new MediaJob<T>({
      id: taskId, provider: this.id, signal: context.signal, timeoutMs: timeout(request), minDelayMs: 3_000, maxDelayMs: 5_000,
      onProgress: status => context.onProgress?.(`Atlas ${taskId}: ${status.state}`),
      poll: async signal => {
        const status = await this.http.json<T>(url, {
          headers: bearerHeaders(key), signal, provider: this.id, secrets: [key], timeoutMs: 30_000,
        })
        const state = mapJobState(status.status ?? status.raw_status)
        const message = typeof status.fail_reason === 'string' ? status.fail_reason : undefined
        return { state, ...(state === 'succeeded' ? { result: status } : {}), ...(message ? { message } : {}) } satisfies JobStatus<T>
      },
    })
    return job.wait()
  }
}

function atlasCapabilities(id: string, declared: ModelDescriptor[]): Capability[] {
  const known = declared.find(model => model.id === id)
  if (known) return known.capabilities
  if (/(?:image|dall-e|flux|ideogram)/i.test(id)) return ['image.text_to_image', 'image.image_to_image', 'image.edit']
  if (/(?:video|veo|seedance|kling|sora)/i.test(id)) return ['video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.reference', 'video.native_audio']
  return []
}

function stringId(payload: Record<string, unknown>): string | undefined {
  return typeof payload.task_id === 'string' ? payload.task_id : typeof payload.id === 'string' ? payload.id : undefined
}

function timeout(request: MediaRequest): number {
  const value = request.providerOptions?.timeoutMs
  return typeof value === 'number' && value > 0 ? value : 30 * 60_000
}
