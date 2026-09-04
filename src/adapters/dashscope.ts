import { MediaError } from '../errors.js'
import { MediaJob, mapJobState } from '../media-job.js'
import { BaseAdapter, artifactsOrThrow, dataUris, extractText, makeModel, payloadOptions } from './base.js'
import { isQwenAudioTts, synthesizeDashScopeTts } from './dashscope-tts.js'
import type { AdapterContext, AdapterResult, Capability, JobStatus, JsonObject, MediaRequest, ModelDescriptor } from '../types.js'
import { requestPublic } from '../url-policy.js'

export class DashScopeAdapter extends BaseAdapter {
  readonly displayName: string
  readonly envKey: string
  override readonly fallbackEnvKeys: readonly string[]

  constructor(readonly id: 'dashscope' | 'qwencloud', private readonly baseUrl: string, dependencies: ConstructorParameters<typeof BaseAdapter>[0]) {
    super(dependencies)
    this.displayName = id === 'dashscope' ? 'Alibaba Cloud Bailian / DashScope' : 'QwenCloud (DashScope international)'
    this.envKey = id === 'qwencloud' ? 'QWENCLOUD_API_KEY' : 'DASHSCOPE_API_KEY'
    this.fallbackEnvKeys = id === 'qwencloud' ? ['DASHSCOPE_API_KEY'] : []
  }

  models(): ModelDescriptor[] {
    const imageCapabilities: Capability[] = ['image.text_to_image', 'image.image_to_image', 'image.edit', 'image.multi_reference']
    const videoCapabilities: Capability[] = ['video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.reference', 'video.edit', 'video.extend', 'video.native_audio']
    return [
      makeModel(this.id, 'alibaba', 'qwen-image-3.0-pro', imageCapabilities, 'Flagship image generation and editing'),
      makeModel(this.id, 'alibaba', 'qwen-image-3.0', imageCapabilities, 'Balanced image generation and editing'),
      makeModel(this.id, 'alibaba', 'qwen-image-edit-plus', ['image.image_to_image', 'image.edit', 'image.multi_reference']),
      makeModel(this.id, 'alibaba', 'wan3.0-video', videoCapabilities, 'Highest-quality Wan 3.0 video generation'),
      makeModel(this.id, 'alibaba', 'wan3.0-video-prime', videoCapabilities, 'Faster Wan 3.0 video generation'),
      makeModel(this.id, 'alibaba', 'wan2.7-videoedit', ['video.edit', 'video.reference', 'video.native_audio']),
      ...(this.id === 'dashscope' ? [makeModel(this.id, 'alibaba', 'fun-music-v1', ['audio.generate'], 'China cn-beijing invite-only')] : []),
      makeModel(this.id, 'alibaba', 'qwen-audio-3.0-tts-plus', ['speech.tts'], 'Highest-quality Qwen Audio TTS over WebSocket'),
      makeModel(this.id, 'alibaba', 'qwen-audio-3.0-tts-flash', ['speech.tts'], 'Low-latency Qwen Audio TTS over WebSocket'),
      makeModel(this.id, 'alibaba', 'qwen3-tts-flash', ['speech.tts']),
      makeModel(this.id, 'alibaba', 'qwen-audio-3.0-asr-flash-filetrans', ['speech.stt']),
    ]
  }

  supports(capability: Capability, model: string): boolean {
    const known = this.models().find(candidate => candidate.id === model)
    if (known) return known.capabilities.includes(capability)
    if (/^qwen-image/i.test(model)) return capability.startsWith('image.')
    if (/^(?:wan|.*videoedit)/i.test(model)) return capability.startsWith('video.')
    if (/music/i.test(model)) return capability === 'audio.generate' && this.id === 'dashscope'
    if (/tts/i.test(model)) return capability === 'speech.tts'
    if (/(?:asr|filetrans|transcri)/i.test(model)) return capability === 'speech.stt'
    return false
  }

