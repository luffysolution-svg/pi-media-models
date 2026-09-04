import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, type Socket } from 'node:net'
import test from 'node:test'
import { WebSocketServer } from 'ws'
import { AtlasAdapter } from '../src/adapters/atlas.js'
import { DashScopeAdapter } from '../src/adapters/dashscope.js'
import { FalAdapter } from '../src/adapters/fal.js'
import { GoogleMediaAdapter, vertexApiOrigin } from '../src/adapters/google.js'
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

test('DashScope adapter maps unified references and normalizes Wan resolution', async () => {
  const adapter = new DashScopeAdapter('qwencloud', 'https://dashscope-intl.aliyuncs.com', deps(async (url, init) => {
    assert.equal(String(url).endsWith('/api/v1/services/aigc/video-generation/video-synthesis'), true)
    const body = requestBody(init)
    const media = ((body.input as { media: Array<{ type: string }> }).media)
    assert.deepEqual(media.map(item => item.type), ['first_frame', 'last_frame', 'reference_video', 'reference_audio'])
    assert.equal((body.parameters as { resolution: string }).resolution, '720P')
    return Response.json({ output: { video_url: 'https://cdn.test/wan.mp4' } })
  }, { DASHSCOPE_API_KEY: 'dash-test-key' }))
  const result = await adapter.execute({
    capability: 'video.first_last_frame', provider: 'qwencloud', model: 'wan3.0-video', prompt: 'transition', resolution: '720p',
    inputImage: dataImage, endImage: dataImage, referenceVideos: ['https://cdn.test/ref.mp4'], referenceAudios: ['https://cdn.test/ref.mp3'],
  }, {})
  assert.equal(result.artifacts[0]?.kind, 'video')
})

test('DashScope Qwen Audio 3 TTS uses the official WebSocket protocol', async (context) => {
  const server = new WebSocketServer({ port: 0 })
  await once(server, 'listening')
  context.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP test server address')
  const actions: string[] = []

  server.on('connection', (socket, request) => {
    assert.equal(request.headers.authorization, 'Bearer dash-test-key')
    socket.on('message', (raw, isBinary) => {
      assert.equal(isBinary, false)
      const message = JSON.parse(raw.toString()) as {
        header: { action: string; task_id: string }
        payload: { input?: { text?: string }; parameters?: { voice?: string } }
      }
      actions.push(message.header.action)
      if (message.header.action === 'run-task') {
        assert.equal(message.payload.parameters?.voice, 'longanhuan_v3.6')
        socket.send(JSON.stringify({ header: { event: 'task-started', task_id: message.header.task_id } }))
      } else if (message.header.action === 'continue-task') {
        assert.equal(message.payload.input?.text, '床前明月光')
      } else if (message.header.action === 'finish-task') {
        socket.send(Buffer.from('mock-mp3'), { binary: true })
        socket.send(JSON.stringify({ header: { event: 'task-finished', task_id: message.header.task_id } }))
      }
    })
  })

  const adapter = new DashScopeAdapter('qwencloud', `http://127.0.0.1:${address.port}`, deps(async () => {
    throw new Error('HTTP should not be used for Qwen Audio 3 TTS')
  }, { QWENCLOUD_API_KEY: 'dash-test-key' }))
  const result = await adapter.execute({
    capability: 'speech.tts', provider: 'qwencloud', model: 'qwen-audio-3.0-tts-plus', text: '床前明月光',
    providerOptions: { timeoutMs: 2_000 },
  }, {})
  assert.deepEqual(actions, ['run-task', 'continue-task', 'finish-task'])
  assert.equal(Buffer.from(result.artifacts[0]?.base64 ?? '', 'base64').toString(), 'mock-mp3')
  assert.equal(result.artifacts[0]?.mimeType, 'audio/mpeg')
})

test('DashScope TTS safely handles abort and timeout while connecting', async (context) => {
  const sockets: Socket[] = []
  const server = createServer(socket => sockets.push(socket))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => {
    for (const socket of sockets) socket.destroy()
    return new Promise<void>(resolve => server.close(() => resolve()))
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP test server address')
  const adapter = new DashScopeAdapter('qwencloud', `http://127.0.0.1:${address.port}`, deps(async () => {
    throw new Error('HTTP should not be used for Qwen Audio 3 TTS')
  }, { QWENCLOUD_API_KEY: 'dash-test-key' }))
  const request = {
    capability: 'speech.tts' as const, provider: 'qwencloud', model: 'qwen-audio-3.0-tts-plus', text: 'test',
    providerOptions: { timeoutMs: 20, connectTimeoutMs: 1_000 },
  }

  await assert.rejects(adapter.execute(request, {}), { code: 'TIMEOUT' })
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 20)
  await assert.rejects(adapter.execute({ ...request, providerOptions: { timeoutMs: 1_000, connectTimeoutMs: 1_000 } }, { signal: controller.signal }), { code: 'ABORTED' })
})

test('DashScope TTS rejects a pre-aborted signal before connecting', async () => {
  const controller = new AbortController()
  controller.abort()
  const adapter = new DashScopeAdapter('qwencloud', 'http://127.0.0.1:1', deps(async () => {
    throw new Error('HTTP should not be used for Qwen Audio 3 TTS')
  }, { QWENCLOUD_API_KEY: 'dash-test-key' }))
  await assert.rejects(adapter.execute({
    capability: 'speech.tts', provider: 'qwencloud', model: 'qwen-audio-3.0-tts-plus', text: 'test',
  }, { signal: controller.signal }), { code: 'ABORTED' })
})

test('DashScope honors requestTimeoutMs for synchronous image calls', async () => {
  const adapter = new DashScopeAdapter('dashscope', 'https://dashscope.aliyuncs.com', deps(async (_url, init) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 100)
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(init.signal?.reason)
      }, { once: true })
    })
    return Response.json({ output: { image_url: 'https://cdn.test/image.png' } })
  }, { DASHSCOPE_API_KEY: 'dash-test-key' }))
  await assert.rejects(adapter.execute({
    capability: 'image.text_to_image', provider: 'dashscope', model: 'qwen-image-3.0-pro', prompt: 'moon',
    providerOptions: { requestTimeoutMs: 5 },
  }, {}), { code: 'TIMEOUT' })
})

test('Vertex global location uses the unprefixed API endpoint', () => {
  assert.equal(vertexApiOrigin('global'), 'https://aiplatform.googleapis.com')
  assert.equal(vertexApiOrigin('us-central1'), 'https://us-central1-aiplatform.googleapis.com')
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
