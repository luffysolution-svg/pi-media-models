import { MediaError, redactSecrets } from './errors.js'

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface HttpRequestOptions extends RequestInit {
  timeoutMs?: number
  retries?: number
  retryUnsafe?: boolean
  provider?: string
  secrets?: readonly string[]
}

function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after')
  if (!raw) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(raw)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined
}

function combineSignals(signal: AbortSignal | null | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const timeoutController = new AbortController()
  const timer = setTimeout(() => timeoutController.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs)
  const combined = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal
  return { signal: combined, cleanup: () => clearTimeout(timer) }
}

async function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (ms <= 0) return
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    const timer = setTimeout(done, ms)
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    if (signal?.aborted) return abort()
    signal?.addEventListener('abort', abort, { once: true })
  })
}

export class HttpClient {
  private readonly fetchImpl: FetchLike

  constructor(fetchImpl?: FetchLike) {
    if (!fetchImpl && process.env.PI_MEDIA_TEST_MODE === '1') {
      this.fetchImpl = async () => {
        throw new MediaError('CONFIG', 'Real network requests are disabled in tests')
      }
    } else {
      this.fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis)
    }
  }

  async request(url: string, options: HttpRequestOptions = {}): Promise<Response> {
    const {
      timeoutMs = 30_000,
      retries = 2,
      retryUnsafe = false,
      provider,
      secrets = [],
      ...init
    } = options
    const method = (init.method ?? 'GET').toUpperCase()
    const canRetry = retryUnsafe || method === 'GET' || method === 'HEAD'
    let attempt = 0

    while (true) {
      const { signal, cleanup } = combineSignals(init.signal, timeoutMs)
      try {
        const response = await this.fetchImpl(url, { ...init, signal })
        if (response.ok) return response

        const retryMs = retryAfterMs(response.headers)
        const retryable = response.status === 429 || response.status >= 500
        if (retryable && canRetry && attempt < retries) {
          attempt += 1
          await response.body?.cancel().catch(() => undefined)
          await sleep(retryMs ?? Math.min(500 * 2 ** (attempt - 1), 5_000), init.signal)
          continue
        }

        const body = redactSecrets((await response.text().catch(() => '')).slice(0, 2_000), secrets)
        const code = response.status === 401 || response.status === 403
          ? 'AUTH'
          : response.status === 429
            ? 'RATE_LIMITED'
            : 'HTTP'
        throw new MediaError(code, `${provider ?? 'Provider'} HTTP ${response.status}${body ? `: ${body}` : ''}`, {
          provider,
          status: response.status,
          ...(retryMs === undefined ? {} : { retryAfterMs: retryMs }),
          secrets,
        })
      } catch (error) {
        if (error instanceof MediaError) throw error
        if (init.signal?.aborted) throw new MediaError('ABORTED', 'Media request aborted', { provider, cause: error })
        if (signal.aborted) throw new MediaError('TIMEOUT', `Request timed out after ${timeoutMs}ms`, { provider, cause: error })
        if (canRetry && attempt < retries) {
          attempt += 1
          await sleep(Math.min(500 * 2 ** (attempt - 1), 5_000), init.signal)
          continue
        }
        throw new MediaError('HTTP', `Network request failed: ${error instanceof Error ? error.message : String(error)}`, {
          provider,
          cause: error,
          secrets,
        })
      } finally {
        cleanup()
      }
    }
  }

  async json<T>(url: string, options: HttpRequestOptions = {}): Promise<T> {
    const response = await this.request(url, options)
    try {
      return await response.json() as T
    } catch (error) {
      throw new MediaError('PROVIDER', `${options.provider ?? 'Provider'} returned invalid JSON`, {
        provider: options.provider,
        cause: error,
      })
    }
  }
}