  async execute(request: MediaRequest, context: AdapterContext): Promise<AdapterResult> {
    this.assertSupport(request)
    validateDashScopeRequest(request, this.id)
    const key = this.key(request)
    const baseUrl = typeof request.providerOptions?.baseUrl === 'string' ? request.providerOptions.baseUrl.replace(/\/+$/, '') : this.baseUrl
    if (request.capability === 'speech.tts' && isQwenAudioTts(request.model)) {
      const artifact = await synthesizeDashScopeTts({
        provider: this.id,
        baseUrl,
        key,
        model: request.model,
        text: request.text ?? request.prompt ?? '',
        voice: request.voice,
        language: request.language,
        responseFormat: request.responseFormat,
        providerOptions: request.providerOptions,
      }, context)
      return { provider: this.id, model: request.model, capability: request.capability, artifacts: [artifact] }
    }
    const endpoint = this.endpoint(request)
    const payload = await this.payload(request, context.signal)
    const asyncRequest = request.capability.startsWith('video.') || request.capability === 'speech.stt' ||
      (request.capability === 'image.text_to_image' && !/^qwen-image-3/i.test(request.model)) || request.providerOptions?.async === true
    const workspace = typeof request.providerOptions?.workspace === 'string' ? request.providerOptions.workspace : undefined
    const submitted = await this.http.json<Record<string, unknown>>(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(workspace ? { 'X-DashScope-WorkSpace': workspace } : {}), ...(asyncRequest ? { 'X-DashScope-Async': 'enable' } : {}) },
      body: JSON.stringify(payload), signal: context.signal, provider: this.id, secrets: [key], timeoutMs: this.requestTimeout(request),
    })
    const output = (submitted.output && typeof submitted.output === 'object' ? submitted.output : submitted) as Record<string, unknown>
    const taskId = typeof output.task_id === 'string' ? output.task_id : undefined
    if (!taskId) {
      if (request.capability === 'speech.stt') return this.transcriptionResult(request, submitted, '', context.signal)
      return artifactsOrThrow(this.result(request, submitted, this.kind(request), { text: extractText(submitted) }))
    }
    const taskEndpoint = typeof request.providerOptions?.taskEndpoint === 'string'
      ? request.providerOptions.taskEndpoint.replace('{task_id}', encodeURIComponent(taskId))
      : `/api/v1/tasks/${encodeURIComponent(taskId)}`
    let lastState: JobStatus<unknown>['state'] = 'queued'
    const job = new MediaJob<Record<string, unknown>>({
      id: taskId, provider: this.id, signal: context.signal, timeoutMs: this.timeout(request),
      minDelayMs: request.capability.startsWith('video.') ? 15_000 : 1_000,
      maxDelayMs: request.capability.startsWith('video.') ? 15_000 : 8_000,
      onProgress: status => context.onProgress?.(`${this.id} ${taskId}: ${status.state}`),
      poll: async signal => {
        const status = await this.http.json<Record<string, unknown>>(`${baseUrl}${taskEndpoint}`, {
          headers: { Authorization: `Bearer ${key}`, ...(workspace ? { 'X-DashScope-WorkSpace': workspace } : {}) }, signal, provider: this.id, secrets: [key], timeoutMs: 30_000,
        })
        const currentOutput = (status.output && typeof status.output === 'object' ? status.output : status) as Record<string, unknown>
        const state = mapJobState(currentOutput.task_status ?? currentOutput.status)
        lastState = state
        return {
          state,
          ...(state === 'succeeded' ? { result: status } : {}),
          ...(typeof currentOutput.message === 'string' ? { message: currentOutput.message } : {}),
        } satisfies JobStatus<Record<string, unknown>>
      },
      cancel: async signal => {
        if (lastState !== 'queued') return
        await this.http.request(`${baseUrl}${taskEndpoint}/cancel`, {
          method: 'POST', headers: { Authorization: `Bearer ${key}`, ...(workspace ? { 'X-DashScope-WorkSpace': workspace } : {}) }, signal,
          provider: this.id, secrets: [key], timeoutMs: 10_000,
        })
      },
    })
    const completed = await job.wait()
    if (request.capability === 'speech.stt') return this.transcriptionResult(request, completed, taskId, context.signal)
    return artifactsOrThrow(this.result(request, completed, this.kind(request), { jobId: taskId, text: extractText(completed) }))
  }

  private endpoint(request: MediaRequest): string {
    if (typeof request.providerOptions?.endpoint === 'string') return request.providerOptions.endpoint
    if (request.capability.startsWith('video.')) return '/api/v1/services/aigc/video-generation/video-synthesis'
    if (request.capability === 'image.text_to_image' && /^qwen-image-3/i.test(request.model) && request.providerOptions?.async === true) return '/api/v1/services/aigc/image-generation/generation'
    if (request.capability === 'image.text_to_image' && /^qwen-image-3/i.test(request.model)) return '/api/v1/services/aigc/multimodal-generation/generation'
    if (request.capability === 'image.text_to_image') return '/api/v1/services/aigc/text2image/image-synthesis'
    if (request.capability.startsWith('image.')) return '/api/v1/services/aigc/multimodal-generation/generation'
    if (request.capability === 'speech.stt') return '/api/v1/services/audio/asr/transcription'
    if (request.capability === 'audio.generate') return '/api/v1/services/audio/music/generation'
    return '/api/v1/services/aigc/multimodal-generation/generation'
  }

  private async payload(request: MediaRequest, signal?: AbortSignal): Promise<JsonObject> {
    if (request.capability === 'speech.stt' && request.inputAudio && !/^https?:\/\//i.test(request.inputAudio)) {
      throw new MediaError('INPUT', 'DashScope/Qwen file transcription requires an HTTP(S) audio URL', { provider: this.id })
    }
    const inputImage = request.inputImage ? await this.input.asDataUri(request.inputImage, signal) : undefined
    const endImage = request.endImage ? await this.input.asDataUri(request.endImage, signal) : undefined
    const inputVideo = request.inputVideo ? await this.input.asDataUri(request.inputVideo, signal) : undefined
    const inputAudio = request.inputAudio ? await this.input.asDataUri(request.inputAudio, signal) : undefined
    const referenceImages = await dataUris(this.input, request.referenceImages, signal)
    const referenceVideos = await dataUris(this.input, request.referenceVideos, signal)
    const referenceAudios = await dataUris(this.input, request.referenceAudios, signal)
    const resolution = normalizeResolution(request.resolution ?? (request.capability.startsWith('image.') ? imageSizeForRatio(request.aspectRatio) : undefined), request.capability)
    const native = payloadOptions(request.providerOptions)
    const nativeParameters = isJsonObject(native.parameters) ? native.parameters : {}
    const nativeInput = isJsonObject(native.input) ? native.input : {}
    const musicFields = new Set(['gender', 'is_instrumental', 'format', 'enable_aigc_watermark'])
    const musicInput = request.capability === 'audio.generate'
      ? Object.fromEntries(Object.entries(native).filter(([key]) => musicFields.has(key)))
      : {}
    const passthrough = Object.fromEntries(Object.entries(native).filter(([key]) => key !== 'input' && key !== 'parameters' && !musicFields.has(key)))
    const parameters: JsonObject = {
      ...passthrough,
      ...nativeParameters,
      ...(resolution ? request.capability.startsWith('video.') ? { resolution } : { size: resolution } : {}),
      ...(request.aspectRatio && request.capability.startsWith('video.') ? { ratio: request.aspectRatio } : {}),
      ...(request.duration ? { duration: request.duration } : {}),
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
      ...(request.count ? { n: request.count } : {}),
      ...(request.generateAudio !== undefined ? { audio: request.generateAudio } : {}),
      ...(request.language && request.capability === 'speech.stt' ? { language_hints: [request.language] } : {}),
    }
    let input: JsonObject
    if (request.capability.startsWith('image.') && (request.capability !== 'image.text_to_image' || /^qwen-image-3/i.test(request.model))) {
      input = { ...nativeInput, messages: [{ role: 'user', content: [
        ...[inputImage, ...referenceImages].filter(Boolean).map(image => ({ image })),
        { text: request.prompt ?? '' },
      ] }] }
    } else if (request.capability === 'audio.generate') {
      input = { ...nativeInput, ...musicInput, prompt: request.prompt ?? '', ...(request.text ? { lyrics: request.text } : {}), ...(request.outputFormat ? { format: request.outputFormat } : {}) }
    } else if (request.capability === 'speech.tts') {
      input = { ...nativeInput, text: request.text ?? request.prompt ?? '', ...(request.voice ? { voice: request.voice } : {}), ...(request.language ? { language: request.language } : {}) }
    } else if (request.capability === 'speech.stt') {
      input = { ...nativeInput, file_urls: inputAudio ? [inputAudio] : [] }
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
      input = { ...nativeInput, ...(request.prompt ? { prompt: request.prompt } : {}), ...(media.length ? { media } : {}) }
    } else {
      input = { ...nativeInput, ...(request.prompt ? { prompt: request.prompt } : {}) }
    }
    return { model: request.model, input, parameters }
  }

  private kind(request: MediaRequest): 'image' | 'video' | 'audio' | 'text' {
    return request.capability.startsWith('image.') ? 'image' : request.capability.startsWith('video.') ? 'video' : request.capability === 'speech.stt' ? 'text' : 'audio'
  }

  private async transcriptionResult(request: MediaRequest, completed: Record<string, unknown>, jobId: string, signal?: AbortSignal): Promise<AdapterResult> {
    const transcriptionUrl = findStringByKey(completed, 'transcription_url')
    const payload = transcriptionUrl
      ? await this.http.jsonResponse<unknown>(
          await requestPublic(this.http, transcriptionUrl, { signal, provider: this.id, timeoutMs: 60_000, retries: 1 }),
          { signal, provider: this.id, timeoutMs: 60_000 },
        )
      : completed
    const text = extractText(payload)
    if (!text) throw new MediaError('PROVIDER', `DashScope transcription job ${jobId || '(synchronous)'} completed without transcript text`, { provider: this.id })
    return this.result(request, {}, 'text', { jobId, text })
  }

  private timeout(request: MediaRequest): number {
    const value = request.providerOptions?.timeoutMs
    return typeof value === 'number' && value > 0 ? value : 30 * 60_000
  }

  private requestTimeout(request: MediaRequest): number {
    const value = request.providerOptions?.requestTimeoutMs ?? request.providerOptions?.timeoutMs
    return typeof value === 'number' && value > 0 ? value : 3 * 60_000
  }
}

