import { copyFile, mkdir, open, readFile, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute } from 'node:path'
import type { EnvironmentRecord, InstanceRecord, ManagerSnapshot, PreflightCheck, PreflightReport, RuntimeRecord } from '../shared/types.js'

type StoredInstanceV1 = Omit<InstanceRecord, 'automaticPort'> & { automaticPort?: boolean }
interface StoredStateV1 extends Omit<ManagerSnapshot, 'instances'> {
  version: 1
  instances: StoredInstanceV1[]
}
interface StoredState extends ManagerSnapshot { version: 2 }

const EMPTY_STATE: StoredState = { version: 2, runtimes: [], environments: [], instances: [] }
const STATUS_VALUES = ['stopped', 'starting', 'running', 'stopping', 'failed'] as const
const SOURCE_VALUES = ['local', 'bundled', 'downloaded'] as const
const ENVIRONMENT_VALUES = ['isolated', 'clone', 'production'] as const
const LEVEL_VALUES = ['pass', 'warning', 'failure'] as const

class FutureStateVersionError extends Error {}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`)
  return value
}

function pathValue(value: unknown, label: string): string {
  const path = stringValue(value, label)
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`)
  return path
}

function timestampValue(value: unknown, label: string): string {
  const timestamp = stringValue(value, label)
  if (Number.isNaN(Date.parse(timestamp))) throw new Error(`${label} must be a timestamp`)
  return timestamp
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : stringValue(value, label)
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error(`${label} is invalid`)
  return value as T
}

function decodeCheck(value: unknown, index: number): PreflightCheck {
  const check = objectValue(value, `preflight check ${index}`)
  return {
    id: stringValue(check.id, 'preflight check id'),
    label: stringValue(check.label, 'preflight check label'),
    level: enumValue(check.level, LEVEL_VALUES, 'preflight check level'),
    detail: stringValue(check.detail, 'preflight check detail'),
    ...(check.remediation === undefined ? {} : { remediation: stringValue(check.remediation, 'preflight remediation') }),
  }
}

function decodePreflight(value: unknown): PreflightReport {
  const report = objectValue(value, 'runtime preflight')
  if (typeof report.ready !== 'boolean' || !Array.isArray(report.checks)) throw new Error('runtime preflight is incomplete')
  if (report.gitDirty !== undefined && typeof report.gitDirty !== 'boolean') throw new Error('runtime gitDirty is invalid')
  return {
    checkedAt: timestampValue(report.checkedAt, 'preflight checkedAt'),
    ready: report.ready,
    ...(report.entryPath === undefined ? {} : { entryPath: pathValue(report.entryPath, 'preflight entryPath') }),
    ...(report.nodeVersion === undefined ? {} : { nodeVersion: stringValue(report.nodeVersion, 'preflight nodeVersion') }),
    ...(report.pnpmVersion === undefined ? {} : { pnpmVersion: stringValue(report.pnpmVersion, 'preflight pnpmVersion') }),
    ...(report.packageVersion === undefined ? {} : { packageVersion: stringValue(report.packageVersion, 'preflight packageVersion') }),
    ...(report.gitCommit === undefined ? {} : { gitCommit: stringValue(report.gitCommit, 'preflight gitCommit') }),
    ...(report.gitDirty === undefined ? {} : { gitDirty: report.gitDirty }),
    checks: report.checks.map(decodeCheck),
  }
}

function decodeRuntime(value: unknown): RuntimeRecord {
  const runtime = objectValue(value, 'runtime')
  return {
    id: stringValue(runtime.id, 'runtime id'),
    name: stringValue(runtime.name, 'runtime name'),
    source: enumValue(runtime.source, SOURCE_VALUES, 'runtime source'),
    path: pathValue(runtime.path, 'runtime path'),
    registeredAt: timestampValue(runtime.registeredAt, 'runtime registeredAt'),
    preflight: decodePreflight(runtime.preflight),
  }
}

function decodeEnvironment(value: unknown): EnvironmentRecord {
  const environment = objectValue(value, 'environment')
  let lineage: EnvironmentRecord['lineage']
  if (environment.lineage !== undefined) {
    const source = objectValue(environment.lineage, 'environment lineage')
    lineage = {
      sourceEnvironmentId: stringValue(source.sourceEnvironmentId, 'lineage sourceEnvironmentId'),
      sourceRuntimeId: stringValue(source.sourceRuntimeId, 'lineage sourceRuntimeId'),
      clonedAt: timestampValue(source.clonedAt, 'lineage clonedAt'),
      method: enumValue(source.method, ['apfs-clone', 'copy'] as const, 'lineage method'),
      ...(source.sourceInstanceId === undefined ? {} : { sourceInstanceId: stringValue(source.sourceInstanceId, 'lineage sourceInstanceId') }),
      ...(source.sourceRuntimeCommit === undefined ? {} : { sourceRuntimeCommit: stringValue(source.sourceRuntimeCommit, 'lineage sourceRuntimeCommit') }),
    }
  }
  return {
    id: stringValue(environment.id, 'environment id'),
    name: stringValue(environment.name, 'environment name'),
    kind: enumValue(environment.kind, ENVIRONMENT_VALUES, 'environment kind'),
    path: pathValue(environment.path, 'environment path'),
    createdAt: timestampValue(environment.createdAt, 'environment createdAt'),
    ...(lineage ? { lineage } : {}),
  }
}

