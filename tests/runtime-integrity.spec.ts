import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyRuntimeManifest, writeRuntimeManifest } from '../src/main/runtime/integrity.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

describe('runtime integrity manifest', () => {
  it('binds actual files and detects modification or removal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-manager-integrity-'))
    roots.push(root)
    await mkdir(join(root, 'node_modules'), { recursive: true })
    const entry = join(root, 'node_modules', 'entry.js')
    await writeFile(entry, 'export const value = 1\n')
    const written = await writeRuntimeManifest(root)
    expect(await verifyRuntimeManifest(root)).toEqual({ digest: written.digest, files: written.files })
    await writeFile(entry, 'export const value = 2\n')
    await expect(verifyRuntimeManifest(root)).rejects.toThrow('完整性校验失败')
  })
})
