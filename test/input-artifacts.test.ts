import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

test('artifact extraction handles nested temporary URLs and base64', () => {
  const artifacts = extractArtifacts({
    output: { images: [{ url: 'https://cdn.test/a.png' }] },
    audio: { mime_type: 'audio/wav', b64_json: Buffer.alloc(90, 1).toString('base64') },
  }, 'image')
  assert.equal(artifacts.length, 2)
  assert.equal(artifacts[0]?.kind, 'image')
  assert.equal(artifacts[1]?.kind, 'audio')
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
