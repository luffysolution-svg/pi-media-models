import { GoogleAuth } from 'google-auth-library'
import { fileURLToPath } from 'node:url'
import { MediaError } from '../errors.js'
import { MediaJob } from '../media-job.js'
import { BaseAdapter, artifactsOrThrow, makeModel } from './base.js'
import { expandHomePath } from '../config.js'
import type { AdapterContext, AdapterResult, Capability, JobStatus, JsonObject, MediaRequest, ModelDescriptor } from '../types.js'
import type { AdapterDependencies } from './base.js'

const GOOGLE_CAPS: Capability[] = [
  'image.text_to_image', 'image.image_to_image', 'image.edit', 'image.multi_reference',
  'video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.reference',
  'video.extend', 'video.native_audio', 'audio.generate', 'speech.tts', 'speech.stt',
]

export class GoogleMediaAdapter extends BaseAdapter {
  readonly displayName: string
  readonly envKey: string | undefined

  constructor(readonly id: 'gemini' | 'vertex', dependencies: AdapterDependencies) {
    super(dependencies)
    this.displayName = id === 'gemini' ? 'Google Gemini API' : 'Google Vertex AI (ADC)'
    this.envKey = id === 'gemini' ? 'GEMINI_API_KEY' : undefined
  }

  models(): ModelDescriptor[] {
    return [
      makeModel(this.id, 'google', 'gemini-2.5-flash-image', ['image.text_to_image', 'image.image_to_image', 'image.edit', 'image.multi_reference']),
      makeModel(this.id, 'google', 'imagen-4.0-generate-001', ['image.text_to_image']),
      makeModel(this.id, 'google', 'veo-3.1-generate-preview', ['video.text_to_video', 'video.image_to_video', 'video.first_last_frame', 'video.reference', 'video.extend', 'video.native_audio']),
      makeModel(this.id, 'google', 'gemini-2.5-flash-preview-tts', ['speech.tts']),
      makeModel(this.id, 'google', 'gemini-2.5-flash', ['speech.stt']),
      makeModel(this.id, 'google', 'lyria-3.5', ['audio.generate']),
    ]
  }

  supports(capability: Capability): boolean { return GOOGLE_CAPS.includes(capability) }

  async execute(request: MediaRequest, context: AdapterContext): Promise<AdapterResult> {
    this.assertSupport(request)
    if (request.capability.startsWith('video.')) return this.longRunning(request, context)
    if (request.capability === 'audio.generate' || (request.capability === 'image.text_to_image' && /^imagen-/i.test(request.model))) {
      return this.predictMedia(request, context)
    }
    return this.generateContent(request, context)
  }

