import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import * as Type from 'typebox/type'
import { loadMediaConfig } from './config.js'
import { MediaError } from './errors.js'
import { CapabilityRouter } from './router.js'
import { CAPABILITIES, type Capability, type JsonObject, type MediaRequest, type NormalizedResult } from './types.js'

const providerModel = {
  provider: Type.String({ minLength: 1, description: 'Provider id or configured custom provider' }),
  model: Type.Optional(Type.String({ minLength: 1, description: 'Exact model id; omit for discovery.' })),
}
const capabilitySchema = Type.Union(CAPABILITIES.map(capability => Type.Literal(capability)))
const providerOptions = Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: 'Native fields only; credentials and normalized aliases are rejected.' }))
const commonOutput = {
  resolution: Type.Optional(Type.String()),
  aspectRatio: Type.Optional(Type.String()),
  seed: Type.Optional(Type.Integer()),
  providerOptions,
}
const imageOutput = {
  ...commonOutput,
  background: Type.Optional(Type.Union([Type.Literal('auto'), Type.Literal('opaque'), Type.Literal('transparent')])),
  outputFormat: Type.Optional(Type.String({ description: 'Provider-supported output format, such as png, webp, or jpeg.' })),
  quality: Type.Optional(Type.String({ description: 'Provider-native quality preset.' })),
  compression: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
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

type ToolMediaRequest = Omit<MediaRequest, 'model'> & { model?: string }

async function executeRequest(request: ToolMediaRequest, signal: AbortSignal | undefined, onUpdate: Parameters<Parameters<ExtensionAPI['registerTool']>[0]['execute']>[3], ctx: ExtensionContext) {
  const router = await routerFor(ctx)
  if (!request.model) progress(onUpdate as never, `Discovering the newest usable ${request.capability} model for ${request.provider}…`)
  const model = request.model?.trim() || await router.defaultModel(request.provider, request.capability, signal ? { signal } : {})
  const resolvedRequest: MediaRequest = { ...request, model }
  progress(onUpdate as never, `Starting ${request.capability} with ${request.provider}/${model}…`)
  const result = await router.execute(resolvedRequest, {
    ...(signal ? { signal } : {}),
    onProgress: message => progress(onUpdate as never, message),
  })
  return { content: [{ type: 'text' as const, text: concise(result) }], details: result }
}

export function registerMediaTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'media_models',
    label: 'Media Models',
    description: 'Discover models visible to configured provider credentials, optionally probe capability access, and mark the newest usable model as default. Falls back to built-in candidates when a provider has no discovery API.',
    promptSnippet: 'Discover available media providers/models/capabilities before choosing a model',
    parameters: Type.Object({
      provider: Type.Optional(Type.String()),
      capability: Type.Optional(capabilitySchema),
      probe: Type.Optional(Type.Boolean({ description: 'Run lightweight capability probes when supported. Defaults to true.' })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const router = await routerFor(ctx)
      const capability = params.capability as Capability | undefined
      progress(onUpdate as never, 'Discovering models from configured providers…')
      const models = await router.discover(params.provider, capability, { ...(signal ? { signal } : {}), probe: params.probe !== false })
      const providers = router.providers()
      const text = models.length
        ? models.map(model => `${model.provider}/${model.id} [${model.availability}; source=${model.source}; configured=${model.configured}${model.isDefault ? '; default=newest' : ''}] ${model.capabilities.join(', ')}${model.notes ? ` · ${model.notes}` : ''}`).join('\n')
        : 'No matching media models were discovered.'
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
      prompt: Type.String({ minLength: 1 }),
      inputImage: Type.Optional(Type.String()),
      referenceImages: Type.Optional(Type.Array(Type.String())),
      count: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
      ...imageOutput,
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
      prompt: Type.String({ minLength: 1 }),
      inputImage: Type.String({ minLength: 1 }),
      referenceImages: Type.Optional(Type.Array(Type.String())),
      mask: Type.Optional(Type.String()),
      count: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
      ...imageOutput,
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
      prompt: Type.String({ minLength: 1 }),
      inputImage: Type.Optional(Type.String()),
      endImage: Type.Optional(Type.String()),
      referenceImages: Type.Optional(Type.Array(Type.String())),
      referenceVideos: Type.Optional(Type.Array(Type.String())),
      referenceAudios: Type.Optional(Type.Array(Type.String())),
      referenceAudioVoices: Type.Optional(Type.Array(Type.String({ description: 'Provider preset voice IDs; currently used by xAI reference-to-video.' }))),
      inputVideo: Type.Optional(Type.String()),
      duration: Type.Optional(Type.Integer({ minimum: -1, description: 'Seconds; Wan 3 also accepts -1 for smart duration.' })),
      resolution: Type.Optional(Type.String()),
      aspectRatio: Type.Optional(Type.String()),
      seed: Type.Optional(Type.Integer()),
      generateAudio: Type.Optional(Type.Boolean()),
      operation: Type.Optional(Type.Union([
        Type.Literal('generate'), Type.Literal('reference'), Type.Literal('edit'), Type.Literal('extend'),
      ], { description: 'Omit for automatic mapping.' })),
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
      prompt: Type.String({ minLength: 1 }),
      text: Type.Optional(Type.String({ minLength: 1, description: 'Optional lyrics or secondary text input' })),
      inputAudio: Type.Optional(Type.String()),
      duration: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
      outputFormat: Type.Optional(Type.String()),
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
      operation: Type.Union([Type.Literal('tts'), Type.Literal('stt'), Type.Literal('transcribe')]),
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

export function videoCapability(params: {
  operation?: string
  inputImage?: string
  endImage?: string
  inputVideo?: string
  referenceImages?: string[]
  referenceVideos?: string[]
  referenceAudios?: string[]
  referenceAudioVoices?: string[]
}): Capability {
  const operation = params.operation?.toLowerCase()
  const hasReferences = Boolean(params.referenceImages?.length || params.referenceVideos?.length || params.referenceAudios?.length || params.referenceAudioVoices?.length)
  if (params.endImage && !params.inputImage) throw new MediaError('INPUT', 'endImage requires inputImage')
  if (params.inputVideo && (hasReferences || params.inputImage || params.endImage)) {
    throw new MediaError('INPUT', 'inputVideo cannot be combined with frame or reference inputs')
  }
  if (operation === 'edit' || operation === 'extend') {
    if (!params.inputVideo) throw new MediaError('INPUT', `video ${operation} requires inputVideo`)
    if (hasReferences || params.inputImage || params.endImage) throw new MediaError('INPUT', `video ${operation} cannot be combined with frame or reference inputs`)
    return operation === 'edit' ? 'video.edit' : 'video.extend'
  }
  if (operation === 'reference') {
    if (!hasReferences) throw new MediaError('INPUT', 'video reference operation requires at least one reference')
    if (params.inputVideo || params.inputImage || params.endImage) throw new MediaError('INPUT', 'video reference operation cannot be combined with input video or frame inputs')
    return 'video.reference'
  }
  if (operation === 'generate' && (params.inputVideo || hasReferences)) {
    throw new MediaError('INPUT', 'video generate cannot be combined with inputVideo or reference inputs; omit operation for automatic mapping')
  }
  if (params.inputVideo) return 'video.edit'
  if (hasReferences) return 'video.reference'
  if (params.endImage) return 'video.first_last_frame'
  if (params.inputImage) return 'video.image_to_video'
  return 'video.text_to_video'
}
