import { loadMediaConfig } from '../src/config.js'
import { CapabilityRouter } from '../src/router.js'
import { asMediaError } from '../src/errors.js'
import type { MediaRequest } from '../src/types.js'

if (process.env.PI_MEDIA_ALLOW_PAID_TESTS !== '1') {
  throw new Error('Live paid smoke tests are disabled. Set PI_MEDIA_ALLOW_PAID_TESTS=1 explicitly.')
}

const config = await loadMediaConfig(process.cwd(), false)
const router = new CapabilityRouter({ cwd: process.cwd(), config })

const cases: Array<{ name: string; env: string; request: MediaRequest }> = [
  {
    name: 'fal image queue + download',
    env: 'FAL_KEY',
    request: {
      capability: 'image.text_to_image', provider: 'fal', model: 'fal-ai/flux/schnell',
      prompt: 'A minimal blue circle centered on a plain white background',
      resolution: 'square_hd', count: 1,
    },
  },
  {
    name: 'Atlas documented image generation + download',
    env: 'ATLAS_API_KEY',
    request: {
      capability: 'image.text_to_image', provider: 'atlas', model: 'gpt-image-2-1k',
      prompt: 'A minimal blue circle centered on a plain white background',
      aspectRatio: '1:1', quality: 'standard', providerOptions: { async: false },
    },
  },
  {
    name: 'DashScope Qwen image + download',
    env: 'DASHSCOPE_API_KEY',
    request: {
      capability: 'image.text_to_image', provider: 'dashscope', model: 'qwen-image-3.0-pro',
      prompt: 'A minimal blue circle centered on a plain white background',
      resolution: '1024*1024', providerOptions: { watermark: false },
    },
  },
  {
    name: 'QwenCloud Qwen Audio 3 TTS WebSocket + download',
    env: 'QWENCLOUD_API_KEY',
    request: {
      capability: 'speech.tts', provider: 'qwencloud', model: 'qwen-audio-3.0-tts-plus',
      text: 'Media model smoke test.', voice: 'longanlingxin', language: 'en', responseFormat: 'mp3',
    },
  },
  {
    name: 'Vertex ADC JSON image + download',
    env: 'VERTEX_CREDENTIALS_FILE',
    request: {
      capability: 'image.text_to_image', provider: 'vertex', model: 'gemini-3.1-flash-image',
      prompt: 'A minimal blue circle centered on a plain white background',
      aspectRatio: '1:1', count: 1,
    },
  },
]

const selected = new Set((process.env.PI_MEDIA_SMOKE_PROVIDERS ?? '').split(',').map(value => value.trim()).filter(Boolean))
let failures = 0
for (const item of cases) {
  if (selected.size && !selected.has(item.request.provider)) continue
  const configured = config.providerOptions?.[item.request.provider]
  const configuredKey = configured?.apiKey
  const vertexConfigured = item.request.provider === 'vertex' && Boolean(configured?.credentialsFile || configured?.project || process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.GOOGLE_CLOUD_PROJECT)
  if (!process.env[item.env] && typeof configuredKey !== 'string' && !vertexConfigured) {
    console.log(`SKIP ${item.name}: ${item.env} or providerOptions.${item.request.provider}.apiKey is not set`)
    continue
  }
  try {
    const result = await router.execute(item.request, {
      onProgress: message => console.log(`  ${message}`),
    })
    console.log(`PASS ${item.name}: ${result.artifacts.map(artifact => artifact.path).join(', ') || 'text result'}`)
  } catch (error) {
    failures += 1
    const normalized = asMediaError(error, item.request.provider)
    console.error(`FAIL ${item.name}: [${normalized.code}] ${normalized.message}`)
  }
}

if (failures) process.exitCode = 1
