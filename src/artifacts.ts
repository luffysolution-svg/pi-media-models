import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { HttpClient } from './http.js'
import { MediaError } from './errors.js'
import type { MediaKind, NormalizedArtifact, RemoteArtifact } from './types.js'

const EXT_BY_MIME: Record<string, string> = {
  'audio/aac': '.aac', 'audio/flac': '.flac', 'audio/L16': '.pcm', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a',
  'audio/ogg': '.ogg', 'audio/pcm': '.pcm', 'audio/wav': '.wav', 'image/gif': '.gif', 'image/jpeg': '.jpg',
  'image/png': '.png', 'image/webp': '.webp', 'video/mp4': '.mp4', 'video/mpeg': '.mpeg',
  'video/quicktime': '.mov', 'video/webm': '.webm',
}

function kindFrom(value: string, fallback: MediaKind): MediaKind {
  const lower = value.toLowerCase()
  if (/\.(?:png|jpe?g|gif|webp)(?:[?#]|$)/.test(lower) || lower.startsWith('image/')) return 'image'
  if (/\.(?:mp4|mov|webm|mkv|mpeg)(?:[?#]|$)/.test(lower) || lower.startsWith('video/')) return 'video'
  if (/\.(?:mp3|wav|ogg|m4a|aac|flac)(?:[?#]|$)/.test(lower) || lower.startsWith('audio/')) return 'audio'
  return fallback
}

function looksLikeBase64(value: string): boolean {
  return value.length > 100 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value)
}

export function extractArtifacts(payload: unknown, fallback: MediaKind): RemoteArtifact[] {
  const found: RemoteArtifact[] = []
  const seen = new Set<string>()

  function push(artifact: RemoteArtifact): void {
    const identity = artifact.url ?? artifact.base64
    if (!identity || seen.has(identity)) return
    seen.add(identity)
    found.push(artifact)
  }

  function walk(value: unknown, key = '', mimeHint?: string): void {
    if (typeof value === 'string') {
      if (/^https?:\/\//i.test(value)) push({ kind: kindFrom(value, mimeHint ? kindFrom(mimeHint, fallback) : fallback), url: value, ...(mimeHint ? { mimeType: mimeHint } : {}) })
      else if (value.startsWith('data:')) {
        const match = /^data:([^;,]+)?;base64,(.*)$/s.exec(value)
        if (match?.[2]) push({ kind: kindFrom(match[1] ?? '', fallback), base64: match[2], ...(match[1] ? { mimeType: match[1] } : {}) })
      } else if (/(?:b64|base64|bytes|data|content)/i.test(key) && looksLikeBase64(value)) {
        push({ kind: kindFrom(mimeHint ?? '', fallback), base64: value, ...(mimeHint ? { mimeType: mimeHint } : {}) })
      }
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, key, mimeHint)
      return
    }
    if (!value || typeof value !== 'object') return
    const object = value as Record<string, unknown>
    const mime = typeof object.mime_type === 'string'
      ? object.mime_type
      : typeof object.mimeType === 'string'
        ? object.mimeType
        : mimeHint
    for (const [childKey, child] of Object.entries(object)) walk(child, childKey, mime)
  }

  walk(payload)
  return found
}

function inferExtension(artifact: RemoteArtifact): string {
  if (artifact.fileName) {
    const extension = extname(artifact.fileName)
    if (extension) return extension
  }
  if (artifact.mimeType) {
    const baseMime = artifact.mimeType.split(';', 1)[0] ?? artifact.mimeType
    const known = EXT_BY_MIME[baseMime]
    if (known) return known
  }
  if (artifact.url) {
    const extension = extname(new URL(artifact.url).pathname)
    if (extension && extension.length <= 8) return extension
  }
  return artifact.kind === 'image' ? '.png' : artifact.kind === 'video' ? '.mp4' : artifact.kind === 'audio' ? '.mp3' : '.txt'
}

export class ArtifactDownloader {
  constructor(
    private readonly http: HttpClient,
    private readonly outputDir = join(homedir(), '.pi', 'agent', 'media', 'outputs'),
  ) {}

  async downloadAll(artifacts: readonly RemoteArtifact[], signal?: AbortSignal): Promise<NormalizedArtifact[]> {
    await mkdir(this.outputDir, { recursive: true })
    const outputs: NormalizedArtifact[] = []
    for (const artifact of artifacts) outputs.push(await this.download(artifact, signal))
    return outputs
  }

  private async download(artifact: RemoteArtifact, signal?: AbortSignal): Promise<NormalizedArtifact> {
    const extension = inferExtension(artifact)
    const finalPath = join(this.outputDir, `${Date.now()}-${randomUUID().slice(0, 8)}${extension}`)
    const partPath = `${finalPath}.part`
    try {
      let bytes: Uint8Array
      let mimeType = artifact.mimeType
      if (artifact.base64) {
        bytes = Buffer.from(artifact.base64, 'base64')
      } else if (artifact.url) {
        const response = await this.http.request(artifact.url, {
          signal,
          headers: artifact.headers,
          timeoutMs: 120_000,
          retries: 2,
          provider: 'download',
        })
        bytes = new Uint8Array(await response.arrayBuffer())
        mimeType ??= response.headers.get('content-type')?.split(';', 1)[0] ?? undefined
      } else {
        throw new MediaError('DOWNLOAD', 'Artifact has neither URL nor base64 data')
      }
      await writeFile(partPath, bytes)
      await rename(partPath, finalPath)
      const info = await stat(finalPath)
      return { kind: artifact.kind, path: finalPath, bytes: info.size, ...(mimeType ? { mimeType } : {}) }
    } catch (error) {
      await rm(partPath, { force: true }).catch(() => undefined)
      if (error instanceof MediaError) throw error
      throw new MediaError('DOWNLOAD', `Failed to save generated ${artifact.kind}`, { cause: error })
    }
  }
}
