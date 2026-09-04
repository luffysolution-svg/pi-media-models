import { randomUUID } from 'node:crypto'
import type { RawData } from 'ws'
import { MediaError } from '../errors.js'
import type { AdapterContext, JsonObject, RemoteArtifact } from '../types.js'

interface DashScopeTtsRequest {
  provider: string
  baseUrl: string
  key: string
  model: string
  text: string
  voice?: string
  language?: string
  responseFormat?: string
  providerOptions?: JsonObject
}

const MIME_BY_FORMAT: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  pcm: 'audio/pcm',
  opus: 'audio/ogg',
}

export function isQwenAudioTts(model: string): boolean {
  return /^qwen-audio-3(?:\.\d+)?-tts-(?:plus|flash)(?:-|$)/i.test(model)
}

export async function synthesizeDashScopeTts(request: DashScopeTtsRequest, context: AdapterContext): Promise<RemoteArtifact> {
  const options = request.providerOptions ?? {}
  const text = request.text.trim()
  if (!text) throw new MediaError('INPUT', 'TTS requires text', { provider: request.provider })

  const defaultVoice = /-plus(?:-|$)/i.test(request.model) ? 'longanlingxin' : 'longanhuan_v3.6'
  const voice = stringOption(request.voice) ?? stringOption(options.voice) ?? defaultVoice
  const format = (request.responseFormat ?? stringOption(options.format) ?? 'mp3').toLowerCase()
  const mimeType = MIME_BY_FORMAT[format]
  if (!mimeType) throw new MediaError('INPUT', `Unsupported DashScope TTS response format: ${format}`, { provider: request.provider })

  const taskId = randomUUID().replaceAll('-', '')
  const timeoutMs = positiveNumber(options.timeoutMs) ?? 10 * 60_000
  const connectTimeoutMs = positiveNumber(options.connectTimeoutMs) ?? 15_000
  const websocketUrl = stringOption(options.websocketUrl) ?? `${request.baseUrl.replace(/^http/i, 'ws')}/api-ws/v1/inference`
  const volume = boundedOption(options.volume, 0, 100, 'volume', request.provider) ?? 50
  const rate = boundedOption(options.rate, 0.5, 2, 'rate', request.provider) ?? 1
  const pitch = boundedOption(options.pitch, 0.5, 2, 'pitch', request.provider) ?? 1
  const seed = boundedOption(options.seed, 0, 65_535, 'seed', request.provider, true) ?? 0
  const sampleRate = positiveNumber(options.sampleRate) ?? positiveNumber(options.sample_rate) ?? 22_050
  if (![8_000, 16_000, 22_050, 24_000, 44_100, 48_000].includes(sampleRate)) {
    throw new MediaError('INPUT', 'DashScope TTS sample rate must be 8000, 16000, 22050, 24000, 44100, or 48000', { provider: request.provider })
  }
  const parameters: JsonObject = {
    voice,
    volume,
    text_type: 'PlainText',
    sample_rate: sampleRate,
    rate,
    format,
    pitch,
    seed,
    type: numberOption(options.synthesisType) ?? 0,
    enable_ssml: booleanOption(options.enableSsml) ?? false,
  }
  const instruction = stringOption(options.instruction)
  if (instruction) parameters.instruction = instruction
  const languageHints = stringArrayOption(options.languageHints) ?? (request.language ? [request.language] : undefined)
  if (languageHints?.length) parameters.language_hints = languageHints

  const headers: Record<string, string> = { Authorization: `Bearer ${request.key}` }
  const workspace = stringOption(options.workspace)
  if (workspace) headers['X-DashScope-WorkSpace'] = workspace

  if (context.signal?.aborted) throw new MediaError('ABORTED', 'Media request aborted', { provider: request.provider })
  context.onProgress?.(`${request.provider} TTS: connecting`)
  const { default: WebSocket } = await import('ws')
  return new Promise<RemoteArtifact>((resolve, reject) => {
    const chunks: Buffer[] = []
    let settled = false
    let started = false
    const socket = new WebSocket(websocketUrl, { headers, handshakeTimeout: connectTimeoutMs })
    const timeout = setTimeout(() => fail(new MediaError('TIMEOUT', `${request.provider} TTS timed out after ${timeoutMs}ms`, { provider: request.provider })), timeoutMs)

    const abort = () => fail(new MediaError('ABORTED', 'Media request aborted', { provider: request.provider }))
    context.signal?.addEventListener('abort', abort, { once: true })

    function release(): void {
      clearTimeout(timeout)
      context.signal?.removeEventListener('abort', abort)
    }

    function close(): void {
      if (socket.readyState === WebSocket.OPEN) socket.close()
      else if (socket.readyState === WebSocket.CONNECTING) socket.terminate()
    }

    function fail(error: MediaError): void {
      if (settled) return
      settled = true
      release()
      reject(error)
      close()
    }

    function send(action: string, payload: JsonObject): void {
      socket.send(JSON.stringify({ header: { action, task_id: taskId, streaming: 'duplex' }, payload }))
    }

    socket.on('open', () => {
      send('run-task', {
        model: request.model,
        task_group: 'audio',
        task: 'tts',
        function: 'SpeechSynthesizer',
        input: {},
        parameters,
      })
    })

    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (settled) return
      if (isBinary) {
        chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer))
        return
      }
      try {
        const message = JSON.parse(data.toString()) as { header?: { event?: string; error_name?: string; error_message?: string } }
        const event = message.header?.event
        if (event === 'task-started' && !started) {
          started = true
          context.onProgress?.(`${request.provider} TTS: synthesizing`)
          send('continue-task', {
            model: request.model,
            task_group: 'audio',
            task: 'tts',
            function: 'SpeechSynthesizer',
            input: { text },
          })
          send('finish-task', { input: {} })
        } else if (event === 'task-failed') {
          const detail = message.header?.error_message ?? message.header?.error_name ?? 'speech synthesis failed'
          fail(new MediaError('PROVIDER', `${request.provider} TTS: ${detail}`, { provider: request.provider, secrets: [request.key] }))
        } else if (event === 'task-finished') {
          if (!chunks.length) {
            fail(new MediaError('PROVIDER', `${request.provider} TTS returned no audio data`, { provider: request.provider }))
            return
          }
          settled = true
          release()
          resolve({ kind: 'audio', chunks, mimeType, fileName: `speech.${format === 'opus' ? 'ogg' : format}` })
          close()
        }
      } catch (error) {
        fail(new MediaError('PROVIDER', `${request.provider} TTS returned an invalid WebSocket event`, { provider: request.provider, cause: error }))
      }
    })

    socket.on('error', error => {
      if (!settled) fail(new MediaError('HTTP', `WebSocket connection failed: ${error.message}`, {
        provider: request.provider,
        cause: error,
        secrets: [request.key],
      }))
    })
    socket.on('close', () => {
      if (!settled) fail(new MediaError('HTTP', 'WebSocket connection closed before TTS completed', { provider: request.provider }))
      socket.removeAllListeners()
    })
    if (context.signal?.aborted) abort()
  })
}

function stringOption(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function numberOption(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function positiveNumber(value: unknown): number | undefined {
  const number = numberOption(value)
  return number !== undefined && number > 0 ? number : undefined
}

function booleanOption(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function boundedOption(value: unknown, minimum: number, maximum: number, name: string, provider: string, integer = false): number | undefined {
  const number = numberOption(value)
  if (number === undefined) return undefined
  if (number < minimum || number > maximum || (integer && !Number.isInteger(number))) {
    throw new MediaError('INPUT', `DashScope TTS ${name} must be ${integer ? 'an integer ' : ''}from ${minimum} to ${maximum}`, { provider })
  }
  return number
}

function stringArrayOption(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : undefined
}
