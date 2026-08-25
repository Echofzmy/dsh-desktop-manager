import { createHash } from 'node:crypto'
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { EnvironmentBackupService } from '../src/main/environment-backup.js'
import type { EnvironmentRecord } from '../src/shared/types.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

describe('EnvironmentBackupService', () => {
  it('verifies a complete backup and restores through an atomic swap while retaining diagnostics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-manager-backup-'))
    roots.push(root)
    const home = join(root, 'production')
    await mkdir(join(home, 'sessions'), { recursive: true })
    await writeFile(join(home, 'sessions', 'history.jsonl'), 'before\n')
    const environment: EnvironmentRecord = { id: 'production', name: 'Production', kind: 'production', path: home, createdAt: '2026-01-01T00:00:00.000Z' }
    const service = new EnvironmentBackupService(join(root, 'manager'))

    const backup = await service.create(environment)
    await service.verify(backup)
    await writeFile(join(home, 'sessions', 'history.jsonl'), 'after\n')
    const diagnostic = await service.restore(backup, environment)

    expect(await readFile(join(home, 'sessions', 'history.jsonl'), 'utf8')).toBe('before\n')
    expect(await readFile(join(diagnostic, 'sessions', 'history.jsonl'), 'utf8')).toBe('after\n')
  })

  it('recovers an interrupted restore swap from its durable journal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-manager-backup-recovery-'))
    roots.push(root)
    const home = join(root, 'production')
    await mkdir(home)
    await writeFile(join(home, 'state.json'), 'backup-state')
    const environment: EnvironmentRecord = { id: 'production', name: 'Production', kind: 'production', path: home, createdAt: '2026-01-01T00:00:00.000Z' }
    const service = new EnvironmentBackupService(join(root, 'manager'))
    const backup = await service.create(environment)
    const staging = `${home}.restore-test`
    const diagnostic = `${home}.diagnostic-test`
    await cp(join(backup.path, 'home'), staging, { recursive: true })
    await rename(home, diagnostic)
    await writeFile(join(backup.path, 'restore-journal.json'), JSON.stringify({ version: 1, environmentId: environment.id, canonical: home, staging, diagnostic, phase: 'diagnostic-moved' }))

    await service.recoverRestore(backup, environment, true)

    expect(await readFile(join(home, 'state.json'), 'utf8')).toBe('backup-state')
    expect(await readFile(join(diagnostic, 'state.json'), 'utf8')).toBe('backup-state')
    await expect(access(join(backup.path, 'restore-journal.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects symlinks that escape the environment root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-manager-backup-link-'))
    roots.push(root)
    const home = join(root, 'home')
    const external = join(root, 'external.json')
    await mkdir(home)
    await writeFile(external, '{"secret":true}')
    await symlink(external, join(home, 'external.json'))
    const environment: EnvironmentRecord = { id: 'env', name: 'Env', kind: 'isolated', path: home, createdAt: '2026-01-01T00:00:00.000Z' }
    const service = new EnvironmentBackupService(join(root, 'manager'))
    await expect(service.create(environment)).rejects.toThrow('逃逸备份根目录')
  })

  it('rejects a forged payload and matching manifest when READY is unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-manager-backup-ready-'))
    roots.push(root)
    const home = join(root, 'home')
    await mkdir(home)
    await writeFile(join(home, 'settings.json'), '{}')
    const environment: EnvironmentRecord = { id: 'env', name: 'Env', kind: 'isolated', path: home, createdAt: '2026-01-01T00:00:00.000Z' }
    const service = new EnvironmentBackupService(join(root, 'manager'))
    const backup = await service.create(environment)
    const forged = '{"changed":true}'
    await writeFile(join(backup.path, 'home', 'settings.json'), forged)
    const manifest = JSON.parse(await readFile(backup.manifestPath, 'utf8'))
    manifest.files[0].sha256 = createHash('sha256').update(forged).digest('hex')
    manifest.files[0].size = Buffer.byteLength(forged)
    await writeFile(backup.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    await expect(service.verify(backup)).rejects.toThrow('READY')
  })

  it('detects modified backup payloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-manager-backup-corrupt-'))
    roots.push(root)
    const home = join(root, 'home')
    await mkdir(home)
    await writeFile(join(home, 'settings.json'), '{}')
    const environment: EnvironmentRecord = { id: 'env', name: 'Env', kind: 'isolated', path: home, createdAt: '2026-01-01T00:00:00.000Z' }
    const service = new EnvironmentBackupService(join(root, 'manager'))
    const backup = await service.create(environment)
    await writeFile(join(backup.path, 'home', 'settings.json'), '{"changed":true}')
    await expect(service.verify(backup)).rejects.toThrow('完整性')
  })
})
