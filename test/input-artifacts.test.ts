import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ArtifactDownloader, extractArtifacts } from '../src/artifacts.js'
import { HttpClient } from '../src/http.js'
import { InputResolver } from '../src/input.js'

test('InputResolver supports local paths, file URLs, data URIs, and HTTP URLs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-media-input-'))
  try {
    const file = join(dir, 'sample.png')
    await writeFile(file, Buffer.from('png-data'))
    const http = new HttpClient(async () => new Response(Buffer.from('remote'), { headers: { 'Content-Type': 'image/png' } }))
    const resolver = new InputResolver(http, dir)
    assert.equal((await resolver.resolve('sample.png')).kind, 'file')
    assert.equal((await resolver.resolve(new URL(`file:///${file.replace(/\\/g, '/')}`).href)).kind, 'file')
    assert.equal((await resolver.resolve('data:image/png;base64,YWJj')).kind, 'data')
    const remote = await resolver.resolve('https://example.test/image.png')
    assert.equal(remote.kind, 'url')
    assert.equal(await resolver.asDataUri('https://example.test/image.png'), 'https://example.test/image.png')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('InputResolver blocks private remote inputs before fetch', async () => {
  let called = false
  const resolver = new InputResolver(new HttpClient(async () => {
    called = true
    return new Response('private')
  }))
  const input = await resolver.resolve('http://127.0.0.1/input.png')
  await assert.rejects(resolver.bytes(input), { code: 'DOWNLOAD' })
  assert.equal(called, false)
})

test('artifact extraction handles nested temporary URLs and base64', () => {
  const artifacts = extractArtifacts({
    output: { images: [{ url: 'https://cdn.test/a.png' }] },
    audio: { mime_type: 'audio/wav', b64_json: Buffer.alloc(90, 1).toString('base64') },
  }, 'image')
  assert.equal(artifacts.length, 2)
  assert.equal(artifacts[0]?.kind, 'image')
  assert.equal(artifacts[1]?.kind, 'audio')
  assert.equal(extractArtifacts({ status_url: 'https://api.test/tasks/1', transcription_url: 'https://cdn.test/result.json', text: 'https://cdn.test/not-output.png' }, 'video').length, 0)
})

test('ArtifactDownloader rejects private and credential-bearing response URLs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-media-private-'))
  let called = false
  try {
    const downloader = new ArtifactDownloader(new HttpClient(async () => {
      called = true
      return new Response('unexpected')
    }), dir)
    await assert.rejects(downloader.downloadAll([{ kind: 'image', url: 'http://127.0.0.1/private.png' }]), { code: 'DOWNLOAD' })
    await assert.rejects(downloader.downloadAll([{ kind: 'image', url: 'https://user:pass@cdn.test/private.png' }]), { code: 'DOWNLOAD' })
    assert.equal(called, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ArtifactDownloader revalidates redirect targets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-media-redirect-'))
  let calls = 0
  try {
    const downloader = new ArtifactDownloader(new HttpClient(async () => {
      calls += 1
      return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/private.png' } })
    }), dir)
    await assert.rejects(downloader.downloadAll([{ kind: 'image', url: 'https://cdn.test/redirect.png' }]), { code: 'DOWNLOAD' })
    assert.equal(calls, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ArtifactDownloader sends artifact auth only to the declared origin', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-media-origin-'))
  const seen: Array<Record<string, string> | undefined> = []
  try {
    const downloader = new ArtifactDownloader(new HttpClient(async (_url, init) => {
      seen.push(init?.headers as Record<string, string> | undefined)
      return new Response('data', { headers: { 'Content-Type': 'image/png' } })
    }), dir)
    await downloader.downloadAll([
      { kind: 'image', url: 'https://cdn.test/a.png', headers: { Authorization: 'Bearer secret' }, headerOrigin: 'https://api.test' },
      { kind: 'image', url: 'https://api.test/b.png', headers: { Authorization: 'Bearer secret' }, headerOrigin: 'https://api.test' },
    ])
    assert.equal(seen[0], undefined)
    assert.equal(seen[1]?.Authorization, 'Bearer secret')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ArtifactDownloader rolls back completed and partial files on failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-media-rollback-'))
  try {
    const downloader = new ArtifactDownloader(new HttpClient(async () => new Response('unused')), dir)
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]))
        controller.error(new Error('broken stream'))
      },
    })
    await assert.rejects(downloader.downloadAll([
      { kind: 'image', data: new Uint8Array([1, 2, 3]), mimeType: 'image/png' },
      { kind: 'video', stream: broken, mimeType: 'video/mp4' },
    ]), { code: 'DOWNLOAD' })
    assert.deepEqual(await readdir(dir), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ArtifactDownloader times out a stalled URL-less stream', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-media-stream-timeout-'))
  try {
    const downloader = new ArtifactDownloader(new HttpClient(async () => new Response('unused')), dir, 1024, 10)
    await assert.rejects(downloader.downloadAll([{
      kind: 'audio', stream: new ReadableStream<Uint8Array>({ start() {} }),
    }]), { code: 'TIMEOUT' })
    assert.deepEqual(await readdir(dir), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ArtifactDownloader enforces maxArtifactBytes while streaming', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-media-limit-'))
  try {
    const downloader = new ArtifactDownloader(new HttpClient(async () => new Response('unused')), dir, 4)
    await assert.rejects(downloader.downloadAll([{
      kind: 'video',
      stream: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(5)); controller.close() } }),
    }]), { code: 'DOWNLOAD' })
    assert.deepEqual(await readdir(dir), [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ArtifactDownloader writes .part then atomically renames final output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-media-output-'))
  try {
    const downloader = new ArtifactDownloader(new HttpClient(async () => new Response('remote-data', { headers: { 'Content-Type': 'video/mp4' } })), dir)
    const outputs = await downloader.downloadAll([{ kind: 'video', url: 'https://cdn.test/video.mp4' }])
    assert.equal(outputs.length, 1)
    assert.equal((await readFile(outputs[0]!.path, 'utf8')), 'remote-data')
    assert.equal(outputs[0]!.path.endsWith('.mp4'), true)
    await assert.rejects(readFile(`${outputs[0]!.path}.part`))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
