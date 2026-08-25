import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { ModelSettingsProjection } from '../src/main/model-settings-projection.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

describe('ModelSettingsProjection', () => {
  it('projects only model namespaces and points DSH at one shared native credential file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-model-settings-'))
    roots.push(root)
    const projection = new ModelSettingsProjection(root)
    const targetHome = join(root, 'environment-home')
    await projection.initialize()
    await mkdir(targetHome)
    await writeFile(join(projection.home, 'settings.yaml'), [
      'llm-deepseek:',
      '  baseURL: https://api.deepseek.example',
      'llm-pi-ai:',
      '  providers:',
      '    sub2api:',
      '      apiKeyEnv: SUB2API_API_KEY',
      '      api: openai-completions',
      '      baseURL: https://sub2api.example/v1',
      '      models:',
      '        - id: custom-chat',
      'agent-default-model:',
      '  provider: sub2api',
      '  model: custom-chat',
      'ui-theme:',
      '  theme: dark',
      '',
    ].join('\n'))
    await writeFile(join(projection.home, '.credentials.yaml'), 'version: 1\nrefs:\n  SUB2API_API_KEY: secret-value\n', { mode: 0o600 })
    await writeFile(join(targetHome, 'settings.yaml'), 'agent-default-model:\n  provider: local\n  model: retained\nui-theme:\n  theme: light\n')

    await expect(projection.projectInto(targetHome)).resolves.toMatchObject({ changed: true })

    const result = parse(await readFile(join(targetHome, 'settings.yaml'), 'utf8'))
    expect(result).toMatchObject({
      'llm-deepseek': { baseURL: 'https://api.deepseek.example' },
      'llm-pi-ai': { providers: { sub2api: { apiKeyEnv: 'SUB2API_API_KEY', models: [{ id: 'custom-chat' }] } } },
      'agent-default-model': { provider: 'sub2api', model: 'custom-chat' },
      'ui-theme': { theme: 'light' },
    })
    expect(JSON.stringify(result)).not.toContain('secret-value')
    const overlay = parse(await readFile(projection.overlayPath, 'utf8'))
    expect(overlay).toEqual([{ id: 'credentials', config: { path: projection.credentialsPath, watch: true } }])
  })

  it('creates model namespaces in a brand-new empty DSH home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-model-settings-empty-'))
    roots.push(root)
    const projection = new ModelSettingsProjection(root)
    const targetHome = join(root, 'environment-home')
    await projection.initialize()
    await mkdir(targetHome)
    await writeFile(join(projection.home, 'settings.yaml'), 'llm-pi-ai:\n  providers:\n    sub2api:\n      apiKeyEnv: MY_AUTH\n      api: openai-completions\n      baseURL: https://sub2api.example/v1\n      models:\n        - id: custom-chat\n')

    const result = await projection.projectInto(targetHome)
    expect(result).toMatchObject({ changed: true, credentialRefs: expect.arrayContaining(['DEEPSEEK_API_KEY', 'MY_AUTH']) })
    expect(parse(await readFile(join(targetHome, 'settings.yaml'), 'utf8'))).toMatchObject({
      'llm-pi-ai': { providers: { sub2api: { models: [{ id: 'custom-chat' }] } } },
    })
  })

  it('removes a stale instance default when shared settings do not own one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-model-settings-default-'))
    roots.push(root)
    const projection = new ModelSettingsProjection(root)
    const targetHome = join(root, 'environment-home')
    await projection.initialize()
    await mkdir(targetHome)
    await writeFile(join(projection.home, 'settings.yaml'), 'llm-pi-ai:\n  providers: {}\n')
    await writeFile(join(targetHome, 'settings.yaml'), 'llm-deepseek:\n  baseURL: https://stale.example\nagent-default-model:\n  provider: sub2api\n  model: retained\n')

    await projection.projectInto(targetHome)

    expect(parse(await readFile(join(targetHome, 'settings.yaml'), 'utf8'))).toEqual({
      'llm-pi-ai': { providers: {} },
    })
  })

  it('serializes with DSH settings writers and re-reads unrelated changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-model-settings-lock-'))
    roots.push(root)
    const projection = new ModelSettingsProjection(root)
    const targetHome = join(root, 'environment-home')
    await projection.initialize()
    await mkdir(targetHome)
    await writeFile(join(projection.home, 'settings.yaml'), 'llm-pi-ai:\n  providers: {}\n')
    const target = join(targetHome, 'settings.yaml')
    const lock = `${target}.lock`
    await writeFile(target, 'ui-theme:\n  theme: light\n')
    await writeFile(lock, 'other-writer\n', { flag: 'wx' })

    const pending = projection.projectInto(targetHome)
    await new Promise(resolve => setTimeout(resolve, 50))
    await writeFile(target, 'ui-theme:\n  theme: dark\n')
    await rm(lock)
    await pending

    expect(parse(await readFile(target, 'utf8'))).toEqual({
      'ui-theme': { theme: 'dark' },
      'llm-pi-ai': { providers: {} },
    })
  })

  it('fails without replacing malformed target settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-model-settings-invalid-'))
    roots.push(root)
    const projection = new ModelSettingsProjection(root)
    const targetHome = join(root, 'environment-home')
    await projection.initialize()
    await mkdir(targetHome)
    await writeFile(join(projection.home, 'settings.yaml'), 'llm-pi-ai:\n  providers: {}\n')
    const malformed = 'ui-theme: [\n'
    const target = join(targetHome, 'settings.yaml')
    await writeFile(target, malformed)
    await chmod(target, 0o600)

    await expect(projection.projectInto(targetHome)).rejects.toThrow('实例设置 无法解析')
    await expect(readFile(target, 'utf8')).resolves.toBe(malformed)
  })
})
