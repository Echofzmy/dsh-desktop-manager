import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { EnvironmentService } from '../src/main/environment-service.js'
import type { EnvironmentRecord, RuntimeRecord } from '../src/shared/types.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

function runtime(id: string): RuntimeRecord {
  return {
    id,
    name: id,
    source: 'local',
    path: '/runtime',
    registeredAt: '2026-01-01T00:00:00.000Z',
    preflight: { checkedAt: '2026-01-01T00:00:00.000Z', ready: true, gitCommit: 'abc123', checks: [] },
  }
}

describe('EnvironmentService', () => {
  it('clones the complete home, records lineage, and drops runtime profile links', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-manager-environment-'))
    roots.push(root)
    const sourcePath = join(root, 'source')
    await mkdir(join(sourcePath, 'sessions'), { recursive: true })
    await mkdir(join(sourcePath, 'profiles', 'node_modules'), { recursive: true })
    await writeFile(join(sourcePath, 'sessions', 'one.jsonl'), '{"session":true}\n')
    await writeFile(join(sourcePath, 'profiles', 'node_modules', 'stale-link'), 'old runtime')
    const source: EnvironmentRecord = {
      id: 'source-env',
      name: 'Source',
      kind: 'isolated',
      path: sourcePath,
      createdAt: '2026-01-01T00:00:00.000Z',
    }

    const service = new EnvironmentService(join(root, 'targets'))
    const cloned = await service.clone({
      name: 'Clone',
      sourceEnvironmentId: source.id,
      targetRuntimeId: 'target-runtime',
    }, source, undefined, runtime('source-runtime'))

    expect(await readFile(join(cloned.path, 'sessions', 'one.jsonl'), 'utf8')).toContain('session')
    await expect(readFile(join(cloned.path, 'profiles', 'node_modules', 'stale-link'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(cloned.lineage?.sourceRuntimeId).toBe('source-runtime')
    expect(cloned.lineage?.method).toMatch(/^(apfs-clone|copy)$/)

    await service.discard(cloned)
    await expect(readFile(join(cloned.path, 'sessions', 'one.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
