import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { ModelConfigurationService } from '../src/main/model-configuration-service.js'
import { ModelSettingsProjection } from '../src/main/model-settings-projection.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-configuration-'))
  roots.push(root)
  const projection = new ModelSettingsProjection(root)
  await projection.initialize()
  return { root, projection, service: new ModelConfigurationService(projection) }
}

describe('ModelConfigurationService', () => {
  it('reads an immediate redacted configuration without starting DSH', async () => {
    const { projection, service } = await fixture()
    await writeFile(join(projection.home, '.credentials.yaml'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: secret-never-returned\n', { mode: 0o600 })
    await writeFile(join(projection.home, 'settings.yaml'), 'llm-deepseek:\n  models:\n    - id: deepseek-v4-flash\n      name: DeepSeek-V4-Flash\n      contextWindow: 1000000\n    - id: deepseek-v4-pro\n      name: DeepSeek-V4-Pro\n      contextWindow: 1000000\n    - id: deepseek-v4-flash-vision-exp\n      name: DeepSeek-V4-Flash-Vision-Exp\n      contextWindow: 1000000\n')

    const result = await service.read()

    expect(result.providers[0]).toMatchObject({ id: 'deepseek-official', hasApiKey: true, protocol: 'deepseek', baseURL: 'https://api.deepseek.com', models: [] })
    expect(JSON.stringify(result)).not.toContain('secret-never-returned')
    expect(result).toMatchObject({ defaultPermission: 'workspace-write', locale: 'system', theme: 'system', busyEnter: 'queue' })
  })

  it('discovers OpenAI-compatible models without returning or persisting probe credentials', async () => {
    const { projection, service } = await fixture()
    await writeFile(join(projection.home, 'settings.yaml'), 'llm-pi-ai:\n  providers:\n    gateway:\n      api: openai-responses\n      baseURL: http://127.0.0.1\n      apiKeyEnv: GATEWAY_API_KEY\n      models:\n        - id: existing\n')
    await writeFile(projection.credentialsPath, 'version: 1\nrefs:\n  GATEWAY_API_KEY: stored-probe-key\n', { mode: 0o600 })
    const authorizations: Array<string | undefined> = []
    const server = createServer((request, response) => {
      authorizations.push(request.headers.authorization)
      if (request.headers.authorization === 'Bearer wrong-key') { response.writeHead(401).end(); return }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ data: [
        { id: 'model-a', name: 'Model A', context_window: 128000, max_output_tokens: 8192 },
        { id: 'model-a', name: 'duplicate ignored' },
        { display_name: 'missing id ignored' },
        { id: 'model-b', display_name: 'Model B', context_length: 64000, max_tokens: 4096 },
      ] }))
    })
    await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject))
    const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`
    await writeFile(join(projection.home, 'settings.yaml'), `llm-pi-ai:\n  providers:\n    gateway:\n      api: openai-responses\n      baseURL: ${baseURL}\n      apiKeyEnv: GATEWAY_API_KEY\n      models:\n        - id: existing\n`)
    try {
      await expect(service.discoverModels({ providerId: 'gateway', protocol: 'anthropic-messages', baseURL })).rejects.toThrow('不支持自动发现')
      await expect(service.discoverModels({ providerId: 'gateway', protocol: 'openai-responses', baseURL: `http://user:password@127.0.0.1:${(server.address() as AddressInfo).port}/v1`, apiKey: 'typed' })).rejects.toThrow('不能内嵌用户名或密码')
      await expect(service.discoverModels({ providerId: 'gateway', protocol: 'openai-responses', baseURL: `${baseURL}/changed` })).rejects.toThrow('避免把已保存 Key 发送到新地址')
      const stored = await service.discoverModels({ providerId: 'gateway', protocol: 'openai-responses', baseURL })
      expect(stored).toEqual([
        { id: 'model-a', name: 'Model A', contextWindow: 128000, maxTokens: 8192 },
        { id: 'model-b', name: 'Model B', contextWindow: 64000, maxTokens: 4096 },
      ])
      const typed = await service.discoverModels({ providerId: 'gateway', protocol: 'openai-completions', baseURL, apiKey: ' replacement-key ' })
      expect(typed).toHaveLength(2)
      const deepseek = await service.discoverModels({ providerId: 'deepseek-official', protocol: 'deepseek', baseURL, apiKey: 'deepseek-probe-key' })
      expect(deepseek.map(model => model.id)).toEqual(['model-a', 'model-b'])
      await expect(service.discoverModels({ providerId: 'gateway', protocol: 'openai-responses', baseURL, apiKey: 'wrong-key' })).rejects.toThrow('HTTP 401，请检查 API Key')
      expect(authorizations).toEqual(['Bearer stored-probe-key', 'Bearer replacement-key', 'Bearer deepseek-probe-key', 'Bearer wrong-key'])
      expect(await readFile(projection.credentialsPath, 'utf8')).not.toContain('replacement-key')
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  it('writes DSH-compatible settings while preserving hidden advanced fields', async () => {
    const { projection, service } = await fixture()
    await writeFile(join(projection.home, 'settings.yaml'), 'llm-deepseek:\n  streamIdleTimeoutMs: 1234\nllm-pi-ai:\n  providers:\n    gateway:\n      timeoutMs: 4321\n      apiKeyEnv: GATEWAY_API_KEY\n      api: openai-completions\n      baseURL: https://old.example/v1\n      models:\n        - id: old-model\nworkspace-local:\n  retained: true\n')

    const saved = await service.save({
      providers: [
        { id: 'deepseek-official', kind: 'deepseek', displayName: 'DeepSeek', protocol: 'deepseek', apiKeyRef: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.example', models: [{ id: 'deepseek-v4-flash', contextWindow: 1000000 }] },
        { id: 'gateway', kind: 'custom', displayName: 'Gateway', protocol: 'openai-responses', apiKeyRef: 'GATEWAY_API_KEY', baseURL: 'https://gateway.example/v1', timeoutMs: 900000, streamIdleTimeoutMs: 600000, models: [{ id: 'custom-chat', name: 'Custom Chat', contextWindow: 128000, maxTokens: 8192 }] },
      ],
      defaultModel: { provider: 'gateway', model: 'custom-chat' },
      defaultReasoningEffort: 'high',
      defaultPermission: 'read-only',
      defaultAgentPreset: 'minimal',
      locale: 'zh',
      theme: 'dark',
      busyEnter: 'queue',
    })

    expect(saved).toMatchObject({ defaultModel: { provider: 'gateway', model: 'custom-chat' }, defaultReasoningEffort: 'high', defaultPermission: 'read-only', theme: 'dark' })
    const settings = parse(await readFile(join(projection.home, 'settings.yaml'), 'utf8'))
    expect(settings).toMatchObject({
      'llm-deepseek': { streamIdleTimeoutMs: 1234, baseURL: 'https://api.deepseek.example' },
      'llm-pi-ai': { providers: { gateway: { timeoutMs: 900000, streamIdleTimeoutMs: 600000, api: 'openai-responses', models: [{ id: 'custom-chat' }] } } },
      'agent-default-model': { provider: 'gateway', model: 'custom-chat', reasoningEffort: 'high' },
      'workspace-local': { retained: true },
      permission: { defaultPreset: 'read-only' },
      locale: { preference: 'zh' },
    })

    const { defaultReasoningEffort: _reasoning, ...withoutReasoning } = saved
    await service.save({
      ...withoutReasoning,
      providers: saved.providers.map(({ hasApiKey: _hasApiKey, ...provider }) => ({ ...provider, timeoutMs: null, streamIdleTimeoutMs: null })),
    })
    const reset = parse(await readFile(join(projection.home, 'settings.yaml'), 'utf8'))
    expect(reset['llm-deepseek']).not.toHaveProperty('streamIdleTimeoutMs')
    expect(reset['llm-pi-ai'].providers.gateway).not.toHaveProperty('timeoutMs')
    expect(reset['llm-pi-ai'].providers.gateway).not.toHaveProperty('streamIdleTimeoutMs')
    expect(reset['agent-default-model']).not.toHaveProperty('reasoningEffort')
  })

  it('preserves catalog inheritance and hidden model capability fields on a general save', async () => {
    const { projection, service } = await fixture()
    await writeFile(join(projection.home, 'settings.yaml'), `llm-pi-ai:\n  providers:\n    openai:\n      apiKeyEnv: OPENAI_API_KEY\n    gateway:\n      api: openai-responses\n      baseURL: https://gateway.example/v1\n      models:\n        - id: vision-chat\n          input: [text, image]\n          reasoningEfforts:\n            high: high\n          compat:\n            supportsStore: false\n`)
    const configuration = await service.read()
    expect(configuration.providers.find(provider => provider.id === 'openai')?.kind).toBe('catalog')

    await service.save({
      ...configuration,
      providers: configuration.providers.map(({ hasApiKey: _hasApiKey, ...provider }) => provider),
      theme: 'dark',
    })

    const settings = parse(await readFile(join(projection.home, 'settings.yaml'), 'utf8'))
    expect(settings['llm-pi-ai'].providers.openai).toEqual({ apiKeyEnv: 'OPENAI_API_KEY' })
    expect(settings['llm-pi-ai'].providers.gateway.models[0]).toMatchObject({
      id: 'vision-chat', input: ['text', 'image'], reasoningEfforts: { high: 'high' }, compat: { supportsStore: false },
    })
  })

  it('stores and clears write-only API keys in an owner-only native credential document', async () => {
    const { projection, service } = await fixture()
    const configured = await service.setCredential({ ref: 'DEEPSEEK_API_KEY', value: '  ds-secret  ' })
    expect(configured.providers[0]!.hasApiKey).toBe(true)
    expect(JSON.stringify(configured)).not.toContain('ds-secret')
    expect(parse(await readFile(projection.credentialsPath, 'utf8'))).toEqual({ version: 1, refs: { DEEPSEEK_API_KEY: 'ds-secret' } })
    if (process.platform !== 'win32') expect((await stat(projection.credentialsPath)).mode & 0o077).toBe(0)

    const cleared = await service.setCredential({ ref: 'DEEPSEEK_API_KEY', value: null })
    expect(cleared.providers[0]!.hasApiKey).toBe(false)
    expect(parse(await readFile(projection.credentialsPath, 'utf8'))).toEqual({ version: 1, refs: {} })
  })

  it('materializes a custom provider credential reference only after a key is configured', async () => {
    const { projection, service } = await fixture()
    const base = await service.read()
    const input = {
      ...base,
      providers: [
        ...base.providers.map(({ hasApiKey: _hasApiKey, ...provider }) => provider),
        { id: 'native-auth', kind: 'custom' as const, displayName: '', protocol: 'openai-completions' as const, apiKeyRef: 'NATIVE_AUTH_API_KEY', baseURL: 'https://native.example/v1', models: [{ id: 'native-chat' }] },
      ],
    }
    const saved = await service.save(input)
    expect(saved.providers.find(provider => provider.id === 'native-auth')?.displayName).toBe('native-auth')
    let settings = parse(await readFile(join(projection.home, 'settings.yaml'), 'utf8'))
    expect(settings['llm-pi-ai'].providers['native-auth']).not.toHaveProperty('displayName')
    expect(settings['llm-pi-ai'].providers['native-auth']).not.toHaveProperty('apiKeyEnv')

    await service.setCredential({ ref: 'NATIVE_AUTH_API_KEY', value: 'native-secret' })
    await service.save(input)
    settings = parse(await readFile(join(projection.home, 'settings.yaml'), 'utf8'))
    expect(settings['llm-pi-ai'].providers['native-auth'].apiKeyEnv).toBe('NATIVE_AUTH_API_KEY')
  })

  it('rejects unsafe credential references and incomplete custom providers', async () => {
    const { service } = await fixture()
    const base = await service.read()
    await expect(service.save({ ...base, providers: base.providers.map(({ hasApiKey: _hasApiKey, ...provider }) => ({ ...provider, apiKeyRef: 'DSH_HOME' })) })).rejects.toThrow('API Key 引用无效')
    await expect(service.save({
      ...base,
      providers: [
        ...base.providers.map(({ hasApiKey: _hasApiKey, ...provider }) => provider),
        { id: 'custom', kind: 'custom', displayName: 'Custom', protocol: 'openai-completions', apiKeyRef: 'CUSTOM_API_KEY', baseURL: 'https://custom.example/v1', models: [] },
      ],
    })).rejects.toThrow('至少需要一个模型')
    await expect(service.save({ ...base, defaultModel: { provider: 'deepseek-official', model: 'missing-model' }, providers: base.providers.map(({ hasApiKey: _hasApiKey, ...provider }) => provider) })).rejects.toThrow('不在提供方的模型列表中')
    await expect(service.setCredential({ ref: 'UNOWNED_API_KEY', value: 'secret' })).rejects.toThrow('不属于当前统一配置')
  })
})
