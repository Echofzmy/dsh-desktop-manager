import { createHash } from 'node:crypto'
import { opendir, readFile, readlink, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

export interface FileDigest {
  path: string
  type: 'file' | 'symlink'
  sha256: string
  size: number
}

function contained(root: string, target: string): boolean {
  const fromRoot = relative(root, target)
  return fromRoot === '' || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== '..')
}

interface PendingDigest {
  path: string
  type: 'file' | 'symlink'
  size?: number
  sha256?: string
  absolute?: string
}

async function materialize(files: PendingDigest[], signal?: AbortSignal): Promise<FileDigest[]> {
  const result: FileDigest[] = []
  for (let index = 0; index < files.length; index += 256) {
    signal?.throwIfAborted()
    result.push(...await Promise.all(files.slice(index, index + 256).map(async file => {
      if (file.type === 'symlink') return { path: file.path, type: file.type, size: file.size!, sha256: file.sha256! }
      const content = await readFile(file.absolute!, { signal })
      return { path: file.path, type: file.type, size: content.length, sha256: createHash('sha256').update(content).digest('hex') }
    })))
  }
  return result
}

async function collect(root: string, current = root, signal?: AbortSignal): Promise<PendingDigest[]> {
  signal?.throwIfAborted()
  const entries = []
  for await (const entry of await opendir(current)) entries.push(entry)
  const groups = await Promise.all(entries.map(async entry => {
    signal?.throwIfAborted()
    const absolute = join(current, entry.name)
    const path = relative(root, absolute)
    if (path === 'files.sha256' || path === 'install-receipt.json' || path === 'READY') return []
    if (entry.isDirectory()) return collect(root, absolute, signal)
    if (entry.isFile()) return [{ path, type: 'file' as const, absolute }]
    if (entry.isSymbolicLink()) {
      const target = await readlink(absolute)
      const resolvedTarget = await realpath(resolve(dirname(absolute), target))
      if (!contained(root, resolvedTarget)) throw new Error(`安装包包含逃逸运行时目录的符号链接：${path}`)
      return [{ path, type: 'symlink' as const, sha256: createHash('sha256').update(target).digest('hex'), size: Buffer.byteLength(target) }]
    }
    throw new Error(`安装包包含不支持的文件类型：${path}`)
  }))
  return groups.flat()
}

export async function writeRuntimeManifest(root: string, signal?: AbortSignal): Promise<{ path: string; digest: string; files: number }> {
  const files = (await materialize(await collect(root, root, signal), signal)).sort((left, right) => left.path.localeCompare(right.path))
  const content = `${JSON.stringify({ version: 1, files }, null, 2)}\n`
  const path = join(root, 'files.sha256')
  await writeFile(path, content, { mode: 0o600 })
  return { path, digest: createHash('sha256').update(content).digest('hex'), files: files.length }
}

export async function verifyRuntimeManifest(root: string, signal?: AbortSignal): Promise<{ digest: string; files: number }> {
  const content = await readFile(join(root, 'files.sha256'), 'utf8')
  const expected = JSON.parse(content) as { version?: unknown; files?: unknown }
  if (expected.version !== 1 || !Array.isArray(expected.files)) throw new Error('运行时文件清单格式无效')
  const actual = (await materialize(await collect(root, root, signal), signal)).sort((left, right) => left.path.localeCompare(right.path))
  if (JSON.stringify(expected.files) !== JSON.stringify(actual)) throw new Error('运行时文件完整性校验失败')
  return { digest: createHash('sha256').update(content).digest('hex'), files: actual.length }
}
