import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { loadMediaConfig } from './config.js'
import { MediaError } from './errors.js'
import { CapabilityRouter } from './router.js'
import type { Capability, JsonObject, MediaRequest, NormalizedResult } from './types.js'

const providerModel = {
  provider: Type.String({ description: 'Provider id: openrouter, fal, dashscope, qwencloud, openai, gemini, vertex, xai, atlas, or an explicitly configured custom provider' }),
  model: Type.String({ description: 'Exact provider model id or fal endpoint slug' }),
}
const providerOptions = Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: 'Provider-native options. These override normalized mappings; never include API keys.' }))
const commonOutput = {
  resolution: Type.Optional(Type.String()),
  aspectRatio: Type.Optional(Type.String()),
  seed: Type.Optional(Type.Integer()),
  providerOptions,
}

async function routerFor(ctx: ExtensionContext): Promise<CapabilityRouter> {
  const config = await loadMediaConfig(ctx.cwd, ctx.isProjectTrusted())
  return new CapabilityRouter({ cwd: ctx.cwd, config })
}

function progress(onUpdate: ((result: { content: Array<{ type: 'text'; text: string }>; details?: unknown }) => void) | undefined, message: string): void {
  onUpdate?.({ content: [{ type: 'text', text: message }] })
}

function concise(result: NormalizedResult): string {
  const lines = [`${result.provider}/${result.model} · ${result.capability}`]
  if (result.artifacts.length) lines.push(...result.artifacts.map(artifact => `Saved ${artifact.kind}: ${artifact.path}`))
  if (result.text) lines.push(result.text)
  if (result.jobId) lines.push(`Job: ${result.jobId}`)
  if (result.warnings.length) lines.push(`Warnings: ${result.warnings.join('; ')}`)
  return lines.join('\n')
}

async function executeRequest(request: MediaRequest, signal: AbortSignal | undefined, onUpdate: Parameters<Parameters<ExtensionAPI['registerTool']>[0]['execute']>[3], ctx: ExtensionContext) {
  const router = await routerFor(ctx)
  progress(onUpdate as never, `Starting ${request.capability} with ${request.provider}/${request.model}…`)
  const result = await router.execute(request, {
    ...(signal ? { signal } : {}),
    onProgress: message => progress(onUpdate as never, message),
  })
  return { content: [{ type: 'text' as const, text: concise(result) }], details: result }
}

