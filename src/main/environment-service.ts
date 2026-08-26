import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, realpath, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type {
  CloneEnvironmentInput,
  CreateEnvironmentInput,
  EnvironmentLineage,
  EnvironmentRecord,
  InstanceRecord,
  RuntimeRecord,
} from '../shared/types.js'

const execFileAsync = promisify(execFile)

function environmentId(): string {
  return `env-${randomUUID()}`
}

export interface StagedEnvironmentDeletion {
  original: string
  staged: string
}

export class EnvironmentService {
  readonly #root: string

  constructor(root: string) {
    this.#root = root
  }

  async create(input: CreateEnvironmentInput): Promise<EnvironmentRecord> {
    const id = environmentId()
    const path = input.kind === 'production'
      ? await this.#productionPath(input.path)
      : join(this.#root, id, 'home')
    await mkdir(path, { recursive: true, mode: 0o700 })
    return {
      id,
      name: input.name,
      kind: input.kind,
      path,
      createdAt: new Date().toISOString(),
    }
  }

  planDiscard(environment: EnvironmentRecord): StagedEnvironmentDeletion | undefined {
    if (environment.kind === 'production') return undefined
    const original = join(this.#root, environment.id)
    return { original, staged: `${original}.deleting-${randomUUID()}` }
  }

  async stageDiscard(environment: EnvironmentRecord, planned = this.planDiscard(environment)): Promise<StagedEnvironmentDeletion | undefined> {
    if (!planned) return undefined
    await rename(planned.original, planned.staged)
    return planned
  }

  async restoreDiscard(staged: StagedEnvironmentDeletion): Promise<void> {
    await rename(staged.staged, staged.original)
  }

  async finalizeDiscard(staged: StagedEnvironmentDeletion): Promise<void> {
    await rm(staged.staged, { recursive: true, force: true })
  }

  async discard(environment: EnvironmentRecord): Promise<void> {
    if (environment.kind === 'production') return
    await rm(join(this.#root, environment.id), { recursive: true, force: true })
  }

  async clone(
    input: CloneEnvironmentInput,
    source: EnvironmentRecord,
    sourceInstance: InstanceRecord | undefined,
    sourceRuntime: RuntimeRecord,
  ): Promise<EnvironmentRecord> {
    const id = environmentId()
    const environmentRoot = join(this.#root, id)
    const target = join(environmentRoot, 'home')
    const temporary = join(environmentRoot, 'home.partial')
    await mkdir(temporary, { recursive: true, mode: 0o700 })

    let method: EnvironmentLineage['method'] = 'apfs-clone'
    try {
      try {
        await execFileAsync('/bin/cp', ['-c', '-R', `${source.path}/.`, temporary], {
          timeout: 60_000,
          maxBuffer: 1024 * 1024,
        })
      } catch {
        method = 'copy'
        await rm(temporary, { recursive: true, force: true })
        await mkdir(temporary, { recursive: true, mode: 0o700 })
        await cp(source.path, temporary, { recursive: true, force: false, errorOnExist: true })
      }
      await rm(join(temporary, 'profiles', 'node_modules'), { recursive: true, force: true })
      await rename(temporary, target)
    } catch (error) {
      await rm(environmentRoot, { recursive: true, force: true })
      throw error
    }

    return {
      id,
      name: input.name,
      kind: 'clone',
      path: target,
      createdAt: new Date().toISOString(),
      lineage: {
        sourceEnvironmentId: source.id,
        ...(sourceInstance ? { sourceInstanceId: sourceInstance.id } : {}),
        sourceRuntimeId: sourceRuntime.id,
        ...(sourceRuntime.preflight.gitCommit ? { sourceRuntimeCommit: sourceRuntime.preflight.gitCommit } : {}),
        clonedAt: new Date().toISOString(),
        method,
      },
    }
  }

  async #productionPath(path: string | undefined): Promise<string> {
    if (!path) throw new Error('A production environment requires an existing DSH_HOME path')
    return realpath(path)
  }
}
