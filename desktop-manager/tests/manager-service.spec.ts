import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