  private async generateContent(request: MediaRequest, context: AdapterContext): Promise<AdapterResult> {
    const parts: JsonObject[] = []
    if (request.prompt || request.text) parts.push({ text: request.text ?? request.prompt })
    const sources = [request.inputImage, ...(request.referenceImages ?? []), request.inputAudio]
      .filter((value): value is string => Boolean(value))
    for (const source of sources) parts.push({ inlineData: await this.input.asInlineData(source, context.signal) })
    if (request.capability === 'speech.stt' && !request.prompt) parts.unshift({ text: 'Transcribe this audio accurately. Return only the transcript.' })
    const generationConfig: JsonObject = request.capability === 'speech.tts'
      ? {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: request.voice ?? 'Kore' } } },
        }
      : request.capability.startsWith('image.')
        ? {
            responseModalities: ['TEXT', 'IMAGE'],
            ...(request.aspectRatio || request.resolution ? { imageConfig: {
              ...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}),
              ...(request.resolution ? { imageSize: request.resolution } : {}),
            } } : {}),
          }
        : { responseModalities: ['TEXT'] }
    const body = { contents: [{ role: 'user', parts }], generationConfig, ...googleNativeOptions(request.providerOptions) }
    const { url, headers } = await this.modelRequest(request, "generateContent")
    const payload = await this.http.json<Record<string, unknown>>(url, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: context.signal, provider: this.id, secrets: this.secrets(request), timeoutMs: 180_000,
    })
    const kind = request.capability.startsWith('image.') ? 'image' : request.capability === 'speech.tts' ? 'audio' : 'text'
    const text = findText(payload)
    const result = this.result(request, payload, kind, { ...(text ? { text } : {}), ...(this.id === 'gemini' ? { headers } : {}) })
    return request.capability === 'speech.stt' ? result : artifactsOrThrow(result)
  }

  private async predictMedia(request: MediaRequest, context: AdapterContext): Promise<AdapterResult> {
    const kind = request.capability === 'audio.generate' ? 'audio' : 'image'
    const body = request.capability === 'audio.generate'
      ? { instances: [{ prompt: request.prompt ?? request.text ?? '' }], parameters: googleNativeOptions(request.providerOptions) }
      : { instances: [{ prompt: request.prompt ?? '' }], parameters: {
          sampleCount: request.count ?? 1,
          ...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}),
          ...(request.resolution ? { sampleImageSize: request.resolution } : {}),
          ...(request.seed !== undefined ? { seed: request.seed } : {}),
          ...googleNativeOptions(request.providerOptions),
        } }
    const { url, headers } = await this.modelRequest(request, "predict")
    const payload = await this.http.json<Record<string, unknown>>(url, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: context.signal, provider: this.id, secrets: this.secrets(request), timeoutMs: 180_000,
    })
    return artifactsOrThrow(this.result(request, payload, kind, { headers }))
  }

  private async longRunning(request: MediaRequest, context: AdapterContext): Promise<AdapterResult> {
    const instance: JsonObject = { ...(request.prompt ? { prompt: request.prompt } : {}) }
    if (request.inputImage) instance.image = await this.googleMedia(request.inputImage, context.signal)
    if (request.endImage) instance.lastFrame = await this.googleMedia(request.endImage, context.signal)
    if (request.inputVideo) instance.video = await this.googleMedia(request.inputVideo, context.signal)
    if (request.referenceImages?.length) {
      instance.referenceImages = await Promise.all(request.referenceImages.map(async source => ({
        image: await this.googleMedia(source, context.signal), referenceType: 'asset',
      })))
    }
    const parameters: JsonObject = {
      ...(request.aspectRatio ? { aspectRatio: request.aspectRatio } : {}),
      ...(request.resolution ? { resolution: request.resolution } : {}),
      ...(request.duration ? { durationSeconds: request.duration } : {}),
      ...(request.seed !== undefined ? { seed: request.seed } : {}),
      ...(request.generateAudio !== undefined ? { generateAudio: request.generateAudio } : {}),
      ...(request.count ? { sampleCount: request.count } : {}),
    }
    const body = { instances: [instance], parameters: { ...parameters, ...googleNativeOptions(request.providerOptions) } }
    const { url, headers, operationsBase } = await this.modelRequest(request, "predictLongRunning")
    const submitted = await this.http.json<Record<string, unknown>>(url, {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: context.signal, provider: this.id, secrets: this.secrets(request), timeoutMs: 60_000,
    })
    const name = typeof submitted.name === 'string' ? submitted.name : undefined
    if (!name) return artifactsOrThrow(this.result(request, submitted, request.capability === 'audio.generate' ? 'audio' : 'video', { headers }))
    const operationUrl = `${operationsBase}/${name.replace(/^\/+/, '')}`
    const vertexPollUrl = url.replace(/:predictLongRunning$/, ':fetchPredictOperation')
    const job = new MediaJob<Record<string, unknown>>({
      id: name, provider: this.id, signal: context.signal, timeoutMs: timeout(request), minDelayMs: 5_000, maxDelayMs: 15_000,
      onProgress: () => context.onProgress?.(`${this.id} operation ${name}: running`),
      poll: async signal => {
        const status = this.id === 'vertex'
          ? await this.http.json<Record<string, unknown>>(vertexPollUrl, {
              method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
              body: JSON.stringify({ operationName: name }), signal, provider: this.id, secrets: this.secrets(request), timeoutMs: 30_000,
            })
          : await this.http.json<Record<string, unknown>>(operationUrl, {
              headers, signal, provider: this.id, secrets: this.secrets(request), timeoutMs: 30_000,
            })
        if (status.error) return { state: 'failed', message: JSON.stringify(status.error) }
        return status.done === true
          ? { state: 'succeeded', result: status }
          : { state: 'running' }
      },
    })
    const completed = await job.wait()
    return artifactsOrThrow(this.result(request, completed, request.capability === 'audio.generate' ? 'audio' : 'video', { jobId: name, headers }))
  }

  private async googleMedia(source: string, signal?: AbortSignal): Promise<JsonObject> {
    const resolved = await this.input.resolve(source)
    if (resolved.kind === 'url') return { uri: resolved.url, mimeType: resolved.mimeType }
    const inline = await this.input.asInlineData(source, signal)
    return this.id === 'gemini'
      ? { inlineData: { data: inline.data, mimeType: inline.mimeType } }
      : { bytesBase64Encoded: inline.data, mimeType: inline.mimeType }
  }

  private async modelRequest(request: MediaRequest, method: string): Promise<{ url: string; headers: Record<string, string>; operationsBase: string }> {
    if (this.id === 'gemini') {
      const key = this.key(request)
      const base = 'https://generativelanguage.googleapis.com/v1beta'
      return { url: `${base}/models/${encodeURIComponent(request.model)}:${method}`, headers: { 'x-goog-api-key': key }, operationsBase: base }
    }
    const options = request.providerOptions;
    const configuredFile = typeof options?.credentialsFile === "string" ? options.credentialsFile : undefined
    const rawKeyFilename = configuredFile ?? this.env.VERTEX_CREDENTIALS_FILE ?? this.env.GOOGLE_APPLICATION_CREDENTIALS
    const expandedKeyFile = expandHomePath(rawKeyFilename)
    const keyFilename = expandedKeyFile?.startsWith('file://') ? fileURLToPath(expandedKeyFile) : expandedKeyFile
    const auth = new GoogleAuth({
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      ...(keyFilename ? { keyFilename } : {}),
    })
    const configuredProject = typeof options?.project === 'string' ? options.project : undefined
    const project = configuredProject ?? this.env.GOOGLE_CLOUD_PROJECT ?? this.env.GCLOUD_PROJECT ?? await auth.getProjectId()
    const configuredLocation = typeof options?.location === 'string' ? options.location : undefined
    const location = configuredLocation ?? this.env.GOOGLE_CLOUD_LOCATION ?? 'us-central1'
    if (!project) throw new MediaError('CONFIG', 'Vertex AI requires a project id from providerOptions.vertex.project, environment, ADC, or the credentials JSON', { provider: this.id })
    const base = `https://${location}-aiplatform.googleapis.com/v1`
    const resource = `projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(request.model)}`
    const authHeaders = await auth.getRequestHeaders(`${base}/${resource}:${method}`)
    const headers: Record<string, string> = {}
    for (const [key, value] of authHeaders.entries()) headers[key] = value
    return { url: `${base}/${resource}:${method}`, headers, operationsBase: base }
  }

  private secrets(request: MediaRequest): string[] {
    const configKey = typeof request.providerOptions?.apiKey === 'string' ? request.providerOptions.apiKey : undefined
    const envKey = this.envKey && this.env[this.envKey] ? this.env[this.envKey] as string : undefined
    return [configKey, envKey].filter((val): val is string => Boolean(val))
  }
}

function findText(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const candidates = (payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }).candidates
  const values = candidates?.flatMap(candidate => candidate.content?.parts?.map(part => part.text).filter((text): text is string => Boolean(text)) ?? []) ?? []
  return values.length ? values.join('\n') : undefined
}

function googleNativeOptions(options?: JsonObject): JsonObject {
  if (!options) return {}
  const {
    credentialsFile: _credentialsFile,
    project: _project,
    location: _location,
    timeoutMs: _timeoutMs,
    ...native
  } = options
  return native
}

function timeout(request: MediaRequest): number {
  const value = request.providerOptions?.timeoutMs
  return typeof value === 'number' && value > 0 ? value : 40 * 60_000
}