function decodeInstance(value: unknown, version: 1 | 2): StoredInstanceV1 | InstanceRecord {
  const instance = objectValue(value, 'instance')
  const port = instance.port
  if (!Number.isInteger(port) || (port as number) < 0 || (port as number) > 65_535) throw new Error('instance port is invalid')
  if (version === 2 && typeof instance.automaticPort !== 'boolean') throw new Error('instance automaticPort is invalid')
  if (instance.automaticPort !== undefined && typeof instance.automaticPort !== 'boolean') throw new Error('instance automaticPort is invalid')
  if (instance.portModeReviewRequired !== undefined && typeof instance.portModeReviewRequired !== 'boolean') throw new Error('instance portModeReviewRequired is invalid')
  if (instance.interrupted !== undefined && typeof instance.interrupted !== 'boolean') throw new Error('instance interrupted is invalid')
  if (instance.pid !== undefined && (!Number.isInteger(instance.pid) || (instance.pid as number) <= 0)) throw new Error('instance pid is invalid')
  if (instance.exitCode !== undefined && instance.exitCode !== null && !Number.isInteger(instance.exitCode)) throw new Error('instance exitCode is invalid')
  let health: InstanceRecord['health']
  if (instance.health !== undefined) {
    const candidate = objectValue(instance.health, 'instance health')
    if (typeof candidate.ok !== 'boolean') throw new Error('instance health ok is invalid')
    health = { checkedAt: timestampValue(candidate.checkedAt, 'health checkedAt'), ok: candidate.ok, detail: stringValue(candidate.detail, 'health detail') }
  }
  const decoded = {
    id: stringValue(instance.id, 'instance id'),
    name: stringValue(instance.name, 'instance name'),
    runtimeId: stringValue(instance.runtimeId, 'instance runtimeId'),
    workspacePath: pathValue(instance.workspacePath, 'instance workspacePath'),
    environmentId: stringValue(instance.environmentId, 'instance environmentId'),
    port: port as number,
    ...(instance.automaticPort === undefined ? {} : { automaticPort: instance.automaticPort }),
    ...(instance.portModeReviewRequired === undefined ? {} : { portModeReviewRequired: instance.portModeReviewRequired }),
    ...(instance.interrupted === undefined ? {} : { interrupted: instance.interrupted }),
    createdAt: timestampValue(instance.createdAt, 'instance createdAt'),
    status: enumValue(instance.status, STATUS_VALUES, 'instance status'),
    ...(instance.pid === undefined ? {} : { pid: instance.pid as number }),
    ...(instance.startedAt === undefined ? {} : { startedAt: timestampValue(instance.startedAt, 'instance startedAt') }),
    ...(instance.stoppedAt === undefined ? {} : { stoppedAt: timestampValue(instance.stoppedAt, 'instance stoppedAt') }),
    ...(instance.exitCode === undefined ? {} : { exitCode: instance.exitCode as number | null }),
    ...(instance.lastError === undefined ? {} : { lastError: stringValue(instance.lastError, 'instance lastError') }),
    ...(health ? { health } : {}),
  }
  return decoded as StoredInstanceV1 | InstanceRecord
}

function uniqueIds(items: Array<{ id: string }>, label: string): Set<string> {
  const ids = new Set<string>()
  for (const item of items) {
    if (ids.has(item.id)) throw new Error(`manager state has a duplicate ${label} id`)
    ids.add(item.id)
  }
  return ids
}

