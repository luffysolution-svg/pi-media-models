import { MediaJob, mapJobState } from '../media-job.js'
import { BaseAdapter, artifactsOrThrow, dataUris, makeModel } from './base.js'
import type { AdapterContext, AdapterResult, Capability, JobStatus, JsonObject, MediaRequest, ModelDescriptor } from '../types.js'

function withoutControlOptions(options: JsonObject | undefined): JsonObject {
  if (!options) return {}
  const { endpoint: _endpoint, taskEndpoint: _taskEndpoint, timeoutMs: _timeoutMs, baseUrl: _baseUrl, async: _async, ...payload } = options
  return payload
}

export class DashScopeAdapter extends BaseAdapter {
  readonly displayName: string
  readonly envKey = 'DASHSCOPE_API_KEY'

  constructor(readonly id: 'dashscope' | 'qwencloud', private readonly baseUrl: string, dependencies: ConstructorParameters<typeof BaseAdapter>[0]) {
    super(dependencies)
    this.displayName = id === 'dashscope' ? 'Alibaba Cloud Bailian / DashScope' : 'QwenCloud (DashScope international)'
  }

  models(): ModelDescriptor[] {
    return [
      makeModel(this.id, 'alibaba', 'qwen-image-3.0-pro', ['image.text_to_image']),
      makeModel(this.id, 'alibaba', 'qwen-image-edit-plus', ['image.image_to_image', 'image.edit', 'image.multi_reference']),
      makeModel(this.id, 'alibaba', 'wan3.0-video', ['video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.reference', 'video.edit', 'video.extend', 'video.native_audio']),
      makeModel(this.id, 'alibaba', 'wan2.7-videoedit', ['video.edit', 'video.reference', 'video.native_audio']),
      makeModel(this.id, 'alibaba', 'fun-music-v1', ['audio.generate']),
      makeModel(this.id, 'alibaba', 'qwen3-tts-flash', ['speech.tts']),
      makeModel(this.id, 'alibaba', 'qwen-audio-3.0-asr-flash-filetrans', ['speech.stt']),
    ]
  }

  supports(_capability: Capability): boolean { return true }

