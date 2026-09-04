import { MediaError } from '../errors.js'
import { MediaJob, mapJobState } from '../media-job.js'
import { BaseAdapter, artifactsOrThrow, bearerHeaders, dataUris, makeModel, mergeOptions, requirePrompt } from './base.js'
import type { AdapterContext, AdapterResult, Capability, JobStatus, JsonObject, MediaRequest, ModelDescriptor, RemoteArtifact } from '../types.js'

const IMAGE_CAPS: Capability[] = ['image.text_to_image', 'image.image_to_image', 'image.edit', 'image.multi_reference']
const VIDEO_CAPS: Capability[] = ['video.text_to_video', 'video.image_to_video', 'video.reference', 'video.native_audio']

export class OpenRouterAdapter extends BaseAdapter {
  readonly id = 'openrouter'
  readonly displayName = 'OpenRouter'
  readonly envKey = 'OPENROUTER_API_KEY'
  private readonly baseUrl = 'https://openrouter.ai/api/v1'

  models(): ModelDescriptor[] {
    return [
      makeModel(this.id, 'multi-vendor', '<OpenRouter image model>', IMAGE_CAPS, 'Use /images/models endpoint externally to choose a current image model'),
      makeModel(this.id, 'multi-vendor', '<OpenRouter video model>', VIDEO_CAPS, 'Availability and parameters vary by upstream endpoint'),
      makeModel(this.id, 'multi-vendor', '<OpenRouter TTS model>', ['speech.tts']),
    ]
  }

  supports(capability: Capability): boolean {
    return IMAGE_CAPS.includes(capability) || VIDEO_CAPS.includes(capability) || capability === 'speech.tts'
  }

  async execute(request: MediaRequest, context: AdapterContext): Promise<AdapterResult> {
    this.assertSupport(request)
    if (request.capability.startsWith('image.')) return this.image(request, context)
    if (request.capability.startsWith('video.')) return this.video(request, context)
    return this.tts(request, context)
  }

  private async image(request: MediaRequest, context: AdapterContext): Promise<AdapterResult> {
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
      ...(request.resolution ? { resolution: request.resolution } : {}),
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
    }, request.providerOptions)
    const data = await this.http.json<unknown>(`${this.baseUrl}/images`, {
      method: 'POST', headers: bearerHeaders(key, { 'Content-Type': 'application/json' }), body: JSON.stringify(payload),
      signal: context.signal, provider: this.id, secrets: [key], timeoutMs: 180_000,
    })
    return artifactsOrThrow(this.result(request, data, 'image'))
  }

  private async tts(request: MediaRequest, context: AdapterContext): Promise<AdapterResult> {
    const key = this.key(request)
    const format = request.responseFormat ?? 'mp3'
    const payload = mergeOptions({
      model: request.model, input: request.text ?? request.prompt ?? '', voice: request.voice ?? 'alloy', response_format: format,
    }, request.providerOptions)
    const response = await this.http.request(`${this.baseUrl}/audio/speech`, {
      method: 'POST', headers: bearerHeaders(key, { 'Content-Type': 'application/json' }), body: JSON.stringify(payload),
      signal: context.signal, provider: this.id, secrets: [key], timeoutMs: 180_000,
    })
    const base64 = Buffer.from(await response.arrayBuffer()).toString('base64')
    return this.result(request, { b64_json: base64, mime_type: response.headers.get('content-type') ?? `audio/${format}` }, 'audio')
  }

  private async video(request: MediaRequest, context: AdapterContext): Promise<AdapterResult> {
    const key = this.key(request)
    const refs = [request.inputImage, ...(request.referenceImages ?? [])].filter((value): value is string => Boolean(value))
    const inputReferences = await dataUris(this.input, refs, context.signal)
    const payload: JsonObject = mergeOptions({
      model: request.model,
      prompt: requirePrompt(request),
      ...(inputReferences.length ? { input_references: inputReferences } : {}),
      ...(request.duration ? { duration: request.duration } : {}),
      ...(request.resolution ? { resolution: request.resolution } : {}),
      ...(request.aspectRatio ? { aspect_ratio: request.aspectRatio } : {}),
      ...(request.generateAudio !== undefined ? { generate_audio: request.generateAudio } : {}),
    }, request.providerOptions)
    const submitted = await this.http.json<Record<string, unknown>>(`${this.baseUrl}/videos`, {
      method: 'POST', headers: bearerHeaders(key, { 'Content-Type': 'application/json' }), body: JSON.stringify(payload),
      signal: context.signal, provider: this.id, secrets: [key], timeoutMs: 60_000,
    })
    const jobId = typeof submitted.id === 'string' ? submitted.id : typeof submitted.job_id === 'string' ? submitted.job_id : undefined
    if (!jobId) return artifactsOrThrow(this.result(request, submitted, 'video'))
    const job = new MediaJob<Record<string, unknown>>({
      id: jobId, provider: this.id, signal: context.signal, timeoutMs: timeout(request), minDelayMs: 5_000, maxDelayMs: 30_000,
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
    if (result.artifacts.length === 0) {
      const artifact: RemoteArtifact = { kind: 'video', url: `${this.baseUrl}/videos/${encodeURIComponent(jobId)}/content`, headers: bearerHeaders(key) }
      result.artifacts.push(artifact)
    }
    return result
  }
}

function timeout(request: MediaRequest): number {
  const value = request.providerOptions?.timeoutMs
  return typeof value === 'number' && value > 0 ? value : 40 * 60_000
}
