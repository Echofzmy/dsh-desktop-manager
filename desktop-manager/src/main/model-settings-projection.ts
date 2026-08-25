import { randomUUID } from 'node:crypto'
import { mkdir, lstat, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseDocument } from 'yaml'

const SHARED_NAMESPACES = [
  'llm-deepseek',
  'llm-pi-ai',
  'agent-default-model',
  'permission',
  'agent-presets',
  'locale',
  'ui-theme',
  'ui-conversation',
] as const

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function lockContention(error: unknown, lockPath: string): Promise<boolean> {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'EEXIST') return true
  if (code !== 'EPERM') return false
  try {
    await lstat(lockPath)
    return true
  } catch {
    return false
  }
}

async function withSettingsLock<T>(filename: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${filename}.lock`
  const deadline = Date.now() + 2_000
  let delay = 20
  for (;;) {
    try {
      await writeFile(lockPath, `${process.pid}\n`, { mode: 0o600, flag: 'wx' })
      break
    } catch (error) {
      if (!await lockContention(error, lockPath)) throw error
    }
    if (Date.now() >= deadline) throw new Error(`模型设置写入锁等待超时：${lockPath}`)
    await new Promise(resolve => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, 200)
  }
  try {
    return await operation()
  } finally {
    await rm(lockPath, { force: true })
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const directory = dirname(path)
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = await open(temporaryPath, 'w', 0o600)
  try {
    await temporary.writeFile(content, 'utf8')
    await temporary.sync()
  } finally {
    await temporary.close()
  }
  await rename(temporaryPath, path)
  const directoryHandle = await open(directory, 'r')
  try {
    await directoryHandle.sync()
  } finally {
    await directoryHandle.close()
  }
}

function parseSettings(contents: string, label: string) {
  const document = parseDocument(contents)
  if (document.errors.length) throw new Error(`${label} 无法解析：${document.errors[0]!.message}`)
  const value = document.toJS()
  if (value !== null && (typeof value !== 'object' || Array.isArray(value))) throw new Error(`${label} 根节点必须是 mapping`)
  return document
}

export interface ModelProjectionResult {
  changed: boolean
  credentialRefs: string[]
}

function credentialRefs(value: Record<string, unknown> | null): string[] {
  const refs = new Set(['DEEPSEEK_API_KEY'])
  const add = (candidate: unknown): void => {
    if (candidate === undefined) return
    if (typeof candidate !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(candidate)) throw new Error('共享模型设置包含无效的凭据引用')
    refs.add(candidate)
  }
  const deepseek = value?.['llm-deepseek']
  if (deepseek && typeof deepseek === 'object' && !Array.isArray(deepseek)) add((deepseek as Record<string, unknown>).apiKeyEnv)
  const pi = value?.['llm-pi-ai']
  const providers = pi && typeof pi === 'object' && !Array.isArray(pi) ? (pi as Record<string, unknown>).providers : undefined
  if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
    for (const provider of Object.values(providers)) {
      if (provider && typeof provider === 'object' && !Array.isArray(provider)) add((provider as Record<string, unknown>).apiKeyEnv)
    }
  }
  return [...refs]
}

export class ModelSettingsProjection {
  readonly home: string
  readonly credentialsPath: string
  readonly overlayPath: string
  readonly workspacePath: string

  constructor(dataRoot: string) {
    this.home = join(dataRoot, 'model-configuration', 'home')
    this.credentialsPath = join(this.home, '.credentials.yaml')
    this.overlayPath = join(dataRoot, 'model-configuration', 'credentials.cordis.yml')
    this.workspacePath = join(dataRoot, 'model-configuration', 'workspace')
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.home, { recursive: true, mode: 0o700 }),
      mkdir(this.workspacePath, { recursive: true, mode: 0o700 }),
    ])
    const overlay = `- id: credentials\n  config:\n    path: ${JSON.stringify(this.credentialsPath)}\n    watch: true\n`
    if (await readOptional(this.overlayPath) !== overlay) await atomicWrite(this.overlayPath, overlay)
  }

  async projectInto(targetHome: string): Promise<ModelProjectionResult> {
    const sourcePath = join(this.home, 'settings.yaml')
    const sourceContents = await readOptional(sourcePath)
    const targetPath = join(targetHome, 'settings.yaml')
    const source = parseSettings(sourceContents ?? '{}\n', '共享设置')
    const sourceValue = source.toJS() as Record<string, unknown> | null
    const refs = credentialRefs(sourceValue)
    return withSettingsLock(targetPath, async () => {
      const targetContents = await readOptional(targetPath) ?? ''
      const target = parseSettings(targetContents, '实例设置')
      const editable = target.contents === null ? parseSettings('{}\n', '实例设置') : target
      if (editable !== target) {
        editable.commentBefore = target.commentBefore
        editable.comment = target.comment
      }
      for (const namespace of SHARED_NAMESPACES) {
        if (sourceValue && Object.prototype.hasOwnProperty.call(sourceValue, namespace)) {
          editable.setIn([namespace], structuredClone(sourceValue[namespace]))
        } else {
          editable.deleteIn([namespace])
        }
      }
      const next = editable.toString()
      if (next === targetContents) return { changed: false, credentialRefs: refs }
      await atomicWrite(targetPath, next)
      return { changed: true, credentialRefs: refs }
    })
  }
}
