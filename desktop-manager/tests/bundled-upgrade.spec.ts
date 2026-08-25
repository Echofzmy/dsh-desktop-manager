import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/main/runtime/catalog.js', async () => {
  const { join: joinPath } = await import('node:path')
  return {
  discoverBundledRuntime: async (root: string) => ({
    id: 'runtime-bundled-2.0.0', name: '内置 DSH 2.0.0', source: 'bundled', path: joinPath(root, 'package'), managedPath: root,
    integrity: 'sha512-new', installReceiptPath: joinPath(root, 'install-receipt.json'), version: '2.0.0', registeredAt: '2026-02-01T00:00:00.000Z',
    preflight: { checkedAt: '2026-02-01T00:00:00.000Z', ready: true, entryPath: joinPath(root, 'package', 'lib', 'bin.js'), checks: [] },
  }),
  verifyOfficialRuntime: async () => undefined,
  }
})

import { ManagerService } from '../src/main/manager-service.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

describe('bundled runtime upgrade', () => {
  it('replaces obsolete bundled records and migrates defaults and live references', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-manager-bundled-upgrade-'))
    roots.push(root)
    const data = join(root, 'data')
    await mkdir(data)
    const timestamp = '2026-01-01T00:00:00.000Z'
    await writeFile(join(data, 'manager-state.json'), JSON.stringify({
      version: 3,
      settings: { openMode: 'embedded', checkUpdatesOnStartup: false, defaultRuntimeId: 'runtime-bundled-1.0.0' },
      runtimes: [{ id: 'runtime-bundled-1.0.0', name: 'Old', source: 'bundled', path: join(root, 'old'), version: '1.0.0', registeredAt: timestamp, preflight: { checkedAt: timestamp, ready: true, entryPath: join(root, 'old', 'bin.js'), checks: [] } }],
      environments: [{ id: 'env', name: 'Env', kind: 'isolated', path: join(root, 'home'), createdAt: timestamp }],
      instances: [{ id: 'instance', name: 'Instance', runtimeId: 'runtime-bundled-1.0.0', workspacePath: root, environmentId: 'env', port: 0, automaticPort: true, createdAt: timestamp, status: 'stopped' }],
      templates: [{ id: 'template', name: 'Template', runtimeId: 'runtime-bundled-1.0.0', workspacePath: root, environmentMode: 'new-isolated', port: 0, createdAt: timestamp }],
      tasks: [],
      backups: [{ id: 'backup', environmentId: 'env', path: join(root, 'backup'), manifestPath: join(root, 'backup', 'manifest.json'), status: 'ready', createdAt: timestamp }],
      promotions: [{ id: 'promotion', candidateInstanceId: 'candidate-history', productionInstanceId: 'instance', previousRuntimeId: 'runtime-bundled-1.0.0', targetRuntimeId: 'runtime-bundled-1.0.0', backupId: 'backup', status: 'committed', createdAt: timestamp, updatedAt: timestamp }],
      operations: [],
    }))
    const manager = new ManagerService(data, join(root, 'bundled'))
    await manager.initialize()
    const snapshot = manager.snapshot()
    expect(snapshot.runtimes.map(runtime => runtime.id)).toEqual(['runtime-bundled-2.0.0'])
    expect(snapshot.settings.defaultRuntimeId).toBe('runtime-bundled-2.0.0')
    expect(snapshot.instances[0]?.runtimeId).toBe('runtime-bundled-2.0.0')
    expect(snapshot.templates[0]?.runtimeId).toBe('runtime-bundled-2.0.0')
    expect(snapshot.promotions[0]).toMatchObject({ status: 'failed', previousRuntimeId: 'runtime-bundled-1.0.0', targetRuntimeId: 'runtime-bundled-1.0.0' })
  })
})
