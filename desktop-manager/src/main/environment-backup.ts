import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, cp, lstat, mkdir, opendir, open, readFile, readlink, realpath, rename, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type { BackupRecord, EnvironmentRecord } from '../shared/types.js'

interface EntryDigest {
  path: string
  type: 'file' | 'symlink'
  sha256: string
  size: number
}

interface RestoreJournal {
  version: 1
  environmentId: string
  canonical: string
  staging: string
  diagnostic: string
  phase: 'staged-ready' | 'diagnostic-moved' | 'restored'
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function fileHash(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path)
    stream.on('data', chunk => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', resolve)
  })
  return hash.digest('hex')
}

async function entries(root: string, current = root): Promise<EntryDigest[]> {
  const result: EntryDigest[] = []
  for await (const entry of await opendir(current)) {
    const absolute = join(current, entry.name)
    const path = relative(root, absolute)
    const stats = await lstat(absolute)
    if (stats.isDirectory()) result.push(...await entries(root, absolute))
    else if (stats.isFile()) result.push({ path, type: 'file', sha256: await fileHash(absolute), size: stats.size })
    else if (stats.isSymbolicLink()) {
      const target = await readlink(absolute)
      const resolvedTarget = await realpath(resolve(dirname(absolute), target))
      const fromRoot = relative(root, resolvedTarget)
      if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) throw new Error(`环境包含逃逸备份根目录的符号链接：${path}`)
      result.push({ path, type: 'symlink', sha256: createHash('sha256').update(target).digest('hex'), size: Buffer.byteLength(target) })
    } else throw new Error(`环境包含无法备份的特殊文件：${path}`)
  }
  return result.sort((left, right) => left.path.localeCompare(right.path))
}

async function writeSynced(path: string, content: string): Promise<void> {
  const file = await open(path, 'w', 0o600)
  try {
    await file.writeFile(content, 'utf8')
    await file.sync()
  } finally {
    await file.close()
  }
}

async function atomicWriteSynced(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  try {
    await writeSynced(temporary, content)
    await rename(temporary, path)
    await syncDirectory(dirname(path))
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export class EnvironmentBackupService {
  readonly #root: string

  constructor(dataRoot: string) {
    this.#root = join(dataRoot, 'backups')
  }

  async create(environment: EnvironmentRecord): Promise<BackupRecord> {
    const id = `backup-${randomUUID()}`
    const root = join(this.#root, id)
    const partial = `${root}.partial`
    const home = join(partial, 'home')
    await mkdir(partial, { recursive: true, mode: 0o700 })
    try {
      await cp(environment.path, home, { recursive: true, preserveTimestamps: true, force: false, errorOnExist: true, verbatimSymlinks: true })
      const files = await entries(home)
      const manifest = `${JSON.stringify({ version: 1, environmentId: environment.id, sourcePath: environment.path, createdAt: new Date().toISOString(), files }, null, 2)}\n`
      const manifestPath = join(partial, 'manifest.json')
      await writeSynced(manifestPath, manifest)
      await writeSynced(join(partial, 'READY'), `${createHash('sha256').update(manifest).digest('hex')}\n`)
      await syncDirectory(partial)
      await mkdir(this.#root, { recursive: true, mode: 0o700 })
      await rename(partial, root)
      await syncDirectory(this.#root)
      return { id, environmentId: environment.id, path: root, manifestPath: join(root, 'manifest.json'), status: 'ready', createdAt: new Date().toISOString() }
    } catch (error) {
      await rm(partial, { recursive: true, force: true })
      throw error
    }
  }

  async verify(backup: BackupRecord): Promise<void> {
    const manifestText = await readFile(backup.manifestPath, 'utf8')
    const ready = (await readFile(join(backup.path, 'READY'), 'utf8')).trim()
    if (ready !== createHash('sha256').update(manifestText).digest('hex')) throw new Error('环境备份 READY 摘要与清单不一致')
    const manifest = JSON.parse(manifestText) as { version?: unknown; files?: unknown }
    if (manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error('环境备份清单无效')
    const actual = await entries(join(backup.path, 'home'))
    if (JSON.stringify(manifest.files) !== JSON.stringify(actual)) throw new Error('环境备份完整性校验失败')
  }

  async recoverRestore(backup: BackupRecord, environment: EnvironmentRecord, finalize = false): Promise<boolean> {
    const journalPath = join(backup.path, 'restore-journal.json')
    let journal: RestoreJournal
    try {
      journal = JSON.parse(await readFile(journalPath, 'utf8')) as RestoreJournal
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
    if (journal.version !== 1 || journal.environmentId !== environment.id || journal.canonical !== environment.path) throw new Error('环境恢复 journal 无效')
    const canonicalExists = await exists(journal.canonical)
    const stagingExists = await exists(journal.staging)
    const diagnosticExists = await exists(journal.diagnostic)
    if (!canonicalExists && stagingExists && diagnosticExists) {
      await rename(journal.staging, journal.canonical)
      await syncDirectory(dirname(journal.canonical))
    } else if (!canonicalExists && diagnosticExists) {
      await rename(journal.diagnostic, journal.canonical)
      await syncDirectory(dirname(journal.canonical))
    } else if (!canonicalExists) {
      throw new Error('环境恢复中断且 canonical、staging、diagnostic 均不可用')
    }
    if (await exists(journal.staging)) await rm(journal.staging, { recursive: true, force: true })
    if (finalize) {
      await rm(journalPath, { force: true })
      await syncDirectory(backup.path)
    }
    return true
  }

  async commitRestore(backup: BackupRecord): Promise<void> {
    await rm(join(backup.path, 'restore-journal.json'), { force: true })
    await syncDirectory(backup.path)
  }

  async restore(backup: BackupRecord, environment: EnvironmentRecord): Promise<string> {
    await this.recoverRestore(backup, environment, true)
    await this.verify(backup)
    const suffix = randomUUID()
    const staging = `${environment.path}.restore-${suffix}`
    const diagnostic = `${environment.path}.diagnostic-${suffix}`
    await rm(staging, { recursive: true, force: true })
    await cp(join(backup.path, 'home'), staging, { recursive: true, preserveTimestamps: true, force: false, errorOnExist: true, verbatimSymlinks: true })
    const expected = JSON.parse(await readFile(backup.manifestPath, 'utf8')) as { files: EntryDigest[] }
    if (JSON.stringify(expected.files) !== JSON.stringify(await entries(staging))) {
      await rm(staging, { recursive: true, force: true })
      throw new Error('环境恢复 staging 完整性校验失败')
    }
    const journalPath = join(backup.path, 'restore-journal.json')
    const journal: RestoreJournal = { version: 1, environmentId: environment.id, canonical: environment.path, staging, diagnostic, phase: 'staged-ready' }
    await atomicWriteSynced(journalPath, `${JSON.stringify(journal, null, 2)}\n`)
    await syncDirectory(backup.path)
    await rename(environment.path, diagnostic)
    await syncDirectory(dirname(environment.path))
    journal.phase = 'diagnostic-moved'
    await atomicWriteSynced(journalPath, `${JSON.stringify(journal, null, 2)}\n`)
    try {
      await rename(staging, environment.path)
      await syncDirectory(dirname(environment.path))
      journal.phase = 'restored'
      await atomicWriteSynced(journalPath, `${JSON.stringify(journal, null, 2)}\n`)
    } catch (error) {
      if (!await exists(environment.path) && await exists(diagnostic)) await rename(diagnostic, environment.path)
      await syncDirectory(dirname(environment.path))
      throw error
    }
    return diagnostic
  }
}
