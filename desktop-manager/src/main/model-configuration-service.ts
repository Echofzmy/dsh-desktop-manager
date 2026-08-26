import { chmod, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  SaveUnifiedConfigurationInput,
  SetUnifiedCredentialInput,
  UnifiedConfiguration,
  UnifiedModelProfile,
  UnifiedProviderProfile,
  UnifiedProviderProtocol,
} from '../shared/types.js'
import {
  ModelSettingsProjection,
  atomicWrite,
  parseSettings,
  readOptional,
  withSettingsLock,
} from './model-settings-projection.js'

const SETTINGS_LOCK_WAIT_MS = 2_000
const CREDENTIAL_LOCK_WAIT_MS = 30_000
const DEEPSEEK_PROVIDER = 'deepseek-official'
const DEEPSEEK_REF = 'DEEPSEEK_API_KEY'
const ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const CREDENTIAL_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const RESERVED_CREDENTIAL_REFS = new Set(['DSH_HOME', 'ELECTRON_RUN_AS_NODE'])
const PROTOCOLS = new Set<UnifiedProviderProtocol>(['openai-completions', 'openai-responses', 'anthropic-messages'])
const REASONING_EFFORTS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const DEFAULT_DEEPSEEK_MODELS: UnifiedModelProfile[] = [
  { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', contextWindow: 1_000_000 },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: 1_000_000 },
  { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek-V4-Flash-Vision-Exp', contextWindow: 1_000_000 },
]

function recordOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function deriveCredentialRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

function modelsOf(value: unknown, fallback: UnifiedModelProfile[] = []): UnifiedModelProfile[] {
  if (!Array.isArray(value)) return fallback.map(model => ({ ...model }))
  return value.map((item) => {
    const model = recordOf(item)
    return {
      id: typeof model.id === 'string' ? model.id : '',
      ...typeof model.name === 'string' ? { name: model.name } : {},
      ...typeof model.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {},
      ...typeof model.maxTokens === 'number' ? { maxTokens: model.maxTokens } : {},
    }
  })
}

function mergeModels(existing: unknown, drafts: UnifiedModelProfile[]): Record<string, unknown>[] {
  const previous = Array.isArray(existing) ? existing.map(recordOf) : []
  return drafts.map((draft, index) => {
    const exact = previous.find(model => model.id === draft.id)
    const model = { ...(exact ?? previous[index] ?? {}) }
    model.id = draft.id
    if (draft.name === undefined) delete model.name
    else model.name = draft.name
    if (draft.contextWindow === undefined) delete model.contextWindow
    else model.contextWindow = draft.contextWindow
    if (draft.maxTokens === undefined) delete model.maxTokens
    else model.maxTokens = draft.maxTokens
    return model
  })
}

function assertCredentialRef(value: string): void {
  if (!CREDENTIAL_PATTERN.test(value) || RESERVED_CREDENTIAL_REFS.has(value.toUpperCase())) throw new Error('API Key 引用无效。')
}

function validateModels(models: UnifiedModelProfile[], requireOne: boolean): UnifiedModelProfile[] {
  if (models.length > 100 || (requireOne && models.length === 0)) throw new Error(requireOne ? '自定义提供方至少需要一个模型。' : '模型数量过多。')
  const seen = new Set<string>()
  return models.map((model) => {
    const id = model.id.trim()
    if (!id || id.length > 200 || seen.has(id)) throw new Error(!id ? '模型 ID 不能为空。' : `模型 ID 重复或过长：${id}`)
    seen.add(id)
    const name = model.name?.trim()
    if (name !== undefined && !name) throw new Error(`模型 ${id} 的名称不能为空。`)
    for (const value of [model.contextWindow, model.maxTokens]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error(`模型 ${id} 的容量必须是正整数。`)
    }
    return {
      id,
      ...name === undefined ? {} : { name },
      ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
    }
  })
}

function validateInput(input: SaveUnifiedConfigurationInput): SaveUnifiedConfigurationInput {
  if (!input || typeof input !== 'object' || !Array.isArray(input.providers)) throw new Error('统一配置数据无效。')
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(input.defaultPermission)) throw new Error('默认权限无效。')
  if (!['system', 'zh', 'en'].includes(input.locale)) throw new Error('语言设置无效。')
  if (!['system', 'light', 'dark'].includes(input.theme)) throw new Error('外观设置无效。')
  if (!['steer', 'queue'].includes(input.busyEnter)) throw new Error('忙碌时 Enter 行为无效。')
  if (input.defaultReasoningEffort !== undefined && !REASONING_EFFORTS.has(input.defaultReasoningEffort)) throw new Error('默认思考深度无效。')
  const defaultAgentPreset = input.defaultAgentPreset.trim()
  if (!defaultAgentPreset || defaultAgentPreset.length > 128) throw new Error('默认 Agent preset 无效。')
  const ids = new Set<string>()
  const providers = input.providers.map((provider) => {
    const id = provider.id.trim()
    if ((provider.kind === 'deepseek' && id !== DEEPSEEK_PROVIDER) || (provider.kind === 'custom' && !ROUTE_PATTERN.test(id))) throw new Error(`提供方 ID 无效：${id}`)
    if (ids.has(id)) throw new Error(`提供方 ID 重复：${id}`)
    ids.add(id)
    const displayName = provider.displayName.trim()
    if (!displayName || displayName.length > 100) throw new Error(`提供方名称无效：${id}`)
    const apiKeyRef = provider.apiKeyRef.trim()
    assertCredentialRef(apiKeyRef)
    if (provider.kind === 'deepseek' && provider.protocol !== 'deepseek') throw new Error('DeepSeek 提供方协议无效。')
    if (provider.kind !== 'deepseek' && !PROTOCOLS.has(provider.protocol)) throw new Error(`提供方协议无效：${id}`)
    const baseURL = provider.baseURL?.trim()
    if (provider.kind === 'custom' && !baseURL) throw new Error(`提供方 ${displayName} 需要 Base URL。`)
    if (baseURL) {
      let url: URL
      try { url = new URL(baseURL) } catch { throw new Error(`提供方 ${displayName} 的 Base URL 无效。`) }
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`提供方 ${displayName} 的 Base URL 必须使用 HTTP 或 HTTPS。`)
    }
    for (const [label, value] of [['请求超时', provider.timeoutMs], ['流空闲超时', provider.streamIdleTimeoutMs]] as const) {
      if (value !== undefined && value !== null && (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647)) throw new Error(`${displayName} 的${label}无效。`)
    }
    return {
      ...provider,
      id,
      displayName,
      apiKeyRef,
      ...(baseURL ? { baseURL } : {}),
      models: validateModels(provider.models, provider.kind === 'custom'),
    }
  })
  if (!ids.has(DEEPSEEK_PROVIDER)) throw new Error('统一配置必须保留 DeepSeek 提供方。')
  const defaultModel = input.defaultModel === undefined ? undefined : {
    provider: input.defaultModel.provider.trim(),
    model: input.defaultModel.model.trim(),
  }
  if (defaultModel) {
    const provider = providers.find(candidate => candidate.id === defaultModel.provider)
    if (!provider || !defaultModel.model) throw new Error('默认模型必须指向已配置的提供方。')
    if (provider.models.length > 0 && !provider.models.some(model => model.id === defaultModel.model)) throw new Error('默认模型不在提供方的模型列表中。')
  }
  const { defaultModel: _rawDefaultModel, ...rest } = input
  return { ...rest, providers, defaultAgentPreset, ...(defaultModel ? { defaultModel } : {}) }
}

