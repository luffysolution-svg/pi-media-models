import { BaseAdapter, artifactsOrThrow, bearerHeaders, makeModel, mergeOptions, requirePrompt } from './base.js'
import type { AdapterContext, AdapterResult, Capability, MediaRequest, ModelDescriptor, ModelDiscoveryContext } from '../types.js'

const IMAGE_CAPS: Capability[] = ['image.text_to_image', 'image.image_to_image', 'image.edit', 'image.multi_reference']
const SPEECH_CAPS: Capability[] = ['speech.tts', 'speech.stt']

export class OpenAIAdapter extends BaseAdapter {
  readonly id = 'openai'
  readonly displayName = 'OpenAI API'
  readonly envKey = 'OPENAI_API_KEY'
  private readonly baseUrl = 'https://api.openai.com/v1'

  models(): ModelDescriptor[] {
    return [
      makeModel(this.id, 'openai', 'gpt-image-2', IMAGE_CAPS),
      makeModel(this.id, 'openai', 'gpt-image-1.5', IMAGE_CAPS),
      makeModel(this.id, 'openai', 'dall-e-3', ['image.text_to_image']),
      makeModel(this.id, 'openai', 'gpt-4o-mini-tts', ['speech.tts']),
      makeModel(this.id, 'openai', 'gpt-4o-transcribe', ['speech.stt']),
      makeModel(this.id, 'openai', 'whisper-1', ['speech.stt']),
    ]
  }

  async discoverModels(context: ModelDiscoveryContext): Promise<ModelDescriptor[]> {
    const key = this.keyFromOptions(context.providerOptions)
    const payload = await this.http.json<{ data?: Array<{ id?: string }> }>(`${this.baseUrl}/models`, {
      headers: bearerHeaders(key), signal: context.signal, provider: this.id, secrets: [key], timeoutMs: 30_000,
    })
    return (payload.data ?? []).flatMap(entry => {
      if (!entry.id) return []
      const capabilities = [...IMAGE_CAPS, ...SPEECH_CAPS].filter(capability => this.supports(capability, entry.id as string))
      return capabilities.length ? [makeModel(this.id, 'openai', entry.id, capabilities)] : []
    })
  }

  supports(capability: Capability, model: string): boolean {
    if (capability.startsWith('video.') || capability === 'audio.generate') return false
    if (capability.startsWith('image.')) return /(?:gpt-image|dall-e)/i.test(model)
    if (capability === 'speech.tts') return /tts/i.test(model)
    if (capability === 'speech.stt') return /(?:transcribe|whisper)/i.test(model)
    return false
  }

  async execute(request: MediaRequest, context: AdapterContext): Promise<AdapterResult> {
    this.assertSupport(request)
    if (request.capability === 'speech.tts') return this.tts(request, context)
    if (request.capability === 'speech.stt') return this.stt(request, context)
    if (request.capability === 'image.text_to_image') return this.generateImage(request, context)
    return this.editImage(request, context)
  }

  private async generateImage(request: MediaRequest, context: AdapterContext): Promise<AdapterResult> {
    const key = this.key(request)
    const payload = mergeOptions({
      model: request.model,
      prompt: requirePrompt(request),
      n: request.count ?? 1,
      ...(request.resolution ? { size: request.resolution } : {}),
    }, request.providerOptions)
    const data = await this.http.json<unknown>(`${this.baseUrl}/images/generations`, {
      method: 'POST', headers: bearerHeaders(key, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload), signal: context.signal, provider: this.id, secrets: [key], timeoutMs: 120_000,
    })
    return artifactsOrThrow(this.result(request, data, 'image'))
  }

  private async editImage(request: MediaRequest, context: AdapterContext): Promise<AdapterResult> {
    const key = this.key(request)
    const sources = [request.inputImage, ...(request.referenceImages ?? [])].filter((value): value is string => Boolean(value))
    if (sources.length === 0) throw new Error('OpenAI image edit requires inputImage or referenceImages')
    if (sources.length > 16) throw new Error('OpenAI GPT Image editing supports at most 16 source images')
    const form = new FormData()
    form.set('model', request.model)
    form.set('prompt', requirePrompt(request))
    form.set('n', String(request.count ?? 1))
    if (request.resolution) form.set('size', request.resolution)
    for (const source of sources) {
      const file = await this.input.asBlob(source, context.signal)
      form.append('image[]', file.blob, file.fileName)
    }
    if (request.mask) {
      const mask = await this.input.asBlob(request.mask, context.signal)
      form.set('mask', mask.blob, mask.fileName)
    }
    for (const [name, value] of Object.entries(request.providerOptions ?? {})) {
      if (value !== undefined) form.set(name, typeof value === 'string' ? value : JSON.stringify(value))
    }
    const data = await this.http.json<unknown>(`${this.baseUrl}/images/edits`, {
      method: 'POST', headers: bearerHeaders(key), body: form, signal: context.signal,
      provider: this.id, secrets: [key], timeoutMs: 120_000,
    })
    return artifactsOrThrow(this.result(request, data, 'image'))
  }

  private async tts(request: MediaRequest, context: AdapterContext): Promise<AdapterResult> {
    const key = this.key(request)
    const format = request.responseFormat ?? 'mp3'
    const payload = mergeOptions({
      model: request.model,
      input: request.text ?? request.prompt ?? '',
      voice: request.voice ?? 'alloy',
      response_format: format,
    }, request.providerOptions)
    const response = await this.http.request(`${this.baseUrl}/audio/speech`, {
      method: 'POST', headers: bearerHeaders(key, { 'Content-Type': 'application/json' }), body: JSON.stringify(payload),
      signal: context.signal, provider: this.id, secrets: [key], timeoutMs: 120_000,
    })
    const bytes = Buffer.from(await response.arrayBuffer()).toString('base64')
    return this.result(request, { b64_json: bytes, mime_type: response.headers.get('content-type') ?? `audio/${format}` }, 'audio')
  }

  private async stt(request: MediaRequest, context: AdapterContext): Promise<AdapterResult> {
    if (!request.inputAudio) throw new Error('OpenAI transcription requires inputAudio')
    const key = this.key(request)
    const audio = await this.input.asBlob(request.inputAudio, context.signal)
    const form = new FormData()
    form.set('file', audio.blob, audio.fileName)
    form.set('model', request.model)
    if (request.language) form.set('language', request.language)
    for (const [name, value] of Object.entries(request.providerOptions ?? {})) {
      if (value !== undefined) form.set(name, typeof value === 'string' ? value : JSON.stringify(value))
    }
    const response = await this.http.json<{ text?: string }>(`${this.baseUrl}/audio/transcriptions`, {
      method: 'POST', headers: bearerHeaders(key), body: form, signal: context.signal,
      provider: this.id, secrets: [key], timeoutMs: 120_000,
    })
    return this.result(request, {}, 'text', { text: response.text ?? '' })
  }
}
