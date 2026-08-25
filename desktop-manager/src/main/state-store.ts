import { copyFile, mkdir, open, readFile, rename } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute } from 'node:path'
import type {
  BackupRecord,
  EnvironmentRecord,
  InstanceRecord,
  InstanceTemplate,
  ManagerSettings,
  ManagerSnapshot,
  OperationRecord,
  PreflightCheck,
  PreflightReport,
  PromotionRecord,
  RuntimeRecord,
  RuntimeTaskRecord,
} from '../shared/types.js'

type StoredInstanceV1 = Omit<InstanceRecord, 'automaticPort'> & { automaticPort?: boolean }
type LegacySnapshot = Pick<ManagerSnapshot, 'runtimes' | 'environments' | 'instances'>
interface StoredStateV1 extends Omit<LegacySnapshot, 'instances'> {
  version: 1
  instances: StoredInstanceV1[]
}
interface StoredStateV2 extends LegacySnapshot { version: 2 }
interface StoredState extends ManagerSnapshot { version: 3 }

const DEFAULT_SETTINGS: ManagerSettings = { openMode: 'embedded', checkUpdatesOnStartup: true }
const EMPTY_STATE: StoredState = {
  version: 3,
  settings: DEFAULT_SETTINGS,
  runtimes: [],
  environments: [],
  instances: [],
  tasks: [],
  backups: [],
  promotions: [],
  operations: [],
  templates: [],
}
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
    ...(report.buildFingerprint === undefined ? {} : { buildFingerprint: stringValue(report.buildFingerprint, 'runtime buildFingerprint') }),
    checks: report.checks.map(decodeCheck),
  }
}