function validateDashScopeRequest(request: MediaRequest, provider: string): void {
  if (request.mask) throw new MediaError('CAPABILITY_UNSUPPORTED', 'DashScope/Qwen image editing does not expose mask input', { provider })
  if (request.capability.startsWith('image.')) {
    const inputs = (request.inputImage ? 1 : 0) + (request.referenceImages?.length ?? 0)
    if (inputs > 3) throw new MediaError('INPUT', 'Qwen Image supports at most 3 input images', { provider })
    if ((request.count ?? 1) > 6) throw new MediaError('INPUT', 'Qwen Image supports at most 6 outputs', { provider })
    if (request.background || request.quality || request.compression !== undefined || (request.outputFormat && request.outputFormat.toLowerCase() !== 'png')) {
      throw new MediaError('CAPABILITY_UNSUPPORTED', 'Qwen Image output is fixed to PNG and does not expose background/quality/compression controls', { provider })
    }
  }
  if (request.capability.startsWith('video.')) {
    const urlOnly = [request.inputVideo, ...(request.referenceVideos ?? []), ...(request.referenceAudios ?? [])].filter((value): value is string => Boolean(value))
    if (urlOnly.some(value => !/^https?:\/\//i.test(value))) {
      throw new MediaError('INPUT', 'Wan video and audio inputs must be HTTP(S) or supported OSS URLs; data URIs and local paths are not accepted', { provider })
    }
    if ((request.referenceImages?.length ?? 0) > 10) throw new MediaError('INPUT', 'Wan 3 supports at most 10 reference images', { provider })
    if ((request.referenceVideos?.length ?? 0) > 5) throw new MediaError('INPUT', 'Wan 3 supports at most 5 reference videos', { provider })
    if ((request.referenceAudios?.length ?? 0) > 5) throw new MediaError('INPUT', 'Wan 3 supports at most 5 reference audios', { provider })
    const total = (request.inputImage ? 1 : 0) + (request.endImage ? 1 : 0) + (request.referenceImages?.length ?? 0) +
      (request.inputVideo ? 1 : 0) + (request.referenceVideos?.length ?? 0) + (request.referenceAudios?.length ?? 0)
    if (total > 20) throw new MediaError('INPUT', 'Wan 3 supports at most 20 total reference media items', { provider })
    if (request.aspectRatio && !['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16'].includes(request.aspectRatio)) {
      throw new MediaError('INPUT', 'Unsupported Wan 3 aspect ratio', { provider })
    }
    if (request.duration !== undefined && (request.duration !== -1 && (!Number.isInteger(request.duration) || request.duration < 2 || request.duration > 30))) {
      throw new MediaError('INPUT', 'Wan 3 duration must be -1 or an integer from 2 to 30 seconds', { provider })
    }
  }
  if (request.capability === 'audio.generate') {
    const prompt = request.prompt ?? ''
    const lyrics = request.text ?? ''
    if (!prompt && !lyrics) throw new MediaError('INPUT', 'Fun-Music requires prompt or lyrics', { provider })
    if (prompt.length > 2_000) throw new MediaError('INPUT', 'Fun-Music prompt must not exceed 2000 characters', { provider })
    if (lyrics && (lyrics.length < 5 || lyrics.length > 2_000)) throw new MediaError('INPUT', 'Fun-Music lyrics must be 5 to 2000 characters', { provider })
    if (request.outputFormat && !['mp3', 'wav'].includes(request.outputFormat.toLowerCase())) throw new MediaError('INPUT', 'Fun-Music outputFormat must be mp3 or wav', { provider })
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function findStringByKey(value: unknown, wanted: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  if (!Array.isArray(value)) {
    const candidate = (value as Record<string, unknown>)[wanted]
    if (typeof candidate === 'string') return candidate
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findStringByKey(child, wanted)
    if (found) return found
  }
  return undefined
}

function imageSizeForRatio(ratio: string | undefined): string | undefined {
  const sizes: Record<string, string> = {
    '1:1': '1328*1328', '16:9': '1664*928', '9:16': '928*1664', '4:3': '1472*1140',
    '3:4': '1140*1472', '3:2': '1584*1056', '2:3': '1056*1584', '21:9': '2080*880',
  }
  return ratio ? sizes[ratio] : undefined
}

function normalizeResolution(value: string | undefined, capability: Capability): string | undefined {
  if (!value || !capability.startsWith('video.')) return value
  return /^(?:480|720|1080)p$/i.test(value) ? value.toUpperCase() : value
}
