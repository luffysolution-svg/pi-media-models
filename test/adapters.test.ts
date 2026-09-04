import assert from 'node:assert/strict'
import test from 'node:test'
import { AtlasAdapter } from '../src/adapters/atlas.js'
import { DashScopeAdapter } from '../src/adapters/dashscope.js'
import { FalAdapter } from '../src/adapters/fal.js'
import { GoogleMediaAdapter } from '../src/adapters/google.js'
import { OpenAIAdapter } from '../src/adapters/openai.js'
import { OpenRouterAdapter } from '../src/adapters/openrouter.js'
import { XAIAdapter } from '../src/adapters/xai.js'
import { HttpClient, type FetchLike } from '../src/http.js'
import { InputResolver } from '../src/input.js'

const imageBase64 = Buffer.alloc(128, 7).toString('base64')
const dataImage = 'data:image/png;base64,YWJj'

function deps(fetch: FetchLike, env: NodeJS.ProcessEnv) {
  const http = new HttpClient(fetch)
  return { http, input: new InputResolver(http), env }
}

function requestBody(init?: RequestInit): Record<string, unknown> {
  const body = init?.body
  assert.equal(typeof body, 'string')
  return JSON.parse(body as string) as Record<string, unknown>
}

test('AtlasAdapter uses documented sync image endpoint', async () => {
  let called = ''
  const adapter = new AtlasAdapter(deps(async (url, init) => {
    called = String(url)
    assert.equal(requestBody(init).model, 'gpt-image-2')
    return Response.json({ data: [{ b64_json: imageBase64, mime_type: 'image/png' }] })
  }, { ATLAS_API_KEY: 'atlas-test-key' }))
  const result = await adapter.execute({ capability: 'image.text_to_image', provider: 'atlas', model: 'gpt-image-2', prompt: 'bird', providerOptions: { async: false } }, {})
  assert.equal(called, 'https://api.aixoras.com/v1/images/generations')
  assert.equal(result.artifacts.length, 1)
})

test('xAI adapter uses JSON multi-image edits and independent endpoint', async () => {
  let body: Record<string, unknown> = {}
  const adapter = new XAIAdapter(deps(async (url, init) => {
    assert.equal(String(url), 'https://api.x.ai/v1/images/edits')
    body = requestBody(init)
    return Response.json({ data: [{ b64_json: imageBase64, mime_type: 'image/png' }] })
  }, { XAI_API_KEY: 'xai-test-key' }))
  const result = await adapter.execute({
    capability: 'image.multi_reference', provider: 'xai', model: 'grok-imagine-image-2.0', prompt: 'merge',
    inputImage: dataImage, referenceImages: [dataImage],
  }, {})
  assert.equal(Array.isArray(body.images), true)
  assert.equal((body.images as unknown[]).length, 2)
  assert.equal(result.artifacts[0]?.kind, 'image')
})

test('OpenAI adapter never exposes video support and sends image generation only', async () => {
  const adapter = new OpenAIAdapter(deps(async (url) => {
    assert.equal(String(url), 'https://api.openai.com/v1/images/generations')
    return Response.json({ data: [{ b64_json: imageBase64 }] })
  }, { OPENAI_API_KEY: 'openai-test-key' }))
  assert.equal(adapter.supports('video.text_to_video', 'gpt-image-2'), false)
  const result = await adapter.execute({ capability: 'image.text_to_image', provider: 'openai', model: 'gpt-image-2', prompt: 'cat' }, {})
  assert.equal(result.artifacts.length, 1)
})

test('OpenRouter adapter uses current dedicated Images API', async () => {
  const adapter = new OpenRouterAdapter(deps(async (url, init) => {
    assert.equal(String(url), 'https://openrouter.ai/api/v1/images')
    assert.deepEqual(requestBody(init).input_references, [dataImage])
    return Response.json({ data: [{ b64_json: imageBase64, media_type: 'image/png' }] })
  }, { OPENROUTER_API_KEY: 'or-test-key' }))
  const result = await adapter.execute({ capability: 'image.image_to_image', provider: 'openrouter', model: 'vendor/image', prompt: 'edit', inputImage: dataImage }, {})
  assert.equal(result.artifacts.length, 1)
})

test('fal adapter uploads local/data inputs to fal CDN before queue submission', async () => {
  const calls: string[] = []
  const adapter = new FalAdapter(deps(async (url, init) => {
    calls.push(String(url))
    if (String(url).includes('/storage/upload/initiate')) return Response.json({ upload_url: 'https://upload.test/signed', file_url: 'https://v3.fal.media/input.png' })
    if (String(url) === 'https://upload.test/signed') return new Response(null, { status: 200 })
    const body = requestBody(init)
    assert.equal(body.image_url, 'https://v3.fal.media/input.png')
    return Response.json({ image: { url: 'https://cdn.test/output.png' } })
  }, { FAL_KEY: 'fal-test-key' }))
  const result = await adapter.execute({ capability: 'image.image_to_image', provider: 'fal', model: 'fal-ai/flux/dev', prompt: 'edit', inputImage: dataImage }, {})
  assert.equal(calls.length, 3)
  assert.equal(result.artifacts[0]?.url, 'https://cdn.test/output.png')
})

test('DashScope adapter maps unified references to Wan media[]', async () => {
  const adapter = new DashScopeAdapter('qwencloud', 'https://dashscope-intl.aliyuncs.com', deps(async (url, init) => {
    assert.equal(String(url).endsWith('/api/v1/services/aigc/video-generation/video-synthesis'), true)
    const body = requestBody(init)
    const media = ((body.input as { media: Array<{ type: string }> }).media)
    assert.deepEqual(media.map(item => item.type), ['first_frame', 'last_frame', 'reference_video', 'reference_audio'])
    return Response.json({ output: { video_url: 'https://cdn.test/wan.mp4' } })
  }, { DASHSCOPE_API_KEY: 'dash-test-key' }))
  const result = await adapter.execute({
    capability: 'video.first_last_frame', provider: 'qwencloud', model: 'wan3.0-video', prompt: 'transition',
    inputImage: dataImage, endImage: dataImage, referenceVideos: ['https://cdn.test/ref.mp4'], referenceAudios: ['https://cdn.test/ref.mp3'],
  }, {})
  assert.equal(result.artifacts[0]?.kind, 'video')
})

test('Gemini adapter discovers current media models instead of relying on built-ins', async () => {
  const adapter = new GoogleMediaAdapter('gemini', deps(async (url) => {
    assert.match(String(url), /\/v1beta\/models\?/)
    return Response.json({ models: [
      { name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.1-flash-image', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-text-only', supportedGenerationMethods: ['generateContent'] },
    ] })
  }, { GEMINI_API_KEY: 'gemini-test-key' }))
  const models = await adapter.discoverModels({})
  assert.deepEqual(models.map(model => model.id), ['gemini-2.5-flash-image', 'gemini-3.1-flash-image'])
  assert.equal(models.every(model => model.availability === 'available'), true)
})

test('Gemini adapter uses generateContent for image editing', async () => {
  const adapter = new GoogleMediaAdapter('gemini', deps(async (url, init) => {
    assert.match(String(url), /gemini-2\.5-flash-image:generateContent$/)
    const body = requestBody(init)
    assert.equal(Array.isArray(body.contents), true)
    return Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: imageBase64 } }] } }] })
  }, { GEMINI_API_KEY: 'gemini-test-key' }))
  const result = await adapter.execute({ capability: 'image.edit', provider: 'gemini', model: 'gemini-2.5-flash-image', prompt: 'edit', inputImage: dataImage }, {})
  assert.equal(result.artifacts.length, 1)
})