function decodeRuntime(value: unknown): RuntimeRecord {
  const runtime = objectValue(value, 'runtime')
  if (runtime.immutable !== undefined && typeof runtime.immutable !== 'boolean') throw new Error('runtime immutable is invalid')
  return {
    id: stringValue(runtime.id, 'runtime id'),
    name: stringValue(runtime.name, 'runtime name'),
    source: enumValue(runtime.source, SOURCE_VALUES, 'runtime source'),
    path: pathValue(runtime.path, 'runtime path'),
    ...(runtime.managedPath === undefined ? {} : { managedPath: pathValue(runtime.managedPath, 'runtime managedPath') }),
    ...(runtime.integrity === undefined ? {} : { integrity: stringValue(runtime.integrity, 'runtime integrity') }),
    ...(runtime.installReceiptPath === undefined ? {} : { installReceiptPath: pathValue(runtime.installReceiptPath, 'runtime installReceiptPath') }),
    ...(runtime.version === undefined ? {} : { version: stringValue(runtime.version, 'runtime version') }),
    ...(runtime.taskBlocked === undefined ? {} : { taskBlocked: stringValue(runtime.taskBlocked, 'runtime taskBlocked') }),
    ...(runtime.immutable === undefined ? {} : { immutable: runtime.immutable }),
    ...(runtime.worktreeSourcePath === undefined ? {} : { worktreeSourcePath: pathValue(runtime.worktreeSourcePath, 'runtime worktreeSourcePath') }),
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

function decodeInstance(value: unknown, version: 1 | 2 | 3): StoredInstanceV1 | InstanceRecord {
  const instance = objectValue(value, 'instance')
  const port = instance.port
  if (!Number.isInteger(port) || (port as number) < 0 || (port as number) > 65_535) throw new Error('instance port is invalid')
  if (version !== 1 && typeof instance.automaticPort !== 'boolean') throw new Error('instance automaticPort is invalid')
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

function decodeSettings(value: unknown): ManagerSettings {
  const settings = objectValue(value, 'settings')
  if (typeof settings.checkUpdatesOnStartup !== 'boolean') throw new Error('settings checkUpdatesOnStartup is invalid')
  return {
    openMode: enumValue(settings.openMode, ['embedded', 'external'] as const, 'settings openMode'),
    checkUpdatesOnStartup: settings.checkUpdatesOnStartup,
    ...(settings.defaultRuntimeId === undefined ? {} : { defaultRuntimeId: stringValue(settings.defaultRuntimeId, 'settings defaultRuntimeId') }),
    ...(settings.productionInstanceId === undefined ? {} : { productionInstanceId: stringValue(settings.productionInstanceId, 'settings productionInstanceId') }),
  }
}

function decodeTask(value: unknown): RuntimeTaskRecord {
  const task = objectValue(value, 'runtime task')
  return {
    id: stringValue(task.id, 'task id'),
    requestId: stringValue(task.requestId, 'task requestId'),
    runtimeId: stringValue(task.runtimeId, 'task runtimeId'),
    kind: enumValue(task.kind, ['install', 'typecheck', 'test', 'build'] as const, 'task kind'),
    status: enumValue(task.status, ['prepared', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'] as const, 'task status'),
    phase: stringValue(task.phase, 'task phase'),
    logPath: pathValue(task.logPath, 'task logPath'),
    createdAt: timestampValue(task.createdAt, 'task createdAt'),
    ...(task.startedAt === undefined ? {} : { startedAt: timestampValue(task.startedAt, 'task startedAt') }),
    ...(task.finishedAt === undefined ? {} : { finishedAt: timestampValue(task.finishedAt, 'task finishedAt') }),
    ...(task.pid === undefined ? {} : { pid: Number.isInteger(task.pid) && (task.pid as number) > 0 ? task.pid as number : (() => { throw new Error('task pid is invalid') })() }),
    ...(task.error === undefined ? {} : { error: stringValue(task.error, 'task error') }),
  }
}

function decodeBackup(value: unknown): BackupRecord {
  const backup = objectValue(value, 'backup')
  return {
    id: stringValue(backup.id, 'backup id'),
    environmentId: stringValue(backup.environmentId, 'backup environmentId'),
    path: pathValue(backup.path, 'backup path'),
    manifestPath: pathValue(backup.manifestPath, 'backup manifestPath'),
    status: enumValue(backup.status, ['ready', 'failed'] as const, 'backup status'),
    createdAt: timestampValue(backup.createdAt, 'backup createdAt'),
    ...(backup.error === undefined ? {} : { error: stringValue(backup.error, 'backup error') }),
  }
}

function decodePromotion(value: unknown): PromotionRecord {
  const promotion = objectValue(value, 'promotion')
  return {
    id: stringValue(promotion.id, 'promotion id'),
    candidateInstanceId: stringValue(promotion.candidateInstanceId, 'promotion candidateInstanceId'),
    productionInstanceId: stringValue(promotion.productionInstanceId, 'promotion productionInstanceId'),
    previousRuntimeId: stringValue(promotion.previousRuntimeId, 'promotion previousRuntimeId'),
    targetRuntimeId: stringValue(promotion.targetRuntimeId, 'promotion targetRuntimeId'),
    backupId: stringValue(promotion.backupId, 'promotion backupId'),
    ...(promotion.previousBuildFingerprint === undefined ? {} : { previousBuildFingerprint: stringValue(promotion.previousBuildFingerprint, 'promotion previousBuildFingerprint') }),
    ...(promotion.targetBuildFingerprint === undefined ? {} : { targetBuildFingerprint: stringValue(promotion.targetBuildFingerprint, 'promotion targetBuildFingerprint') }),
    status: enumValue(promotion.status, ['awaiting-confirmation', 'committed', 'rolled-back', 'failed'] as const, 'promotion status'),
    createdAt: timestampValue(promotion.createdAt, 'promotion createdAt'),
    updatedAt: timestampValue(promotion.updatedAt, 'promotion updatedAt'),
    ...(promotion.error === undefined ? {} : { error: stringValue(promotion.error, 'promotion error') }),
  }
}

function decodeOperation(value: unknown): OperationRecord {
  const operation = objectValue(value, 'operation')
  if (!Array.isArray(operation.resourceKeys) || !operation.resourceKeys.every(item => typeof item === 'string' && item.length > 0)) throw new Error('operation resourceKeys are invalid')
  const rawInput = objectValue(operation.input, 'operation input')
  const input: OperationRecord['input'] = {}
  for (const [key, item] of Object.entries(rawInput)) {
    if (item !== null && typeof item !== 'string' && typeof item !== 'boolean' && typeof item !== 'number') throw new Error('operation input value is invalid')
    input[key] = item
  }
  const rawArtifacts = objectValue(operation.artifacts, 'operation artifacts')
  const artifacts: Record<string, string> = {}
  for (const [key, item] of Object.entries(rawArtifacts)) artifacts[key] = stringValue(item, 'operation artifact')
  if (operation.restartInstanceIds !== undefined && (!Array.isArray(operation.restartInstanceIds) || !operation.restartInstanceIds.every(item => typeof item === 'string' && item.length > 0))) throw new Error('operation restartInstanceIds are invalid')
  return {
    id: stringValue(operation.id, 'operation id'),
    requestId: stringValue(operation.requestId, 'operation requestId'),
    type: enumValue(operation.type, ['runtime-install', 'runtime-task', 'delete-instance', 'delete-environment', 'delete-runtime', 'backup', 'promotion', 'rollback'] as const, 'operation type'),
    status: enumValue(operation.status, ['prepared', 'running', 'awaiting-confirmation', 'recovery-required', 'committed', 'rolled-back', 'failed'] as const, 'operation status'),
    phase: stringValue(operation.phase, 'operation phase'),
    resourceKeys: [...operation.resourceKeys] as string[],
    input,
    artifacts,
    ...(operation.restartInstanceIds === undefined ? {} : { restartInstanceIds: [...operation.restartInstanceIds] as string[] }),
    ...(operation.error === undefined ? {} : { error: stringValue(operation.error, 'operation error') }),
    createdAt: timestampValue(operation.createdAt, 'operation createdAt'),
    updatedAt: timestampValue(operation.updatedAt, 'operation updatedAt'),
  }
}

function decodeTemplate(value: unknown): InstanceTemplate {
  const template = objectValue(value, 'instance template')
  const port = template.port
  if (!Number.isInteger(port) || (port as number) < 0 || (port as number) > 65_535) throw new Error('template port is invalid')
  const environmentMode = enumValue(template.environmentMode, ['new-isolated', 'existing'] as const, 'template environmentMode')
  const environmentId = optionalString(template.environmentId, 'template environmentId')
  if (environmentMode === 'existing' && !environmentId) throw new Error('existing-environment template has no environmentId')
  return {
    id: stringValue(template.id, 'template id'),
    name: stringValue(template.name, 'template name'),
    runtimeId: stringValue(template.runtimeId, 'template runtimeId'),
    workspacePath: pathValue(template.workspacePath, 'template workspacePath'),
    environmentMode,
    ...(environmentId ? { environmentId } : {}),
    port: port as number,
    createdAt: timestampValue(template.createdAt, 'template createdAt'),
  }
}

function uniqueIds(items: Array<{ id: string }>, label: string): Set<string> {
  const ids = new Set<string>()
  for (const item of items) {
    if (ids.has(item.id)) throw new Error(`manager state has a duplicate ${label} id`)
    ids.add(item.id)
  }
  return ids
}

function parseStoredState(content: string): StoredStateV1 | StoredStateV2 | StoredState {
  const raw: unknown = JSON.parse(content)
  const root = objectValue(raw, 'manager state')
  if (typeof root.version === 'number' && root.version > 3) throw new FutureStateVersionError(`manager state version ${root.version} is newer than supported version 3`)
  if (root.version !== 1 && root.version !== 2 && root.version !== 3) throw new Error('unsupported manager state format')
  if (!Array.isArray(root.runtimes) || !Array.isArray(root.environments) || !Array.isArray(root.instances)) throw new Error('manager state collections are invalid')

  const runtimes = root.runtimes.map(decodeRuntime)
  const environments = root.environments.map(decodeEnvironment)
  const instances = root.instances.map(value => decodeInstance(value, root.version as 1 | 2 | 3))
  const runtimeIds = uniqueIds(runtimes, 'runtime')
  const environmentIds = uniqueIds(environments, 'environment')
  const instanceIds = uniqueIds(instances, 'instance')
  for (const instance of instances) {
    if (!runtimeIds.has(instance.runtimeId) || !environmentIds.has(instance.environmentId)) throw new Error(`manager state instance ${instance.id} has a missing runtime or environment`)
  }
  if (root.version === 1) return { version: 1, runtimes, environments, instances: instances as StoredInstanceV1[] }
  if (root.version === 2) return { version: 2, runtimes, environments, instances: instances as InstanceRecord[] }

  if (!Array.isArray(root.tasks) || !Array.isArray(root.backups) || !Array.isArray(root.promotions) || !Array.isArray(root.operations) || !Array.isArray(root.templates)) throw new Error('manager workflow collections are invalid')
  const settings = decodeSettings(root.settings)
  const tasks = root.tasks.map(decodeTask)
  const backups = root.backups.map(decodeBackup)
  const promotions = root.promotions.map(decodePromotion)
  const operations = root.operations.map(decodeOperation)
  const templates = root.templates.map(decodeTemplate)
  uniqueIds(tasks, 'task')
  const backupIds = uniqueIds(backups, 'backup')
  uniqueIds(promotions, 'promotion')
  uniqueIds(operations, 'operation')
  uniqueIds(templates, 'template')
  if (settings.defaultRuntimeId && !runtimeIds.has(settings.defaultRuntimeId)) throw new Error('manager default runtime is missing')
  if (settings.productionInstanceId && !instanceIds.has(settings.productionInstanceId)) throw new Error('manager production instance is missing')
  for (const task of tasks) {
    if ((task.status === 'prepared' || task.status === 'running') && !runtimeIds.has(task.runtimeId)) throw new Error(`active task ${task.id} has a missing runtime`)
  }
  for (const promotion of promotions) {
    if (!backupIds.has(promotion.backupId)) throw new Error(`promotion ${promotion.id} has a missing backup`)
  }
  for (const template of templates) {
    if (!runtimeIds.has(template.runtimeId)) throw new Error(`template ${template.id} has a missing runtime`)
    if (template.environmentMode === 'existing' && (!template.environmentId || !environmentIds.has(template.environmentId))) throw new Error(`template ${template.id} has a missing environment`)
  }
  const activeResourceKeys = new Set<string>()
  for (const operation of operations) {
    if (operation.status === 'committed' || operation.status === 'rolled-back' || operation.status === 'failed') continue
    for (const key of operation.resourceKeys) {
      if (activeResourceKeys.has(key)) throw new Error(`manager state has conflicting active resource ${key}`)
      activeResourceKeys.add(key)
    }
  }
  return { version: 3, settings, runtimes, environments, instances: instances as InstanceRecord[], tasks, backups, promotions, operations, templates }
}

function migrate(state: StoredStateV1 | StoredStateV2 | StoredState): { state: StoredState; changed: boolean } {
  if (state.version === 3) return { state, changed: false }
  const instances = state.version === 1
    ? state.instances.map(instance => {
      const knownMode = typeof instance.automaticPort === 'boolean'
      const automaticPort = knownMode ? instance.automaticPort! : instance.port === 0
      return { ...instance, automaticPort, ...(!knownMode && instance.port > 0 ? { portModeReviewRequired: true } : {}) }
    })
    : state.instances
  const defaultRuntimeId = state.runtimes[0]?.id
  return {
    state: {
      version: 3,
      settings: { ...DEFAULT_SETTINGS, ...(defaultRuntimeId ? { defaultRuntimeId } : {}) },
      runtimes: state.runtimes,
      environments: state.environments,
      instances,
      tasks: [],
      backups: [],
      promotions: [],
      operations: [],
      templates: [],
    },
    changed: true,
  }
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
    let stored: StoredStateV1 | StoredStateV2 | StoredState | undefined
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
      settings: this.#state.settings,
      runtimes: this.#state.runtimes,
      environments: this.#state.environments,
      instances: this.#state.instances,
      tasks: this.#state.tasks,
      backups: this.#state.backups,
      promotions: this.#state.promotions,
      operations: this.#state.operations,
      templates: this.#state.templates,
    })
  }

  async update(mutator: (draft: ManagerSnapshot) => void): Promise<ManagerSnapshot> {
    let committed: ManagerSnapshot | undefined
    const operation = this.#writeQueue.then(async () => {
      const next = this.snapshot()
      mutator(next)
      const encoded: StoredState = { version: 3, ...next }
      const candidate = parseStoredState(JSON.stringify(encoded))
      if (candidate.version !== 3) throw new Error('manager state update did not produce version 3')
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
