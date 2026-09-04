import { ArtifactDownloader } from './artifacts.js'
import type { MediaConfig } from './config.js'
import { asMediaError, MediaError } from './errors.js'
import { HttpClient, type FetchLike } from './http.js'
import { InputResolver } from './input.js'
import type { AdapterContext, Capability, MediaRequest, ModelDescriptor, NormalizedResult, ProviderAdapter } from './types.js'
import { AtlasAdapter } from './adapters/atlas.js'
import { CustomOpenAICompatibleAdapter } from './adapters/custom.js'
import { DashScopeAdapter } from './adapters/dashscope.js'
import { FalAdapter } from './adapters/fal.js'
import { GoogleMediaAdapter } from './adapters/google.js'
import { OpenAIAdapter } from './adapters/openai.js'
import { OpenRouterAdapter } from './adapters/openrouter.js'
import { XAIAdapter } from './adapters/xai.js'

export interface RouterOptions {
  cwd: string
  config: MediaConfig
  env?: NodeJS.ProcessEnv
  fetch?: FetchLike
}

export class CapabilityRouter {
  private readonly adapters = new Map<string, ProviderAdapter>()
  private readonly downloader: ArtifactDownloader
  private readonly env: NodeJS.ProcessEnv
  private readonly providerDefaults: Record<string, Record<string, unknown>>

  constructor(options: RouterOptions) {
    const http = new HttpClient(options.fetch)
    const input = new InputResolver(http, options.cwd)
    const dependencies = { http, input, ...(options.env ? { env: options.env } : {}) }
    this.env = options.env ?? process.env
    this.providerDefaults = options.config.providerOptions ?? {}
    const builtins: ProviderAdapter[] = [
      new OpenRouterAdapter(dependencies),
      new FalAdapter(dependencies),
      new DashScopeAdapter('dashscope', 'https://dashscope.aliyuncs.com', dependencies),
      new DashScopeAdapter('qwencloud', 'https://dashscope-intl.aliyuncs.com', dependencies),
      new OpenAIAdapter(dependencies),
      new GoogleMediaAdapter('gemini', dependencies),
      new GoogleMediaAdapter('vertex', dependencies),
      new XAIAdapter(dependencies),
      new AtlasAdapter(dependencies),
      ...options.config.customProviders.map(provider => new CustomOpenAICompatibleAdapter(provider, dependencies)),
    ]
    for (const adapter of builtins) this.adapters.set(adapter.id, adapter)
    this.downloader = new ArtifactDownloader(http, options.config.outputDir)
  }

  private isConfigured(adapter: ProviderAdapter): boolean {
    if (adapter.id === 'vertex') {
      const vertexOpts = this.providerDefaults['vertex']
      if (typeof vertexOpts?.credentialsFile === 'string' && vertexOpts.credentialsFile.trim()) return true
      if (this.env.GOOGLE_APPLICATION_CREDENTIALS || this.env.VERTEX_CREDENTIALS_FILE) return true
      return false
    }
    const configKey = this.providerDefaults[adapter.id]?.apiKey
    if (typeof configKey === 'string' && configKey.trim()) return true
    if (adapter.envKey && this.env[adapter.envKey]) return true
    return false
  }

  list(provider?: string, capability?: Capability): Array<ModelDescriptor & { configured: boolean }> {
    const adapters = provider ? [this.adapters.get(provider)].filter((item): item is ProviderAdapter => Boolean(item)) : [...this.adapters.values()]
    return adapters.flatMap(adapter => adapter.models()
      .filter(model => !capability || model.capabilities.includes(capability))
      .map(model => ({ ...model, configured: this.isConfigured(adapter) })))
  }

  providers(): Array<{ id: string; name: string; configured: boolean; envKey?: string }> {
    return [...this.adapters.values()].map(adapter => ({
      id: adapter.id,
      name: adapter.displayName,
      configured: this.isConfigured(adapter),
      ...(adapter.envKey ? { envKey: adapter.envKey } : {}),
    }))
  }

  async execute(request: MediaRequest, context: AdapterContext = {}): Promise<NormalizedResult> {
    const adapter = this.adapters.get(request.provider)
    if (!adapter) throw new MediaError('CONFIG', `Unknown media provider: ${request.provider}`)
    const providerOptions = { ...(this.providerDefaults[request.provider] ?? {}), ...(request.providerOptions ?? {}) }
    const resolvedRequest: MediaRequest = { ...request, providerOptions }
    try {
      const result = await adapter.execute(resolvedRequest, context)
      const artifacts = await this.downloader.downloadAll(result.artifacts, context.signal)
      return {
        provider: result.provider,
        model: result.model,
        capability: result.capability,
        artifacts,
        warnings: result.warnings ?? [],
        ...(result.jobId ? { jobId: result.jobId } : {}),
        ...(result.text ? { text: result.text } : {}),
      }
    } catch (error) {
      throw asMediaError(error, adapter.id)
    }
  }
}
