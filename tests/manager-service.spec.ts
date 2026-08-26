import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { ManagerService } from '../src/main/manager-service.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

describe('ManagerService environments', () => {
  it('rejects a second record for the same canonical DSH_HOME', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-manager-service-'))
    roots.push(root)
    const home = join(root, 'production-home')
    await mkdir(home)
    const manager = new ManagerService(join(root, 'manager-data'))
    await manager.initialize()

    await manager.createEnvironment({ name: 'Production', kind: 'production', path: home })
    await expect(manager.createEnvironment({ name: 'Alias', kind: 'production', path: home }))
      .rejects.toThrow('already registered')
  })

  it('creates an internal launch directory and automatic port without user choices', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-manager-instance-defaults-'))
    roots.push(root)
    const data = join(root, 'manager-data')
    const runtimePath = join(root, 'runtime')
    const environmentPath = join(root, 'environment')
    await mkdir(runtimePath)
    await mkdir(environmentPath)
    await mkdir(data)
    const timestamp = '2026-01-01T00:00:00.000Z'
    await writeFile(join(data, 'manager-state.json'), JSON.stringify({
      version: 3,
      settings: { openMode: 'embedded', checkUpdatesOnStartup: false, defaultRuntimeId: 'runtime' },
      runtimes: [{ id: 'runtime', name: 'Runtime', source: 'local', path: runtimePath, registeredAt: timestamp, preflight: { checkedAt: timestamp, ready: false, checks: [] } }],
      environments: [{ id: 'environment', name: 'Environment', kind: 'production', path: environmentPath, createdAt: timestamp }],
      instances: [], tasks: [], backups: [], promotions: [], operations: [], templates: [],
    }))
    const manager = new ManagerService(data)
    await manager.initialize()

    const instance = await manager.createInstance({ name: 'Default', runtimeId: 'runtime', environmentId: 'environment' })

    expect(instance.workspacePath).toBe(await realpath(join(data, 'instance-workspaces', instance.id)))
    expect((await stat(instance.workspacePath)).isDirectory()).toBe(true)
    expect(instance.port).toBe(0)
    expect(instance.automaticPort).toBe(true)
  })

  it('manages defaults, templates, instances, and isolated environment deletion without touching source runtimes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-manager-management-'))
    roots.push(root)
    const data = join(root, 'manager-data')
    const managedEnvironmentRoot = join(data, 'environments', 'environment')
    const home = join(managedEnvironmentRoot, 'home')
    await mkdir(home, { recursive: true })
    await writeFile(join(data, 'manager-state.json'), JSON.stringify({
      version: 2,
      runtimes: [
        { id: 'runtime-a', name: 'Runtime A', source: 'local', path: root, registeredAt: '2026-01-01T00:00:00.000Z', preflight: { checkedAt: '2026-01-01T00:00:00.000Z', ready: false, checks: [] } },
        { id: 'runtime-b', name: 'Runtime B', source: 'local', path: data, registeredAt: '2026-01-01T00:00:00.000Z', preflight: { checkedAt: '2026-01-01T00:00:00.000Z', ready: false, checks: [] } },
      ],
      environments: [{ id: 'environment', name: 'Environment', kind: 'isolated', path: home, createdAt: '2026-01-01T00:00:00.000Z' }],
      instances: [{ id: 'instance', name: 'Instance', runtimeId: 'runtime-a', workspacePath: root, environmentId: 'environment', port: 0, automaticPort: true, createdAt: '2026-01-01T00:00:00.000Z', status: 'stopped' }],
    }))
    const manager = new ManagerService(data)
    await manager.initialize()
    expect(manager.snapshot().settings.defaultRuntimeId).toBe('runtime-a')
    await manager.setDefaultRuntime('runtime-b')
    expect(manager.snapshot().settings.defaultRuntimeId).toBe('runtime-b')

    const template = await manager.saveInstanceTemplate('instance', 'Reusable')
    await expect(manager.deleteRuntime('runtime-a')).rejects.toThrow(/实例|模板/u)
    await manager.deleteInstance('instance', true)
    expect(manager.snapshot().environments).toHaveLength(0)
    const created = await manager.createInstanceFromTemplate(template.id, 'From template')
    expect(created.runtimeId).toBe('runtime-a')
    expect(manager.snapshot().environments).toHaveLength(1)
    await manager.deleteInstanceTemplate(template.id)
    await manager.deleteInstance(created.id, true)
    await manager.deleteRuntime('runtime-a')
    expect(manager.snapshot().runtimes.map(runtime => runtime.id)).toEqual(['runtime-b'])
  })


  it('keeps an existing build gate after a successful non-build task', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-manager-task-gate-'))
    roots.push(root)
    const data = join(root, 'manager-data')
    const runtimePath = join(root, 'runtime')
    await mkdir(join(runtimePath, 'apps', 'cli', 'lib'), { recursive: true })
    await mkdir(join(runtimePath, 'apps', 'web', 'dist'), { recursive: true })
    await mkdir(join(runtimePath, 'node_modules'))
    await writeFile(join(runtimePath, 'apps', 'cli', 'lib', 'bin.js'), '')
    await writeFile(join(runtimePath, 'apps', 'web', 'dist', 'index.html'), '')
    await writeFile(join(runtimePath, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-root', version: '0.0.0', packageManager: 'pnpm@11.5.2', engines: { node: '>=22.19.0' }, scripts: { test: 'node -e "process.exit(0)"' } }))
    await mkdir(data)
    const timestamp = '2026-01-01T00:00:00.000Z'
    await writeFile(join(data, 'manager-state.json'), JSON.stringify({
      version: 3,
      settings: { openMode: 'embedded', checkUpdatesOnStartup: false, defaultRuntimeId: 'runtime' },
      runtimes: [{ id: 'runtime', name: 'Worktree', source: 'local', path: runtimePath, taskBlocked: '需要完整构建。', registeredAt: timestamp, preflight: { checkedAt: timestamp, ready: true, entryPath: join(runtimePath, 'apps', 'cli', 'lib', 'bin.js'), checks: [] } }],
      environments: [], instances: [], tasks: [], backups: [], promotions: [], operations: [], templates: [],
    }))
    const manager = new ManagerService(data)
    await manager.initialize()
    const task = await manager.startRuntimeTask('runtime', 'test')
    for (let attempt = 0; attempt < 100 && ['prepared', 'running'].includes(manager.snapshot().tasks.find(item => item.id === task.id)?.status ?? ''); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    expect(manager.snapshot().tasks.find(item => item.id === task.id)?.status).toBe('succeeded')
    expect(manager.snapshot().runtimes[0]?.taskBlocked).toBe('需要完整构建。')
  })


  it('protects a production instance until its confirmed rollback point is explicitly dismissed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-manager-promotion-delete-'))
    roots.push(root)
    const data = join(root, 'manager-data')
    await mkdir(data)
    const timestamp = '2026-01-01T00:00:00.000Z'
    const runtime = (id: string) => ({ id, name: id, source: 'local', path: join(root, id), registeredAt: timestamp, preflight: { checkedAt: timestamp, ready: false, checks: [] } })
    await writeFile(join(data, 'manager-state.json'), JSON.stringify({
      version: 3,
      settings: { openMode: 'embedded', checkUpdatesOnStartup: false, defaultRuntimeId: 'new', productionInstanceId: 'production' },
      runtimes: [runtime('old'), runtime('new')],
      environments: [{ id: 'environment', name: 'Production', kind: 'production', path: join(root, 'production-home'), createdAt: timestamp }],
      instances: [{ id: 'production', name: 'Production', runtimeId: 'new', workspacePath: root, environmentId: 'environment', port: 0, automaticPort: true, createdAt: timestamp, status: 'stopped' }],
      backups: [{ id: 'backup', environmentId: 'environment', path: join(root, 'backup'), manifestPath: join(root, 'backup', 'manifest.json'), status: 'ready', createdAt: timestamp }],
      promotions: [{ id: 'promotion', candidateInstanceId: 'candidate-history', productionInstanceId: 'production', previousRuntimeId: 'old', targetRuntimeId: 'new', backupId: 'backup', status: 'committed', createdAt: timestamp, updatedAt: timestamp }],
      tasks: [], operations: [], templates: [],
    }))
    const manager = new ManagerService(data)
    await manager.initialize()
    await expect(manager.deleteInstance('production')).rejects.toThrow('回退')
    await manager.dismissPromotion('promotion')
    await manager.deleteInstance('production')
    expect(manager.snapshot().instances).toHaveLength(0)
  })

  it('restores a staged environment deletion after a crash before metadata commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-manager-delete-recovery-'))
    roots.push(root)
    const data = join(root, 'manager-data')
    const target = join(data, 'environments', 'environment')
    const stagedPath = `${target}.deleting-test`
    await mkdir(join(stagedPath, 'home'), { recursive: true })
    await writeFile(join(stagedPath, 'home', 'state.json'), 'preserved')
    const timestamp = '2026-01-01T00:00:00.000Z'
    await writeFile(join(data, 'manager-state.json'), JSON.stringify({
      version: 3,
      settings: { openMode: 'embedded', checkUpdatesOnStartup: false }, runtimes: [],
      environments: [{ id: 'environment', name: 'Environment', kind: 'isolated', path: join(target, 'home'), createdAt: timestamp }],
      instances: [], tasks: [], backups: [], promotions: [], templates: [],
      operations: [{ id: 'delete', requestId: 'delete-environment', type: 'delete-environment', status: 'running', phase: 'staged', resourceKeys: [`environment:${join(target, 'home')}`], input: { environmentId: 'environment' }, artifacts: { kind: 'environment', target, stagedPath }, createdAt: timestamp, updatedAt: timestamp }],
    }))

    const manager = new ManagerService(data)
    await manager.initialize()

    expect(await readFile(join(target, 'home', 'state.json'), 'utf8')).toBe('preserved')
    expect(manager.snapshot().environments).toHaveLength(1)
    expect(manager.snapshot().operations[0]).toMatchObject({ status: 'failed', phase: 'restored-after-crash' })
  })

  it('finalizes metadata when backup state revives an already deleted environment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-manager-delete-backup-'))
    roots.push(root)
    const data = join(root, 'manager-data')
    const target = join(data, 'environments', 'environment')
    await mkdir(data, { recursive: true })
    const timestamp = '2026-01-01T00:00:00.000Z'
    await writeFile(join(data, 'manager-state.json'), JSON.stringify({
      version: 3,
      settings: { openMode: 'embedded', checkUpdatesOnStartup: false }, runtimes: [],
      environments: [{ id: 'environment', name: 'Environment', kind: 'isolated', path: join(target, 'home'), createdAt: timestamp }],
      instances: [], tasks: [], backups: [], promotions: [], templates: [],
      operations: [{ id: 'delete', requestId: 'delete-environment', type: 'delete-environment', status: 'running', phase: 'commit-delete', resourceKeys: [`environment:${join(target, 'home')}`], input: { environmentId: 'environment' }, artifacts: { kind: 'metadata' }, createdAt: timestamp, updatedAt: timestamp }],
    }))

    const manager = new ManagerService(data)
    await manager.initialize()

    expect(manager.snapshot().environments).toHaveLength(0)
    expect(manager.snapshot().operations[0]).toMatchObject({ status: 'committed', phase: 'complete-after-recovery' })
  })

  it('quarantines interrupted instances and requires explicit port recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-manager-recovery-'))
    roots.push(root)
    const data = join(root, 'manager-data')
    await mkdir(data)
    await writeFile(join(data, 'manager-state.json'), JSON.stringify({
      version: 2,
      runtimes: [{ id: 'runtime', name: 'Runtime', source: 'local', path: root, registeredAt: '2026-01-01T00:00:00.000Z', preflight: { checkedAt: '2026-01-01T00:00:00.000Z', ready: false, checks: [] } }],
      environments: [{ id: 'environment', name: 'Environment', kind: 'isolated', path: join(root, 'home'), createdAt: '2026-01-01T00:00:00.000Z' }],
      instances: [{
        id: 'instance', name: 'Interrupted', runtimeId: 'runtime', workspacePath: root, environmentId: 'environment',
        port: 0, automaticPort: true, createdAt: '2026-01-01T00:00:00.000Z', status: 'running', pid: 999_999,
      }],
    }))
    const manager = new ManagerService(data)
    await manager.initialize()
    expect(manager.snapshot().instances[0]).toMatchObject({ status: 'failed', interrupted: true, pid: 999_999 })
    await expect(manager.startInstance('instance')).rejects.toThrow('请先确认')

    const recovered = await manager.recoverInstance('instance', true)
    expect(recovered).toMatchObject({ status: 'stopped', automaticPort: true, port: 0, interrupted: false })
    expect(recovered.pid).toBeUndefined()
  })
})