async function assertOwnerOnly(path: string): Promise<void> {
  try {
    const mode = (await stat(path)).mode
    if (process.platform !== 'win32' && (mode & 0o077) !== 0) throw new Error('共享凭据文件权限必须为 0600。')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export class ModelConfigurationService {
  readonly #projection: ModelSettingsProjection

  constructor(projection: ModelSettingsProjection) {
    this.#projection = projection
  }

  async read(): Promise<UnifiedConfiguration> {
    const settingsText = await readOptional(join(this.#projection.home, 'settings.yaml')) ?? '{}\n'
    const settings = recordOf(parseSettings(settingsText, '共享设置').toJS())
    const credentialRefs = await this.#credentialRefs()
    const deepseek = recordOf(settings['llm-deepseek'])
    const deepseekRef = optionalString(deepseek.apiKeyEnv) ?? DEEPSEEK_REF
    const providers: UnifiedProviderProfile[] = [{
      id: DEEPSEEK_PROVIDER,
      kind: 'deepseek',
      displayName: 'DeepSeek',
      protocol: 'deepseek',
      apiKeyRef: deepseekRef,
      hasApiKey: credentialRefs.has(deepseekRef),
      ...(optionalString(deepseek.baseURL) ? { baseURL: optionalString(deepseek.baseURL)! } : {}),
      ...(typeof deepseek.timeoutMs === 'number' ? { timeoutMs: deepseek.timeoutMs } : {}),
      ...(typeof deepseek.streamIdleTimeoutMs === 'number' ? { streamIdleTimeoutMs: deepseek.streamIdleTimeoutMs } : {}),
      models: modelsOf(deepseek.models, DEFAULT_DEEPSEEK_MODELS),
    }]
    const piProviders = recordOf(recordOf(settings['llm-pi-ai']).providers)
    for (const [id, raw] of Object.entries(piProviders)) {
      const profile = recordOf(raw)
      const protocol = optionalString(profile.api) ?? 'openai-completions'
      if (!PROTOCOLS.has(protocol as UnifiedProviderProtocol)) throw new Error(`提供方 ${id} 使用当前管理器不支持的协议：${protocol}`)
      const ref = optionalString(profile.apiKeyEnv) ?? deriveCredentialRef(id)
      const declared = profile.api !== undefined && profile.baseURL !== undefined && Array.isArray(profile.models)
      providers.push({
        id,
        kind: declared ? 'custom' : 'catalog',
        displayName: optionalString(profile.displayName) ?? id,
        protocol: protocol as UnifiedProviderProtocol,
        apiKeyRef: ref,
        hasApiKey: credentialRefs.has(ref),
        ...(optionalString(profile.baseURL) ? { baseURL: optionalString(profile.baseURL)! } : {}),
        ...(typeof profile.timeoutMs === 'number' ? { timeoutMs: profile.timeoutMs } : {}),
        ...(typeof profile.streamIdleTimeoutMs === 'number' ? { streamIdleTimeoutMs: profile.streamIdleTimeoutMs } : {}),
        models: modelsOf(profile.models),
      })
    }
    const defaultModel = recordOf(settings['agent-default-model'])
    return {
      providers,
      ...optionalString(defaultModel.provider) && optionalString(defaultModel.model)
        ? { defaultModel: { provider: defaultModel.provider as string, model: defaultModel.model as string } }
        : {},
      ...(typeof defaultModel.reasoningEffort === 'string' && REASONING_EFFORTS.has(defaultModel.reasoningEffort) ? { defaultReasoningEffort: defaultModel.reasoningEffort as NonNullable<UnifiedConfiguration['defaultReasoningEffort']> } : {}),
      defaultPermission: (optionalString(recordOf(settings.permission).defaultPreset) ?? 'workspace-write') as UnifiedConfiguration['defaultPermission'],
      defaultAgentPreset: optionalString(recordOf(settings['agent-presets']).default) ?? 'standard',
      locale: (optionalString(recordOf(settings.locale).preference) ?? 'system') as UnifiedConfiguration['locale'],
      theme: (optionalString(recordOf(settings['ui-theme']).preference) ?? 'system') as UnifiedConfiguration['theme'],
      busyEnter: (optionalString(recordOf(settings['ui-conversation']).busyEnter) ?? 'queue') as UnifiedConfiguration['busyEnter'],
    }
  }

  async save(raw: SaveUnifiedConfigurationInput): Promise<UnifiedConfiguration> {
    const input = validateInput(raw)
    const credentialRefs = await this.#credentialRefs()
    const path = join(this.#projection.home, 'settings.yaml')
    await withSettingsLock(path, async () => {
      const currentText = await readOptional(path) ?? '{}\n'
      const document = parseSettings(currentText, '共享设置')
      const current = recordOf(document.toJS())
      const deepseekInput = input.providers.find(provider => provider.kind === 'deepseek')!
      const deepseek = { ...recordOf(current['llm-deepseek']) }
      deepseek.apiKeyEnv = deepseekInput.apiKeyRef
      if (deepseekInput.baseURL) deepseek.baseURL = deepseekInput.baseURL
      else delete deepseek.baseURL
      if (deepseekInput.timeoutMs === null) delete deepseek.timeoutMs
      else if (deepseekInput.timeoutMs !== undefined) deepseek.timeoutMs = deepseekInput.timeoutMs
      if (deepseekInput.streamIdleTimeoutMs === null) delete deepseek.streamIdleTimeoutMs
      else if (deepseekInput.streamIdleTimeoutMs !== undefined) deepseek.streamIdleTimeoutMs = deepseekInput.streamIdleTimeoutMs
      deepseek.models = mergeModels(deepseek.models, deepseekInput.models)
      document.setIn(['llm-deepseek'], deepseek)

      const previousPi = recordOf(recordOf(current['llm-pi-ai']).providers)
      const nextPi: Record<string, unknown> = {}
      for (const provider of input.providers.filter(item => item.kind !== 'deepseek')) {
        const previous = recordOf(previousPi[provider.id])
        const existingRef = optionalString(previous.apiKeyEnv)
        const profile: Record<string, unknown> = {
          ...previous,
          displayName: provider.displayName,
        }
        if (provider.kind === 'custom') {
          profile.api = provider.protocol
          profile.baseURL = provider.baseURL
          profile.models = mergeModels(previous.models, provider.models)
        } else {
          if (provider.baseURL === undefined) delete profile.baseURL
          else profile.baseURL = provider.baseURL
          if (provider.models.length === 0) delete profile.models
          else profile.models = mergeModels(previous.models, provider.models)
        }
        if (provider.timeoutMs === null) delete profile.timeoutMs
        else if (provider.timeoutMs !== undefined) profile.timeoutMs = provider.timeoutMs
        if (provider.streamIdleTimeoutMs === null) delete profile.streamIdleTimeoutMs
        else if (provider.streamIdleTimeoutMs !== undefined) profile.streamIdleTimeoutMs = provider.streamIdleTimeoutMs
        if (existingRef !== undefined || credentialRefs.has(provider.apiKeyRef)) profile.apiKeyEnv = provider.apiKeyRef
        else delete profile.apiKeyEnv
        nextPi[provider.id] = profile
      }
      document.setIn(['llm-pi-ai', 'providers'], nextPi)
      const previousDefaultModel = recordOf(current['agent-default-model'])
      if (input.defaultModel) {
        const nextDefaultModel: Record<string, unknown> = { ...previousDefaultModel, ...input.defaultModel }
        if (input.defaultReasoningEffort === undefined) delete nextDefaultModel.reasoningEffort
        else nextDefaultModel.reasoningEffort = input.defaultReasoningEffort
        document.setIn(['agent-default-model'], nextDefaultModel)
      } else document.deleteIn(['agent-default-model'])
      document.setIn(['permission', 'defaultPreset'], input.defaultPermission)
      document.setIn(['agent-presets', 'default'], input.defaultAgentPreset)
      const locale = { ...recordOf(current.locale) }
      if (input.locale === 'system') delete locale.preference
      else locale.preference = input.locale
      if (Object.keys(locale).length === 0) document.deleteIn(['locale'])
      else document.setIn(['locale'], locale)
      document.setIn(['ui-theme', 'preference'], input.theme)
      document.setIn(['ui-conversation', 'busyEnter'], input.busyEnter)
      const next = document.toString()
      if (next !== currentText) await atomicWrite(path, next)
    }, SETTINGS_LOCK_WAIT_MS)
    return this.read()
  }

  async setCredential(raw: SetUnifiedCredentialInput): Promise<UnifiedConfiguration> {
    if (!raw || typeof raw !== 'object' || typeof raw.ref !== 'string' || !(typeof raw.value === 'string' || raw.value === null)) throw new Error('API Key 更新无效。')
    const ref = raw.ref.trim()
    assertCredentialRef(ref)
    const configuration = await this.read()
    if (!configuration.providers.some(provider => provider.apiKeyRef === ref)) throw new Error('API Key 引用不属于当前统一配置。')
    const value = raw.value?.trim() ?? null
    if (value !== null && (!value || value.length > 32_768)) throw new Error('API Key 不能为空或过长。')
    const path = this.#projection.credentialsPath
    await withSettingsLock(path, async () => {
      await assertOwnerOnly(path)
      const currentText = await readOptional(path) ?? 'version: 1\nrefs: {}\n'
      const document = parseSettings(currentText, '共享凭据')
      const root = recordOf(document.toJS())
      if (root.version !== 1) throw new Error('共享凭据文件版本无效。')
      const refs = recordOf(root.refs)
      for (const [key, stored] of Object.entries(refs)) {
        assertCredentialRef(key)
        if (typeof stored !== 'string' || stored.length === 0) throw new Error(`共享凭据 ${key} 无效。`)
      }
      if (value === null) document.deleteIn(['refs', ref])
      else document.setIn(['refs', ref], value)
      const next = document.toString()
      if (next !== currentText) {
        await atomicWrite(path, next)
        if (process.platform !== 'win32') await chmod(path, 0o600)
      }
    }, CREDENTIAL_LOCK_WAIT_MS)
    return this.read()
  }

  async #credentialRefs(): Promise<Set<string>> {
    const path = this.#projection.credentialsPath
    await assertOwnerOnly(path)
    const text = await readOptional(path)
    if (text === undefined) return new Set()
    const root = recordOf(parseSettings(text, '共享凭据').toJS())
    if (root.version !== 1) throw new Error('共享凭据文件版本无效。')
    const refs = recordOf(root.refs)
    const result = new Set<string>()
    for (const [ref, value] of Object.entries(refs)) {
      assertCredentialRef(ref)
      if (typeof value !== 'string' || value.length === 0) throw new Error(`共享凭据 ${ref} 无效。`)
      result.add(ref)
    }
    return result
  }
}
