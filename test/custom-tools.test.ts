import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
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
import { resolveVertexProjectOptions, type CustomProviderConfig } from '../src/config.js'
import { videoCapability } from '../src/tools.js'

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

test('custom auth=none providers do not require or send a key', async () => {
  const noAuth: CustomProviderConfig = {
    id: 'local-no-auth', baseUrl: 'http://localhost:9999', auth: 'none',
    models: [{ id: 'local/image', vendor: 'local', capabilities: ['image.text_to_image'], endpoints: { 'image.text_to_image': '/generate' } }],
  }
  const adapter = new CustomOpenAICompatibleAdapter(noAuth, {
    http: new HttpClient(async (_url, init) => {
      assert.equal((init?.headers as Record<string, string> | undefined)?.Authorization, undefined)
      return Response.json({ image: { b64_json: Buffer.alloc(128, 4).toString('base64') } })
    }),
    input: new InputResolver(new HttpClient(async () => Response.json({}))),
    env: {},
  })
  const result = await adapter.execute({ capability: 'image.text_to_image', provider: 'local-no-auth', model: 'local/image', prompt: 'x' }, {})
  assert.equal(result.artifacts.length, 1)
})

test('Vertex project placeholders are replaced from the service-account credentials', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-media-vertex-'))
  const credentialsFile = join(dir, 'credentials.json')
  try {
    await writeFile(credentialsFile, JSON.stringify({ project_id: 'titanium-bus-506411-i5' }))
    const options = await resolveVertexProjectOptions({ credentialsFile, project: 'my-gcp-project', location: 'us-central1' })
    assert.equal(options.project, 'titanium-bus-506411-i5')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('CapabilityRouter preserves curated fallback order when live discovery is unavailable', async () => {
  const router = new CapabilityRouter({ cwd: process.cwd(), config: { customProviders: [] }, env: {} })
  assert.equal(await router.defaultModel('openai', 'image.text_to_image'), 'gpt-image-2')
  assert.equal(await router.defaultModel('qwencloud', 'image.text_to_image'), 'qwen-image-3.0-pro')
  assert.equal(await router.defaultModel('qwencloud', 'video.text_to_video'), 'wan3.0-video')
  assert.equal(await router.defaultModel('qwencloud', 'speech.tts'), 'qwen-audio-3.0-tts-plus')
  assert.equal(await router.defaultModel('dashscope', 'speech.tts'), 'qwen-audio-3.0-tts-plus')
})

test('video operation validation rejects contradictory input combinations', () => {
  assert.equal(videoCapability({ inputImage: 'first.png', endImage: 'last.png' }), 'video.first_last_frame')
  assert.equal(videoCapability({ referenceAudioVoices: ['Ara'] }), 'video.reference')
  assert.throws(() => videoCapability({ endImage: 'last.png' }), { code: 'INPUT' })
  assert.throws(() => videoCapability({ operation: 'edit' }), { code: 'INPUT' })
  assert.throws(() => videoCapability({ operation: 'generate', inputVideo: 'clip.mp4' }), { code: 'INPUT' })
  assert.throws(() => videoCapability({ inputVideo: 'clip.mp4', referenceImages: ['ref.png'] }), { code: 'INPUT' })
  assert.throws(() => videoCapability({ operation: 'reference', referenceImages: ['ref.png'], inputImage: 'first.png' }), { code: 'INPUT' })
})

test('CapabilityRouter accepts the dedicated QwenCloud environment key', () => {
  const router = new CapabilityRouter({ cwd: process.cwd(), config: { customProviders: [] }, env: { QWENCLOUD_API_KEY: 'qwen-test-key' } })
  assert.equal(router.providers().find(provider => provider.id === 'qwencloud')?.configured, true)
})

test('CapabilityRouter blocks tool-call credential and endpoint overrides', async () => {
  let called = false
  const router = new CapabilityRouter({
    cwd: process.cwd(),
    config: { customProviders: [], providerOptions: { qwencloud: { apiKey: 'qwen-test-key' } } },
    env: {},
    fetch: async () => {
      called = true
      return Response.json({})
    },
  })
  await assert.rejects(router.execute({
    capability: 'image.text_to_image', provider: 'qwencloud', model: 'qwen-image-3.0-pro', prompt: 'moon',
    providerOptions: { baseUrl: 'https://attacker.invalid' },
  }), { code: 'INPUT' })
  assert.equal(called, false)
})

test('CapabilityRouter rejects credential aliases and normalized passthrough fields', async () => {
  const router = new CapabilityRouter({
    cwd: process.cwd(),
    config: { customProviders: [], providerOptions: { openai: { apiKey: 'key' } } },
    env: {},
    fetch: async () => { throw new Error('fetch should not run') },
  })
  await assert.rejects(router.execute({
    capability: 'image.text_to_image', provider: 'openai', model: 'gpt-image-2', prompt: 'x', providerOptions: { api_key: 'secret' },
  }), { code: 'INPUT' })
  await assert.rejects(router.execute({
    capability: 'image.text_to_image', provider: 'openai', model: 'gpt-image-2', prompt: 'x', providerOptions: { output_format: 'png' },
  }), { code: 'INPUT' })
})

test('CapabilityRouter verifies explicit OpenRouter models against media catalogs', async () => {
  let submitted = false
  const router = new CapabilityRouter({
    cwd: process.cwd(),
    config: { customProviders: [], providerOptions: { openrouter: { apiKey: 'or-test-key' } } },
    env: {},
    fetch: async (_url, init) => {
      if ((init?.method ?? 'GET') === 'POST') submitted = true
      return Response.json({ data: [] })
    },
  })
  await assert.rejects(router.execute({
    capability: 'speech.tts', provider: 'openrouter', model: 'openai/gpt-4o', text: 'hello',
  }), { code: 'CAPABILITY_UNSUPPORTED' })
  assert.equal(submitted, false)
})

test('CapabilityRouter probes models and defaults to the newest usable version', async () => {
  const calls: string[] = []
  const router = new CapabilityRouter({
    cwd: process.cwd(),
    config: { customProviders: [], providerOptions: { gemini: { apiKey: 'gemini-test-key' } } },
    env: {},
    fetch: async (url) => {
      calls.push(String(url))
      if (String(url).includes(':countTokens')) {
        if (String(url).includes('gemini-3.2-flash-image')) return Response.json({ error: 'not enabled' }, { status: 404 })
        return Response.json({ totalTokens: 2 })
      }
      return Response.json({ models: [
        { name: 'models/gemini-2.5-flash-image' },
        { name: 'models/gemini-3.1-flash-image' },
        { name: 'models/gemini-3.2-flash-image' },
      ] })
    },
  })
  const model = await router.defaultModel('gemini', 'image.text_to_image')
  assert.equal(model, 'gemini-3.1-flash-image')
  assert.equal(calls.filter(url => url.includes(':countTokens')).length, 3)
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
