import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { StateStore } from '../src/main/state-store.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

describe('StateStore', () => {
  it('creates a private versioned state file and reloads updates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-manager-store-'))
    roots.push(root)
    const path = join(root, 'data', 'manager-state.json')
    const store = new StateStore(path)
    await store.load()
    await store.update(draft => {
      draft.environments.push({
        id: 'env-1',
        name: 'Test',
        kind: 'isolated',
        path: join(root, 'home'),
        createdAt: '2026-01-01T00:00:00.000Z',
      })
    })

    const disk = JSON.parse(await readFile(path, 'utf8')) as { version: number }
    expect(disk.version).toBe(3)

    const reloaded = new StateStore(path)
    await reloaded.load()
    expect(reloaded.snapshot().environments).toHaveLength(1)
    expect(reloaded.snapshot().environments[0]?.name).toBe('Test')
  })

  it('publishes only durable updates and recovers its write queue after failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-manager-store-failure-'))
    roots.push(root)
    const directory = join(root, 'data')
    const store = new StateStore(join(directory, 'manager-state.json'))
    await store.load()
    await chmod(directory, 0o500)

    await expect(store.update(draft => {
      draft.environments.push({ id: 'lost', name: 'Lost', kind: 'isolated', path: '/lost', createdAt: '2026-01-01T00:00:00.000Z' })
    })).rejects.toThrow()
    expect(store.snapshot().environments).toHaveLength(0)

    await chmod(directory, 0o700)
    await store.update(draft => {
      draft.environments.push({ id: 'kept', name: 'Kept', kind: 'isolated', path: '/kept', createdAt: '2026-01-01T00:00:00.000Z' })
    })
    expect(store.snapshot().environments.map(environment => environment.id)).toEqual(['kept'])
  })

  it('migrates ambiguous v1 ports without silently choosing their mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-manager-store-migration-'))
    roots.push(root)
    const path = join(root, 'manager-state.json')
    const base = { name: 'Legacy', runtimeId: 'runtime', workspacePath: '/workspace', environmentId: 'environment', createdAt: '2026-01-01T00:00:00.000Z', status: 'stopped' }
    await writeFile(path, JSON.stringify({
      version: 1,
      runtimes: [{ id: 'runtime', name: 'Runtime', source: 'local', path: root, registeredAt: '2026-01-01T00:00:00.000Z', preflight: { checkedAt: '2026-01-01T00:00:00.000Z', ready: false, checks: [] } }],
      environments: [{ id: 'environment', name: 'Environment', kind: 'isolated', path: join(root, 'home'), createdAt: '2026-01-01T00:00:00.000Z' }],
      instances: [
        { ...base, id: 'automatic-zero', port: 0 },
        { ...base, id: 'ambiguous-resolved', port: 4321 },
        { ...base, id: 'known-automatic', port: 9876, automaticPort: true },
      ],
    }))

    const store = new StateStore(path)
    await store.load()
    const [zero, ambiguous, known] = store.snapshot().instances
    expect(zero).toMatchObject({ automaticPort: true })
    expect(zero?.portModeReviewRequired).toBeUndefined()
    expect(ambiguous).toMatchObject({ automaticPort: false, portModeReviewRequired: true })
    expect(known).toMatchObject({ automaticPort: true })
    expect(known?.portModeReviewRequired).toBeUndefined()
    expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(3)
    expect(store.snapshot().settings.defaultRuntimeId).toBe('runtime')
  })

  it('keeps the previous durable revision and recovers it when primary is corrupt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-manager-store-backup-'))
    roots.push(root)
    const path = join(root, 'manager-state.json')
    const store = new StateStore(path)
    await store.load()
    await store.update(draft => {
      draft.environments.push({ id: 'first', name: 'First', kind: 'isolated', path: '/first', createdAt: '2026-01-01T00:00:00.000Z' })
    })
    await store.update(draft => {
      draft.environments.push({ id: 'second', name: 'Second', kind: 'isolated', path: '/second', createdAt: '2026-01-01T00:00:00.000Z' })
    })
    const backup = JSON.parse(await readFile(`${path}.bak`, 'utf8')) as { environments: Array<{ id: string }> }
    expect(backup.environments.map(environment => environment.id)).toEqual(['first'])

    const malformed = JSON.parse(await readFile(path, 'utf8')) as { environments: Array<{ path?: string }> }
    delete malformed.environments[0]!.path
    await writeFile(path, JSON.stringify(malformed))
    const recovered = new StateStore(path)
    await recovered.load()
    expect(recovered.snapshot().environments.map(environment => environment.id)).toEqual(['first'])
    expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(3)
  })

  it('rejects a future primary version instead of loading an older backup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-manager-store-future-'))
    roots.push(root)
    const path = join(root, 'manager-state.json')
    const store = new StateStore(path)
    await store.load()
    await store.update(() => undefined)
    await writeFile(path, JSON.stringify({ version: 4, runtimes: [], environments: [], instances: [] }))

    await expect(new StateStore(path).load()).rejects.toThrow('newer than supported')
  })
})