  async execute(request: MediaRequest, context: AdapterContext): Promise<AdapterResult> {
    this.assertSupport(request)
    const key = this.key(request)
    const endpoint = this.endpoint(request)
    const baseUrl = typeof request.providerOptions?.baseUrl === 'string' ? request.providerOptions.baseUrl.replace(/\/+$/, '') : this.baseUrl
    const payload = await this.payload(request, context.signal)
    const asyncRequest = request.capability.startsWith('video.') || request.capability === 'speech.stt' ||
      (request.capability === 'image.text_to_image' && !/^qwen-image-3/i.test(request.model)) || request.providerOptions?.async === true
    const submitted = await this.http.json<Record<string, unknown>>(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(asyncRequest ? { 'X-DashScope-Async': 'enable' } : {}) },
      body: JSON.stringify(payload), signal: context.signal, provider: this.id, secrets: [key], timeoutMs: 60_000,
    })
    const output = (submitted.output && typeof submitted.output === 'object' ? submitted.output : submitted) as Record<string, unknown>
    const taskId = typeof output.task_id === 'string' ? output.task_id : undefined
    if (!taskId) return artifactsOrThrow(this.result(request, submitted, this.kind(request), { text: this.text(submitted) }))
    const taskEndpoint = typeof request.providerOptions?.taskEndpoint === 'string'
      ? request.providerOptions.taskEndpoint.replace('{task_id}', encodeURIComponent(taskId))
      : `/api/v1/tasks/${encodeURIComponent(taskId)}`
    const job = new MediaJob<Record<string, unknown>>({
      id: taskId, provider: this.id, signal: context.signal, timeoutMs: this.timeout(request), minDelayMs: 1_000, maxDelayMs: 8_000,
      onProgress: status => context.onProgress?.(`${this.id} ${taskId}: ${status.state}`),
      poll: async signal => {
        const status = await this.http.json<Record<string, unknown>>(`${baseUrl}${taskEndpoint}`, {
          headers: { Authorization: `Bearer ${key}` }, signal, provider: this.id, secrets: [key], timeoutMs: 30_000,
        })
        const currentOutput = (status.output && typeof status.output === 'object' ? status.output : status) as Record<string, unknown>
        const state = mapJobState(currentOutput.task_status ?? currentOutput.status)
        return {
          state,
          ...(state === 'succeeded' ? { result: status } : {}),
          ...(typeof currentOutput.message === 'string' ? { message: currentOutput.message } : {}),
        } satisfies JobStatus<Record<string, unknown>>
      },
      cancel: async signal => {
        await this.http.request(`${baseUrl}${taskEndpoint}/cancel`, {
          method: 'POST', headers: { Authorization: `Bearer ${key}` }, signal,
          provider: this.id, secrets: [key], timeoutMs: 10_000,
        })
      },
    })
    const completed = await job.wait()
    return artifactsOrThrow(this.result(request, completed, this.kind(request), { jobId: taskId, text: this.text(completed) }))
  }

  private endpoint(request: MediaRequest): string {
    if (typeof request.providerOptions?.endpoint === 'string') return request.providerOptions.endpoint
    if (request.capability.startsWith('video.')) return '/api/v1/services/aigc/video-generation/video-synthesis'
    if (request.capability === 'image.text_to_image' && /^qwen-image-3/i.test(request.model)) return '/api/v1/services/aigc/multimodal-generation/generation'
    if (request.capability === 'image.text_to_image') return '/api/v1/services/aigc/text2image/image-synthesis'
    if (request.capability.startsWith('image.')) return '/api/v1/services/aigc/multimodal-generation/generation'
    if (request.capability === 'speech.stt') return '/api/v1/services/audio/asr/transcription'
    if (request.capability === 'audio.generate') return '/api/v1/services/audio/music/generation'
    return '/api/v1/services/aigc/multimodal-generation/generation'
  }

  private async payload(request: MediaRequest, signal?: AbortSignal): Promise<JsonObject> {
    const inputImage = request.inputImage ? await this.input.asDataUri(request.inputImage, signal) : undefined
    const endImage = request.endImage ? await this.input.asDataUri(request.endImage, signal) : undefined
    const inputVideo = request.inputVideo ? await this.input.asDataUri(request.inputVideo, signal) : undefined
    const inputAudio = request.inputAudio ? await this.input.asDataUri(request.inputAudio, signal) : undefined
    const referenceImages = await dataUris(this.input, request.referenceImages, signal)
    const referenceVideos = await dataUris(this.input, request.referenceVideos, signal)
    const referenceAudios = await dataUris(this.input, request.referenceAudios, signal)
    const parameters: JsonObject = {
      ...(request.resolution ? { resolution: request.resolution, size: request.resolution } : {}),
      ...(request.aspectRatio ? { ratio: request.aspectRatio, aspect_ratio: request.aspectRatio } : {}),
      ...(request.duration ? { duration: request.duration } : {}),
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
      ...(request.count ? { n: request.count } : {}),
      ...(request.generateAudio !== undefined ? { audio: request.generateAudio } : {}),
    }
    let input: JsonObject
    if (request.capability.startsWith('image.') && (request.capability !== 'image.text_to_image' || /^qwen-image-3/i.test(request.model))) {
      input = { messages: [{ role: 'user', content: [
        ...[inputImage, ...referenceImages].filter(Boolean).map(image => ({ image })),
        { text: request.prompt ?? '' },
      ] }] }
    } else if (request.capability === 'audio.generate') {
      input = { prompt: request.prompt ?? '', ...(request.text ? { lyrics: request.text } : {}) }
    } else if (request.capability === 'speech.tts') {
      input = { text: request.text ?? request.prompt ?? '', voice: request.voice, language: request.language }
    } else if (request.capability === 'speech.stt') {
      input = { file_urls: inputAudio ? [inputAudio] : [], language_hints: request.language ? [request.language] : undefined }
    } else if (request.capability.startsWith('video.')) {
      const media = [
        ...(inputImage ? [{ type: 'first_frame', url: inputImage }] : []),
        ...(endImage ? [{ type: 'last_frame', url: endImage }] : []),
        ...referenceImages.map(url => ({ type: 'reference_image', url })),
        ...(inputVideo ? [{ type: 'reference_video', url: inputVideo }] : []),
        ...referenceVideos.map(url => ({ type: 'reference_video', url })),
        ...(inputAudio ? [{ type: 'reference_audio', url: inputAudio }] : []),
        ...referenceAudios.map(url => ({ type: 'reference_audio', url })),
      ]
      input = { ...(request.prompt ? { prompt: request.prompt } : {}), ...(media.length ? { media } : {}) }
    } else {
      input = { ...(request.prompt ? { prompt: request.prompt } : {}) }
    }
    return { model: request.model, input, parameters, ...withoutControlOptions(request.providerOptions) }
  }

  private kind(request: MediaRequest): 'image' | 'video' | 'audio' | 'text' {
    return request.capability.startsWith('image.') ? 'image' : request.capability.startsWith('video.') ? 'video' : request.capability === 'speech.stt' ? 'text' : 'audio'
  }

  private text(payload: unknown): string | undefined {
    if (!payload || typeof payload !== 'object') return undefined
    const output = (payload as Record<string, unknown>).output
    if (!output || typeof output !== 'object') return undefined
    const text = (output as Record<string, unknown>).text
    return typeof text === 'string' ? text : undefined
  }

  private timeout(request: MediaRequest): number {
    const value = request.providerOptions?.timeoutMs
    return typeof value === 'number' && value > 0 ? value : 30 * 60_000
  }
}
