import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CAPABILITIES, type Capability, type JsonObject } from './types.js'
import { MediaError } from './errors.js'

export function expandHomePath(rawPath: string | undefined): string | undefined {
  if (!rawPath) return undefined
  if (rawPath === '~') return homedir()
  if (rawPath.startsWith('~/') || rawPath.startsWith('~\\')) {
    return join(homedir(), rawPath.slice(2))
  }
  return rawPath
}

export interface CustomAsyncConfig {
  idPath: string
  statusPath: string
  pollEndpoint: string
  resultPath?: string
  cancelEndpoint?: string
  successValues?: string[]
  failureValues?: string[]
}

export interface CustomEndpointConfig {
  path: string
  method?: string
  format?: 'json' | 'multipart'
  async?: CustomAsyncConfig
}

export interface CustomModelConfig {
  id: string
  vendor: string
  capabilities: Capability[]
  endpoints: Partial<Record<Capability, string | CustomEndpointConfig>>
}

export interface CustomProviderConfig {
  id: string
  name?: string
  baseUrl: string
  apiKeyEnv: string
  auth?: 'bearer' | 'x-api-key' | 'none'
  headers?: Record<string, string>
  models: CustomModelConfig[]
}

export interface MediaConfig {
  outputDir?: string
  customProviders: CustomProviderConfig[]
  providerOptions?: Record<string, JsonObject>
}

const EMPTY_CONFIG: MediaConfig = { customProviders: [] }

async function parseFile(path: string): Promise<Partial<MediaConfig> | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected JSON object')
    return value as Partial<MediaConfig>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new MediaError('CONFIG', `Invalid media config ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

export async function loadMediaConfig(cwd: string, allowProjectConfig: boolean): Promise<MediaConfig> {
  const globalPath = join(homedir(), '.pi', 'agent', 'media-models.json')
  const global = await parseFile(globalPath) ?? EMPTY_CONFIG
  const project = allowProjectConfig ? await parseFile(join(cwd, '.pi', 'media-models.json')) : undefined
  const rawOutputDir = project?.outputDir ?? global.outputDir
  const expandedOutputDir = expandHomePath(rawOutputDir)
  const outputDir = expandedOutputDir ? resolve(cwd, expandedOutputDir) : undefined
  const providerOptions = { ...(global.providerOptions ?? {}), ...(project?.providerOptions ?? {}) }
  if (providerOptions.vertex) providerOptions.vertex = await resolveVertexProjectOptions(providerOptions.vertex)
  const merged: MediaConfig = {
    outputDir,
    customProviders: project?.customProviders ?? global.customProviders ?? [],
    providerOptions,
  }
  validateCustomProviders(merged.customProviders)
  return merged
}

export async function resolveVertexProjectOptions(options: JsonObject): Promise<JsonObject> {
  const configuredProject = typeof options.project === 'string' ? options.project.trim() : ''
  if (configuredProject && !isProjectPlaceholder(configuredProject)) return options
  if (typeof options.credentialsFile !== 'string' || !options.credentialsFile.trim()) return options
  const expanded = expandHomePath(options.credentialsFile)
  const credentialsFile = expanded?.startsWith('file://') ? fileURLToPath(expanded) : expanded
  if (!credentialsFile) return options
  try {
    const credentials = JSON.parse(await readFile(credentialsFile, 'utf8')) as { project_id?: unknown }
    return typeof credentials.project_id === 'string' && credentials.project_id.trim()
      ? { ...options, project: credentials.project_id.trim() }
      : options
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return options
    throw new MediaError('CONFIG', `Invalid Vertex credentials ${credentialsFile}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

function isProjectPlaceholder(value: string): boolean {
  return /^(?:my-gcp-project|your[-_ ]?(?:gcp[-_ ])?project(?:[-_ ]?id)?|<.*>)$/i.test(value)
}

function validateCustomProviders(providers: CustomProviderConfig[]): void {
  const ids = new Set<string>()
  for (const provider of providers) {
    if (!provider.id || !provider.baseUrl || !provider.apiKeyEnv || !Array.isArray(provider.models)) {
      throw new MediaError('CONFIG', 'Each custom provider requires id, baseUrl, apiKeyEnv, and models[]')
    }
    if (ids.has(provider.id)) throw new MediaError('CONFIG', `Duplicate custom provider id: ${provider.id}`)
    ids.add(provider.id)
    if (['openrouter', 'fal', 'dashscope', 'qwencloud', 'openai', 'gemini', 'vertex', 'xai', 'atlas'].includes(provider.id)) {
      throw new MediaError('CONFIG', `Custom provider id conflicts with built-in provider: ${provider.id}`)
    }
    for (const model of provider.models) {
      if (!model.id || !model.vendor || !model.capabilities?.length || !model.endpoints) {
        throw new MediaError('CONFIG', `Custom provider ${provider.id} model requires id, vendor, capabilities, endpoints`)
      }
      for (const capability of model.capabilities) {
        if (!(CAPABILITIES as readonly string[]).includes(capability)) throw new MediaError('CONFIG', `Unknown capability ${capability} in ${provider.id}/${model.id}`)
        if (!model.endpoints[capability]) throw new MediaError('CONFIG', `${provider.id}/${model.id} declares ${capability} without an endpoint`)
      }
    }
  }
}