function parseStoredState(content: string): StoredStateV1 | StoredState {
  const raw: unknown = JSON.parse(content)
  const root = objectValue(raw, 'manager state')
  if (typeof root.version === 'number' && root.version > 2) throw new FutureStateVersionError(`manager state version ${root.version} is newer than supported version 2`)
  if (root.version !== 1 && root.version !== 2) throw new Error('unsupported manager state format')
  if (!Array.isArray(root.runtimes) || !Array.isArray(root.environments) || !Array.isArray(root.instances)) throw new Error('manager state collections are invalid')

  const runtimes = root.runtimes.map(decodeRuntime)
  const environments = root.environments.map(decodeEnvironment)
  const instances = root.instances.map(value => decodeInstance(value, root.version as 1 | 2))
  const runtimeIds = uniqueIds(runtimes, 'runtime')
  const environmentIds = uniqueIds(environments, 'environment')
  const instanceIds = uniqueIds(instances, 'instance')
  for (const instance of instances) {
    if (!runtimeIds.has(instance.runtimeId) || !environmentIds.has(instance.environmentId)) throw new Error(`manager state instance ${instance.id} has a missing runtime or environment`)
  }
  for (const environment of environments) {
    if (!environment.lineage) continue
    if (!environmentIds.has(environment.lineage.sourceEnvironmentId) || !runtimeIds.has(environment.lineage.sourceRuntimeId)) throw new Error(`manager state environment ${environment.id} has invalid lineage`)
    if (environment.lineage.sourceInstanceId && !instanceIds.has(environment.lineage.sourceInstanceId)) throw new Error(`manager state environment ${environment.id} has a missing source instance`)
  }
  return root.version === 1
    ? { version: 1, runtimes, environments, instances: instances as StoredInstanceV1[] }
    : { version: 2, runtimes, environments, instances: instances as InstanceRecord[] }
}

function migrate(state: StoredStateV1 | StoredState): { state: StoredState; changed: boolean } {
  if (state.version === 2) return { state, changed: false }
  const instances = state.instances.map(instance => {
    const knownMode = typeof instance.automaticPort === 'boolean'
    const automaticPort = knownMode ? instance.automaticPort! : instance.port === 0
    return { ...instance, automaticPort, ...(!knownMode && instance.port > 0 ? { portModeReviewRequired: true } : {}) }
  })
  return { state: { version: 2, runtimes: state.runtimes, environments: state.environments, instances }, changed: true }
}

export class StateStore {
  readonly #path: string
  readonly #backupPath: string
  #state: StoredState = structuredClone(EMPTY_STATE)
  #writeQueue: Promise<void> = Promise.resolve()

  constructor(path: string) {
    this.#path = path
    this.#backupPath = `${path}.bak`
  }

  async load(): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 })
    let stored: StoredStateV1 | StoredState | undefined
    let recoveredFromBackup = false
    try {
      stored = parseStoredState(await readFile(this.#path, 'utf8'))
    } catch (primaryError) {
      if (primaryError instanceof FutureStateVersionError) throw primaryError
      try {
        stored = parseStoredState(await readFile(this.#backupPath, 'utf8'))
        recoveredFromBackup = true
      } catch (backupError) {
        if ((primaryError as NodeJS.ErrnoException).code !== 'ENOENT' || (backupError as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new AggregateError([primaryError, backupError], 'manager state and backup are unreadable')
        }
      }
    }

    if (!stored) {
      await this.#persist()
      return
    }
    const migrated = migrate(stored)
    this.#state = migrated.state
    if (recoveredFromBackup) await this.#persist(this.#state, true)
    else if (migrated.changed) await this.#persist()
  }

  snapshot(): ManagerSnapshot {
    return structuredClone({
      runtimes: this.#state.runtimes,
      environments: this.#state.environments,
      instances: this.#state.instances,
    })
  }

  async update(mutator: (draft: ManagerSnapshot) => void): Promise<ManagerSnapshot> {
    let committed: ManagerSnapshot | undefined
    const operation = this.#writeQueue.then(async () => {
      const next = this.snapshot()
      mutator(next)
      const candidate: StoredState = { version: 2, ...next }
      await this.#persist(candidate)
      this.#state = candidate
      committed = this.snapshot()
    })
    this.#writeQueue = operation.then(() => undefined, () => undefined)
    await operation
    return committed!
  }

  async #persist(state: StoredState = this.#state, preserveBackup = false): Promise<void> {
    const directory = dirname(this.#path)
    const temporaryPath = `${this.#path}.${process.pid}.tmp`
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const temporary = await open(temporaryPath, 'w', 0o600)
    try {
      await temporary.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8')
      await temporary.sync()
    } finally {
      await temporary.close()
    }

    const syncDirectory = async (): Promise<void> => {
      const directoryHandle = await open(directory, 'r')
      try {
        await directoryHandle.sync()
      } finally {
        await directoryHandle.close()
      }
    }

    if (preserveBackup) {
      try {
        await rename(this.#path, `${this.#path}.corrupt.${Date.now()}.${randomUUID()}`)
        await syncDirectory()
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    } else {
      const backupTemporaryPath = `${this.#backupPath}.${process.pid}.${randomUUID()}.tmp`
      try {
        await copyFile(this.#path, backupTemporaryPath)
        const backupTemporary = await open(backupTemporaryPath, 'r+')
        try {
          await backupTemporary.sync()
        } finally {
          await backupTemporary.close()
        }
        await rename(backupTemporaryPath, this.#backupPath)
        await syncDirectory()
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    await rename(temporaryPath, this.#path)
    await syncDirectory()
  }
}