export function registerMediaTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'media_models',
    label: 'Media Models',
    description: 'List media providers and explicitly known/configured model capabilities. Does not infer custom capabilities from GET /models.',
    promptSnippet: 'List available media providers/models/capabilities before choosing a model',
    parameters: Type.Object({
      provider: Type.Optional(Type.String()),
      capability: Type.Optional(Type.String()),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const router = await routerFor(ctx)
      const capability = params.capability as Capability | undefined
      const models = router.list(params.provider, capability)
      const providers = router.providers()
      const text = models.length
        ? models.map(model => `${model.provider}/${model.id} [vendor=${model.vendor}; configured=${model.configured}] ${model.capabilities.join(', ')}`).join('\n')
        : 'No matching declared media models.'
      return { content: [{ type: 'text', text }], details: { providers, models } }
    },
  })

  pi.registerTool({
    name: 'image_generate',
    label: 'Generate Image',
    description: 'Generate an image from text or reference image(s). Inputs accept local paths, file://, http(s) URLs, and data URIs. Results are downloaded automatically.',
    promptSnippet: 'Generate images through the provider-neutral media router',
    parameters: Type.Object({
      ...providerModel,
      prompt: Type.String(),
      inputImage: Type.Optional(Type.String()),
      referenceImages: Type.Optional(Type.Array(Type.String())),
      count: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
      ...commonOutput,
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const references = params.referenceImages ?? []
      const capability: Capability = references.length + (params.inputImage ? 1 : 0) > 1
        ? 'image.multi_reference'
        : params.inputImage || references.length ? 'image.image_to_image' : 'image.text_to_image'
      return executeRequest({ ...params, capability, providerOptions: params.providerOptions as JsonObject | undefined }, signal, onUpdate, ctx)
    },
  })

  pi.registerTool({
    name: 'image_edit',
    label: 'Edit Image',
    description: 'Edit one or more images with an optional mask. Inputs accept local paths, file://, http(s) URLs, and data URIs. Results are downloaded automatically.',
    promptSnippet: 'Edit images through the provider-neutral media router',
    parameters: Type.Object({
      ...providerModel,
      prompt: Type.String(),
      inputImage: Type.String(),
      referenceImages: Type.Optional(Type.Array(Type.String())),
      mask: Type.Optional(Type.String()),
      count: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
      ...commonOutput,
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const capability: Capability = params.referenceImages?.length ? 'image.multi_reference' : 'image.edit'
      return executeRequest({ ...params, capability, providerOptions: params.providerOptions as JsonObject | undefined }, signal, onUpdate, ctx)
    },
  })

  pi.registerTool({
    name: 'video_generate',
    label: 'Generate Video',
    description: 'Unified video generation/edit/extension tool. Automatically maps text, first/end frames, references, and input video to the provider capability; downloads temporary results immediately.',
    promptSnippet: 'Generate, edit, or extend video through the provider-neutral media router',
    parameters: Type.Object({
      ...providerModel,
      prompt: Type.String(),
      inputImage: Type.Optional(Type.String()),
      endImage: Type.Optional(Type.String()),
      referenceImages: Type.Optional(Type.Array(Type.String())),
      referenceVideos: Type.Optional(Type.Array(Type.String())),
      referenceAudios: Type.Optional(Type.Array(Type.String())),
      inputVideo: Type.Optional(Type.String()),
      duration: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
      resolution: Type.Optional(Type.String()),
      aspectRatio: Type.Optional(Type.String()),
      seed: Type.Optional(Type.Integer()),
      generateAudio: Type.Optional(Type.Boolean()),
      operation: Type.Optional(Type.String({ description: 'generate, reference, edit, or extend; omitted for automatic mapping' })),
      providerOptions,
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const capability = videoCapability(params)
      return executeRequest({ ...params, capability, providerOptions: params.providerOptions as JsonObject | undefined }, signal, onUpdate, ctx)
    },
  })

  pi.registerTool({
    name: 'audio_generate',
    label: 'Generate Audio',
    description: 'Generate music or model-native audio from a prompt. This is separate from TTS and downloads the result automatically.',
    promptSnippet: 'Generate music or audio through the provider-neutral media router',
    parameters: Type.Object({
      ...providerModel,
      prompt: Type.String(),
      text: Type.Optional(Type.String({ description: 'Optional lyrics or secondary text input' })),
      inputAudio: Type.Optional(Type.String()),
      duration: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
      seed: Type.Optional(Type.Integer()),
      providerOptions,
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      return executeRequest({ ...params, capability: 'audio.generate', providerOptions: params.providerOptions as JsonObject | undefined }, signal, onUpdate, ctx)
    },
  })

  pi.registerTool({
    name: 'speech_generate',
    label: 'Speech',
    description: 'Run provider-supported TTS or STT. Use operation="tts" with text, or operation="stt" with inputAudio. Generated audio is downloaded; STT returns concise text.',
    promptSnippet: 'Synthesize speech or transcribe audio through the provider-neutral media router',
    parameters: Type.Object({
      ...providerModel,
      operation: Type.String({ description: 'tts or stt' }),
      text: Type.Optional(Type.String()),
      inputAudio: Type.Optional(Type.String()),
      prompt: Type.Optional(Type.String()),
      voice: Type.Optional(Type.String()),
      language: Type.Optional(Type.String()),
      responseFormat: Type.Optional(Type.String()),
      providerOptions,
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const operation = params.operation.toLowerCase()
      if (!['tts', 'stt', 'transcribe'].includes(operation)) throw new MediaError('INPUT', 'speech_generate operation must be tts or stt')
      const capability: Capability = operation === 'tts' ? 'speech.tts' : 'speech.stt'
      if (capability === 'speech.tts' && !params.text && !params.prompt) throw new MediaError('INPUT', 'TTS requires text')
      if (capability === 'speech.stt' && !params.inputAudio) throw new MediaError('INPUT', 'STT requires inputAudio')
      return executeRequest({ ...params, capability, providerOptions: params.providerOptions as JsonObject | undefined }, signal, onUpdate, ctx)
    },
  })
}

function videoCapability(params: {
  operation?: string
  inputImage?: string
  endImage?: string
  inputVideo?: string
  referenceImages?: string[]
  referenceVideos?: string[]
  referenceAudios?: string[]
}): Capability {
  const operation = params.operation?.toLowerCase()
  if (operation === 'edit') return 'video.edit'
  if (operation === 'extend') return 'video.extend'
  if (operation === 'reference') return 'video.reference'
  if (operation && operation !== 'generate') throw new MediaError('INPUT', 'video_generate operation must be generate, reference, edit, or extend')
  if (params.inputVideo) return 'video.edit'
  if (params.referenceImages?.length || params.referenceVideos?.length || params.referenceAudios?.length) return 'video.reference'
  if (params.endImage) return 'video.first_last_frame'
  if (params.inputImage) return 'video.image_to_video'
  return 'video.text_to_video'
}
