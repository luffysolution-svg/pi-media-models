import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import extension from '../index.js'
import { CustomOpenAICompatibleAdapter } from '../src/adapters/custom.js'
import { MediaError } from '../src/errors.js'
import { HttpClient } from '../src/http.js'
import { InputResolver } from '../src/input.js'
import { CapabilityRouter } from '../src/router.js'
import type { CustomProviderConfig } from '../src/config.js'

const custom: CustomProviderConfig = {
  id: 'local-media',
  name: 'Local Media',
  baseUrl: 'https://media.test/v1',
  apiKeyEnv: 'LOCAL_MEDIA_KEY',
  models: [{
    id: 'acme/painter',
    vendor: 'acme',
    capabilities: ['image.text_to_image'],
    endpoints: { 'image.text_to_image': '/images/generations' },
  }],
}

test('extension registers only the six unified tools', () => {
  const names: string[] = []
  const pi = { registerTool(tool: { name: string }) { names.push(tool.name) } } as unknown as ExtensionAPI
  extension(pi)
  assert.deepEqual(names.sort(), ['audio_generate', 'image_edit', 'image_generate', 'media_models', 'speech_generate', 'video_generate'])
})

test('custom OpenAI-compatible adapter requires explicit capability and endpoint', async () => {
  let called = ''
  const http = new HttpClient(async (url) => {
    called = String(url)
    return Response.json({ data: [{ b64_json: Buffer.alloc(128, 2).toString('base64') }] })
  })
  const adapter = new CustomOpenAICompatibleAdapter(custom, { http, input: new InputResolver(http), env: { LOCAL_MEDIA_KEY: 'test-key' } })
  assert.equal(adapter.supports('image.text_to_image', 'acme/painter'), true)
  assert.equal(adapter.supports('video.text_to_video', 'acme/painter'), false)
  await assert.rejects(
    adapter.execute({ capability: 'video.text_to_video', provider: 'local-media', model: 'acme/painter', prompt: 'x' }, {}),
    (error: unknown) => error instanceof MediaError && error.code === 'CAPABILITY_UNSUPPORTED',
  )
  const result = await adapter.execute({ capability: 'image.text_to_image', provider: 'local-media', model: 'acme/painter', prompt: 'x' }, {})
  assert.equal(called, 'https://media.test/v1/images/generations')
  assert.equal(result.artifacts.length, 1)
})

test('CapabilityRouter normalizes and downloads custom-provider results without raw provider JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-media-router-'))
  try {
    const router = new CapabilityRouter({
      cwd: dir,
      config: { outputDir: dir, customProviders: [custom] },
      env: { LOCAL_MEDIA_KEY: 'test-key' },
      fetch: async () => Response.json({ data: [{ b64_json: Buffer.alloc(128, 3).toString('base64'), mime_type: 'image/png' }], secret_debug: 'must-not-return' }),
    })
    const result = await router.execute({ capability: 'image.text_to_image', provider: 'local-media', model: 'acme/painter', prompt: 'x' })
    assert.equal(result.artifacts.length, 1)
    assert.equal(result.artifacts[0]?.path.startsWith(dir), true)
    assert.equal('secret_debug' in result, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('test mode blocks accidental real paid network requests', async () => {
  const http = new HttpClient()
  await assert.rejects(http.request('https://api.openai.com/v1/images/generations'), /disabled in tests/)
})
