import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, cp, mkdir, realpath, rename, rm } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { EnvironmentBackupService } from './environment-backup.js'
import { EnvironmentService } from './environment-service.js'
import { InstanceSupervisor, portAvailable, processGroupAlive } from './instance-supervisor.js'
import { ModelConfigurationService } from './model-configuration-service.js'
import { ModelSettingsProjection } from './model-settings-projection.js'
import { preflightRuntime } from './runtime-preflight.js'
import { RuntimeTaskRunner } from './runtime-task-runner.js'
import { discoverBundledRuntime, verifyOfficialRuntime } from './runtime/catalog.js'
import { OfficialRuntimeInstaller } from './runtime/installer.js'
import { checkOfficialUpdate } from './runtime/registry-client.js'
import { StateStore } from './state-store.js'
import type {
  BackupRecord,
  CloneEnvironmentInput,
  CreateEnvironmentInput,
  CreateInstanceInput,
  CreateWorktreeInput,
  EnvironmentRecord,
  InstanceRecord,
  InstanceTemplate,
  InstallOfficialRuntimeInput,
  ManagerSnapshot,
  OfficialUpdateInfo,
  OperationRecord,
  PromotionRecord,
  RegisterRuntimeInput,
  RuntimeRecord,
  RuntimeTaskKind,
  RuntimeTaskRecord,
  SaveUnifiedConfigurationInput,
  SetUnifiedCredentialInput,
  UnifiedConfiguration,
  UpdateSettingsInput,
} from '../shared/types.js'

const execFileAsync = promisify(execFile)

async function pathExists(path: string): Promise<boolean> {
  try { await access(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim()
  if (!normalized) throw new Error(`${label} is required`)
  return normalized
}

function requiredById<T extends { id: string }>(items: T[], id: string, label: string): T {
  const value = items.find(item => item.id === id)
  if (!value) throw new Error(`${label} ${id} does not exist`)
  return value
}

export class ManagerService {
  readonly #store: StateStore
  readonly #dataRoot: string
  readonly #bundledRuntimeRoot: string | undefined
  readonly #supervisor: InstanceSupervisor
  readonly #environments: EnvironmentService
  readonly #backups: EnvironmentBackupService
  readonly #officialInstaller: OfficialRuntimeInstaller
  readonly #modelSettings: ModelSettingsProjection
  readonly #modelConfiguration: ModelConfigurationService
  readonly #taskRunner = new RuntimeTaskRunner()
  readonly #listeners = new Set<(snapshot: ManagerSnapshot) => void>()
  readonly #environmentReservations = new Set<string>()
  readonly #runtimeReservations = new Set<string>()

  constructor(dataRoot: string, bundledRuntimeRoot?: string) {
    this.#dataRoot = dataRoot
    this.#bundledRuntimeRoot = bundledRuntimeRoot
    this.#store = new StateStore(join(dataRoot, 'manager-state.json'))
    this.#supervisor = new InstanceSupervisor(join(dataRoot, 'logs'), {
      onStatus: async (instanceId, patch) => {
        await this.#store.update(draft => {
          const index = draft.instances.findIndex(instance => instance.id === instanceId)
          if (index < 0) return
          draft.instances[index] = { ...draft.instances[index]!, ...patch }
        })
        this.#emit()
      },
    })
    this.#environments = new EnvironmentService(join(dataRoot, 'environments'))
    this.#backups = new EnvironmentBackupService(dataRoot)
    this.#officialInstaller = new OfficialRuntimeInstaller(dataRoot)
    this.#modelSettings = new ModelSettingsProjection(dataRoot)
    this.#modelConfiguration = new ModelConfigurationService(this.#modelSettings)
  }

  async initialize(): Promise<void> {
    await this.#modelSettings.initialize()
    await this.#store.load()
    const recoveredRestoreEnvironmentIds: string[] = []
    for (const backup of this.snapshot().backups) {
      const environment = this.snapshot().environments.find(item => item.id === backup.environmentId)
      if (environment && await this.#backups.recoverRestore(backup, environment)) recoveredRestoreEnvironmentIds.push(environment.id)
    }
    if (recoveredRestoreEnvironmentIds.length) await this.#store.update(draft => {
      const recovered = new Set(recoveredRestoreEnvironmentIds)
      for (const instance of draft.instances) {
        if (!recovered.has(instance.environmentId)) continue
        instance.status = 'failed'; instance.interrupted = true
        instance.lastError = '环境恢复在运行版本元数据提交前中断，需要重新执行生产回退。'
      }
      for (const operation of draft.operations) {
        if (operation.type !== 'promotion' && operation.type !== 'rollback') continue
        const production = draft.instances.find(instance => instance.id === operation.input.productionInstanceId)
        if (production && recovered.has(production.environmentId)) { operation.status = 'failed'; operation.phase = 'recovery-required'; operation.error = '环境已恢复但运行版本身份尚未对账。'; operation.updatedAt = new Date().toISOString() }
      }
    })
    await this.#recoverDeletionOperations()
    if (this.snapshot().operations.some(operation => operation.status === 'recovery-required')) {
      await this.#store.update(draft => {
        for (const operation of draft.operations) if (operation.status === 'recovery-required') operation.status = 'failed'
      })
    }
    if (this.#bundledRuntimeRoot) {
      const bundled = await discoverBundledRuntime(this.#bundledRuntimeRoot)
      if (bundled) {
        await this.#store.update(draft => {
          const obsoleteIds = new Set(draft.runtimes.filter(runtime => runtime.source === 'bundled' && runtime.id !== bundled.id).map(runtime => runtime.id))
          const defaultWasObsolete = draft.settings.defaultRuntimeId ? obsoleteIds.has(draft.settings.defaultRuntimeId) : false
          draft.runtimes = draft.runtimes.filter(runtime => runtime.source !== 'bundled' || runtime.id === bundled.id)
          const index = draft.runtimes.findIndex(runtime => runtime.id === bundled.id)
          if (index >= 0) draft.runtimes[index] = bundled
          else draft.runtimes.unshift(bundled)
          for (const instance of draft.instances) if (obsoleteIds.has(instance.runtimeId)) instance.runtimeId = bundled.id
          for (const template of draft.templates) if (obsoleteIds.has(template.runtimeId)) template.runtimeId = bundled.id
          for (const promotion of draft.promotions) {
            if ((promotion.status === 'awaiting-confirmation' || promotion.status === 'committed') && (obsoleteIds.has(promotion.previousRuntimeId) || obsoleteIds.has(promotion.targetRuntimeId))) {
              promotion.status = 'failed'
              promotion.error = '应用内置 DSH 已升级，原回退运行版本不再可用；环境备份仍保留。'
              promotion.updatedAt = new Date().toISOString()
            }
          }
          if (!draft.settings.defaultRuntimeId || defaultWasObsolete) draft.settings.defaultRuntimeId = bundled.id
        })
      }
    }
    const snapshot = this.snapshot()
    const interrupted = snapshot.instances.some(instance => ['starting', 'running', 'stopping'].includes(instance.status))
    const interruptedWork = snapshot.tasks.some(task => task.status === 'prepared' || task.status === 'running')
      || snapshot.operations.some(operation => operation.status === 'prepared' || operation.status === 'running')
    if (interrupted || interruptedWork) {
      await this.#store.update(draft => {
        for (const task of draft.tasks) {
          if (task.status !== 'prepared' && task.status !== 'running') continue
          task.status = 'interrupted'
          task.phase = 'recovery-required'
          task.error = '管理器在任务执行期间退出，请检查日志后重新运行。'
          task.finishedAt = new Date().toISOString()
        }
        for (const operation of draft.operations) {
          if (operation.status !== 'prepared' && operation.status !== 'running') continue
          operation.status = 'failed'
          operation.phase = 'recovery-required'
          operation.error = '管理器在操作执行期间退出，需要人工确认或重试。'
          operation.updatedAt = new Date().toISOString()
        }
        for (const instance of draft.instances) {
          if (!['starting', 'running', 'stopping'].includes(instance.status)) continue
          instance.status = 'failed'
          instance.interrupted = true
          delete instance.health
          instance.lastError = '管理器上次未完成监督交接。请确认旧进程已停止，再选择端口模式。'
        }
      })
    }
  }

  snapshot(): ManagerSnapshot {
    return this.#store.snapshot()
  }

  subscribe(listener: (snapshot: ManagerSnapshot) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async checkOfficialUpdate(channel: 'stable' | 'prerelease'): Promise<OfficialUpdateInfo> {
    const snapshot = this.snapshot()
    const installed = new Set(snapshot.runtimes.filter(runtime => runtime.source !== 'local').flatMap(runtime => runtime.version ? [runtime.version] : []))
    const defaultVersion = snapshot.runtimes.find(runtime => runtime.id === snapshot.settings.defaultRuntimeId)?.version
    return checkOfficialUpdate(channel, installed, defaultVersion)
  }

  async installOfficialRuntime(input: InstallOfficialRuntimeInput): Promise<OperationRecord> {
    const version = requiredText(input.version, 'Official version')
    const snapshot = this.snapshot()
    const existing = snapshot.runtimes.find(runtime => runtime.source !== 'local' && runtime.version === version)
    if (existing) throw new Error(`官方版本 ${version} 已安装。`)
    const now = new Date().toISOString()
    const operation: OperationRecord = {
      id: `operation-${randomUUID()}`,
      requestId: `install-${version}-${randomUUID()}`,
      type: 'runtime-install',
      status: 'prepared',
      phase: 'metadata',
      resourceKeys: [`official-runtime:${version}`],
      input: { version },
      artifacts: {},
      createdAt: now,
      updatedAt: now,
    }
    await this.#store.update(draft => { draft.operations.push(operation) })
    this.#emit()
    void this.#runOfficialInstall(operation.id, version)
    return operation
  }

  async cancelRuntimeInstall(operationId: string): Promise<void> {
    const operation = requiredById(this.snapshot().operations, operationId, 'Operation')
    if (operation.type !== 'runtime-install') throw new Error('该操作不是官方运行时安装。')
    if (operation.status !== 'prepared' && operation.status !== 'running') return
    let cancelling = false
    await this.#store.update(draft => {
      const current = requiredById(draft.operations, operationId, 'Operation')
      if (current.status !== 'prepared' && current.status !== 'running') return
      current.status = 'running'
      current.phase = 'cancelling'
      current.error = '正在取消安装。'
      current.updatedAt = new Date().toISOString()
      cancelling = true
    })
    if (!cancelling) return
    this.#emit()
    await this.#officialInstaller.cancel(operationId)
    await this.#store.update(draft => {
      const current = requiredById(draft.operations, operationId, 'Operation')
      current.status = 'failed'
      current.phase = 'cancelled'
      current.error = '用户已取消安装。'
      current.updatedAt = new Date().toISOString()
    })
    this.#emit()
  }

  async updateSettings(input: UpdateSettingsInput) {
    let settings!: ManagerSnapshot['settings']
    await this.#store.update(draft => {
      if (input.openMode !== undefined) draft.settings.openMode = input.openMode
      if (input.checkUpdatesOnStartup !== undefined) draft.settings.checkUpdatesOnStartup = input.checkUpdatesOnStartup
      settings = { ...draft.settings }
    })
    this.#emit()
    return settings
  }

  async registerRuntime(input: RegisterRuntimeInput): Promise<RuntimeRecord> {
    const name = requiredText(input.name, 'Runtime name')
    const checked = await preflightRuntime(requiredText(input.path, 'Runtime path'))
    if (this.snapshot().runtimes.some(runtime => runtime.path === checked.path)) {
      throw new Error('This runtime directory is already registered')
    }
    const runtime: RuntimeRecord = {
      id: `runtime-${randomUUID()}`,
      name,
      source: 'local',
      path: checked.path,
      registeredAt: new Date().toISOString(),
      preflight: checked.report,
    }
    await this.#store.update(draft => {
      draft.runtimes.push(runtime)
      if (!draft.settings.defaultRuntimeId) draft.settings.defaultRuntimeId = runtime.id
    })
    this.#emit()
    return runtime
  }

  async refreshRuntime(runtimeId: string): Promise<RuntimeRecord> {
    const current = requiredById(this.snapshot().runtimes, runtimeId, 'Runtime')
    const checked = await preflightRuntime(current.path)
    const runtime = { ...current, path: checked.path, preflight: checked.report }
    await this.#store.update(draft => {
      const index = draft.runtimes.findIndex(item => item.id === runtimeId)
      draft.runtimes[index] = runtime
    })
    this.#emit()
    return runtime
  }

  async setDefaultRuntime(runtimeId: string): Promise<RuntimeRecord> {
    let selected!: RuntimeRecord
    await this.#store.update(draft => {
      selected = requiredById(draft.runtimes, runtimeId, 'Runtime')
      draft.settings.defaultRuntimeId = runtimeId
    })
    this.#emit()
    return selected
  }

  async deleteRuntime(runtimeId: string): Promise<void> {
    const snapshot = this.snapshot()
    const runtime = requiredById(snapshot.runtimes, runtimeId, 'Runtime')
    if (this.#runtimeReservations.has(runtimeId)) throw new Error('该运行版本仍有生产操作在进行。')
    if (runtime.source === 'bundled') throw new Error('内置运行版本不可删除。')
    const referencing = snapshot.instances.filter(instance => instance.runtimeId === runtimeId)
    if (referencing.length) throw new Error(`仍有 ${referencing.length} 个实例使用该运行版本，请先删除或改绑实例。`)
    if (snapshot.templates.some(template => template.runtimeId === runtimeId)) throw new Error('仍有实例模板使用该运行版本。')
    const activeTask = snapshot.tasks.find(task => task.runtimeId === runtimeId && (task.status === 'prepared' || task.status === 'running'))
    if (activeTask) throw new Error('该运行版本仍有任务在执行。')
    const rollbackTarget = snapshot.promotions.find(item => (item.status === 'awaiting-confirmation' || item.status === 'committed') && (item.previousRuntimeId === runtimeId || item.targetRuntimeId === runtimeId))
    if (rollbackTarget) throw new Error('该运行版本仍是生产提升或回退记录的一部分。')

    let staged: { kind: 'directory' | 'worktree'; target: string; stagedPath: string; sourcePath?: string } | undefined
    if (runtime.source === 'downloaded' && runtime.managedPath) {
      const root = resolve(this.#dataRoot, 'runtimes', 'official', 'downloaded')
      const target = resolve(runtime.managedPath)
      const pathFromRoot = relative(root, target)
      if (!pathFromRoot || pathFromRoot.startsWith('..') || resolve(root, pathFromRoot) !== target) throw new Error('Downloaded runtime path is outside the managed runtime root')
      const stagedPath = `${target}.deleting-${randomUUID()}`
      staged = { kind: 'directory', target, stagedPath }
    } else if (runtime.source === 'local' && runtime.managedPath && !runtime.worktreeSourcePath) {
      const root = resolve(this.#dataRoot, 'runtimes', 'promotion-snapshots')
      const target = resolve(runtime.managedPath)
      const pathFromRoot = relative(root, target)
      if (!pathFromRoot || pathFromRoot.startsWith('..') || resolve(root, pathFromRoot) !== target) throw new Error('Promotion snapshot path is outside the managed runtime root')
      staged = { kind: 'directory', target, stagedPath: `${target}.deleting-${randomUUID()}` }
    } else if (runtime.source === 'local' && runtime.managedPath && runtime.worktreeSourcePath) {
      const root = resolve(this.#dataRoot, 'worktrees')
      const target = resolve(runtime.managedPath)
      const pathFromRoot = relative(root, target)
      if (!pathFromRoot || pathFromRoot.startsWith('..') || resolve(root, pathFromRoot) !== target) throw new Error('Worktree path is outside the managed worktree root')
      const stagedPath = `${target}.deleting-${randomUUID()}`
      staged = { kind: 'worktree', target, stagedPath, sourcePath: runtime.worktreeSourcePath }
    }
    const deletionOperation: OperationRecord = {
      id: `operation-${randomUUID()}`,
      requestId: `delete-runtime-${runtimeId}-${randomUUID()}`,
      type: 'delete-runtime', status: 'prepared', phase: 'prepared', resourceKeys: [`runtime:${runtimeId}`],
      input: { runtimeId },
      artifacts: staged ? { kind: staged.kind, target: staged.target, stagedPath: staged.stagedPath, ...(staged.sourcePath ? { sourcePath: staged.sourcePath } : {}) } : { kind: 'metadata' },
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }
    await this.#store.update(draft => { draft.operations.push(deletionOperation) })
    try {
      if (staged?.kind === 'directory') await rename(staged.target, staged.stagedPath)
      else if (staged?.sourcePath) await execFileAsync('git', ['-C', staged.sourcePath, 'worktree', 'move', staged.target, staged.stagedPath], { timeout: 60_000, maxBuffer: 1024 * 1024 })
      if (deletionOperation) await this.#store.update(draft => {
        const operation = requiredById(draft.operations, deletionOperation.id, 'Operation')
        operation.status = 'running'; operation.phase = 'staged'; operation.updatedAt = new Date().toISOString()
      })
      await this.#store.update(draft => {
        const operation = requiredById(draft.operations, deletionOperation.id, 'Operation')
        operation.status = 'running'; operation.phase = 'commit-delete'; operation.updatedAt = new Date().toISOString()
      })
      await this.#store.update(draft => {
        const index = draft.runtimes.findIndex(item => item.id === runtimeId)
        if (index < 0) throw new Error('Runtime does not exist')
        draft.runtimes.splice(index, 1)
        if (draft.settings.defaultRuntimeId === runtimeId) {
          const fallback = draft.runtimes.find(item => item.source === 'bundled')?.id ?? draft.runtimes[0]?.id
          if (fallback) draft.settings.defaultRuntimeId = fallback
          else delete draft.settings.defaultRuntimeId
        }
        if (deletionOperation) {
          const operation = requiredById(draft.operations, deletionOperation.id, 'Operation')
          operation.status = 'running'; operation.phase = 'metadata-removed'; operation.updatedAt = new Date().toISOString()
        }
      })
    } catch (error) {
      let restoreError: unknown
      if (staged?.kind === 'directory') await rename(staged.stagedPath, staged.target).catch(reason => { restoreError = reason })
      else if (staged?.sourcePath) await execFileAsync('git', ['-C', staged.sourcePath, 'worktree', 'move', staged.stagedPath, staged.target], { timeout: 60_000 }).catch(reason => { restoreError = reason })
      await this.#store.update(draft => {
        const operation = requiredById(draft.operations, deletionOperation.id, 'Operation')
        operation.status = restoreError ? 'running' : 'failed'; operation.phase = restoreError ? 'recovery-required' : 'restored'; operation.error = [error, restoreError].filter(Boolean).map(reason => reason instanceof Error ? reason.message : String(reason)).join('；'); operation.updatedAt = new Date().toISOString()
      }).catch(() => undefined)
      if (restoreError) throw new AggregateError([error, restoreError], '运行版本删除失败且暂存目录恢复未完成。')
      throw error
    }
    if (staged?.kind === 'directory') await rm(staged.stagedPath, { recursive: true, force: true })
    else if (staged?.sourcePath) await execFileAsync('git', ['-C', staged.sourcePath, 'worktree', 'remove', '--force', staged.stagedPath], { timeout: 60_000, maxBuffer: 1024 * 1024 })
    if (deletionOperation) await this.#store.update(draft => {
      const operation = requiredById(draft.operations, deletionOperation.id, 'Operation')
      operation.status = 'committed'; operation.phase = 'complete'; operation.updatedAt = new Date().toISOString()
    })
    this.#emit()
  }

  async startRuntimeTask(runtimeId: string, kind: RuntimeTaskKind): Promise<RuntimeTaskRecord> {
    const snapshot = this.snapshot()
    const runtime = requiredById(snapshot.runtimes, runtimeId, 'Runtime')
    if (this.#runtimeReservations.has(runtimeId)) throw new Error('该运行版本仍有生产操作在进行。')
    if (runtime.immutable) throw new Error('生产快照为不可变运行版本，不能执行构建或安装任务。')
    if (runtime.source !== 'local') throw new Error('官方运行版本不提供源码构建任务。')
    if (snapshot.tasks.some(task => task.runtimeId === runtimeId && (task.status === 'prepared' || task.status === 'running'))) throw new Error('该运行版本已有任务在执行。')
    if (snapshot.instances.some(instance => instance.runtimeId === runtimeId && ['starting', 'running', 'stopping'].includes(instance.status))) throw new Error('请先停止使用该运行版本的实例。')
    const now = new Date().toISOString()
    const taskId = `task-${randomUUID()}`
    const operationId = `operation-${randomUUID()}`
    const task: RuntimeTaskRecord = {
      id: taskId,
      requestId: `${kind}-${runtimeId}-${randomUUID()}`,
      runtimeId,
      kind,
      status: 'prepared',
      phase: 'prepared',
      logPath: join(this.#dataRoot, 'logs', 'tasks', `${taskId}.log`),
      createdAt: now,
    }
    const operation: OperationRecord = {
      id: operationId,
      requestId: task.requestId,
      type: 'runtime-task',
      status: 'prepared',
      phase: 'prepared',
      resourceKeys: [`runtime:${runtimeId}`],
      input: { runtimeId, kind, taskId },
      artifacts: { taskId },
      createdAt: now,
      updatedAt: now,
    }
    this.#taskRunner.prepare(taskId)
    try {
      await this.#store.update(draft => {
        if (this.#runtimeReservations.has(runtimeId)) throw new Error('该运行版本仍有生产操作在进行。')
        draft.tasks.push(task)
        const target = requiredById(draft.runtimes, runtimeId, 'Runtime')
        operation.artifacts.previousTaskBlocked = target.taskBlocked ?? ''
        draft.operations.push(operation)
        target.taskBlocked = `${kind} 任务尚未成功完成。`
      })
    } catch (error) {
      this.#taskRunner.discard(taskId)
      throw error
    }
    this.#emit()
    void this.#runRuntimeTask(taskId, operationId)
    return task
  }

  async cancelRuntimeTask(taskId: string): Promise<void> {
    const task = requiredById(this.snapshot().tasks, taskId, 'Task')
    if (task.status !== 'prepared' && task.status !== 'running') return
    await this.#taskRunner.cancel(taskId)
    await this.#store.update(draft => {
      const current = requiredById(draft.tasks, taskId, 'Task')
      current.status = 'cancelled'
      current.phase = 'cancelled'
      current.finishedAt = new Date().toISOString()
      current.error = '用户已取消任务。'
      const operation = draft.operations.find(item => item.requestId === current.requestId)
      if (operation) {
        operation.status = 'failed'
        operation.phase = 'cancelled'
        operation.error = current.error
        operation.updatedAt = current.finishedAt
      }
    })
    this.#emit()
  }

  readRuntimeTaskLog(taskId: string) {
    const task = requiredById(this.snapshot().tasks, taskId, 'Task')
    return this.#taskRunner.readLog(task)
  }

  async createWorktree(input: CreateWorktreeInput): Promise<RuntimeRecord> {
    const snapshot = this.snapshot()
    const source = requiredById(snapshot.runtimes, input.sourceRuntimeId, 'Source runtime')
    if (source.source !== 'local') throw new Error('只能从本地 Git 运行版本创建工作树。')
    const ref = requiredText(input.ref, 'Git ref')
    if (!/^[A-Za-z0-9][A-Za-z0-9._/@~-]{0,199}$/.test(ref) || ref.includes('..') || ref.includes('@{') || ref.endsWith('.lock')) throw new Error('Git ref 格式无效。')
    const id = `runtime-${randomUUID()}`
    const worktreeRoot = join(this.#dataRoot, 'worktrees')
    const target = join(worktreeRoot, id)
    await mkdir(worktreeRoot, { recursive: true, mode: 0o700 })
    await execFileAsync('git', ['-C', source.path, 'worktree', 'add', '--detach', target, ref], { timeout: 60_000, maxBuffer: 1024 * 1024 })
    try {
      const checked = await preflightRuntime(target)
      const runtime: RuntimeRecord = {
        id,
        name: requiredText(input.name, 'Worktree name'),
        source: 'local',
        path: checked.path,
        managedPath: target,
        worktreeSourcePath: source.path,
        taskBlocked: '新工作树需要完成依赖安装和完整构建。',
        registeredAt: new Date().toISOString(),
        preflight: checked.report,
      }
      await this.#store.update(draft => { draft.runtimes.push(runtime) })
      this.#emit()
      return runtime
    } catch (error) {
      await execFileAsync('git', ['-C', source.path, 'worktree', 'remove', '--force', target], { timeout: 60_000 }).catch(() => undefined)
      throw error
    }
  }

  async createEnvironment(input: CreateEnvironmentInput): Promise<EnvironmentRecord> {
    const environment = await this.#environments.create({
      ...input,
      name: requiredText(input.name, 'Environment name'),
    })
    if (this.snapshot().environments.some(current => current.path === environment.path)) {
      throw new Error('This DSH_HOME is already registered as an environment')
    }
    try {
      await this.#store.update(draft => { draft.environments.push(environment) })
    } catch (error) {
      await this.#environments.discard(environment)
      throw error
    }
    this.#emit()
    return environment
  }

  async cloneEnvironment(input: CloneEnvironmentInput): Promise<EnvironmentRecord> {
    const snapshot = this.snapshot()
    const source = requiredById(snapshot.environments, input.sourceEnvironmentId, 'Source environment')
    const usesSourcePath = (instance: InstanceRecord): boolean => snapshot.environments
      .find(environment => environment.id === instance.environmentId)?.path === source.path
    const sourceInstance = input.sourceInstanceId
      ? requiredById(snapshot.instances, input.sourceInstanceId, 'Source instance')
      : snapshot.instances.find(instance => usesSourcePath(instance) && instance.status === 'running')
        ?? snapshot.instances.find(usesSourcePath)
    if (sourceInstance && !usesSourcePath(sourceInstance)) {
      throw new Error('Source instance does not use the selected source environment path')
    }
    requiredById(snapshot.runtimes, input.targetRuntimeId, 'Target runtime')
    const sourceRuntime = sourceInstance
      ? requiredById(snapshot.runtimes, sourceInstance.runtimeId, 'Source runtime')
      : requiredById(snapshot.runtimes, input.targetRuntimeId, 'Target runtime')
    if (this.#environmentReservations.has(source.path)) throw new Error('Source environment has another operation in progress')
    this.#environmentReservations.add(source.path)
    const wasRunning = sourceInstance !== undefined && this.#supervisor.isRunning(sourceInstance.id)
    let stoppedForClone = false
    let environment: EnvironmentRecord | undefined
    let cloneError: unknown
    try {
      if (wasRunning) {
        await this.#supervisor.stop(sourceInstance)
        stoppedForClone = true
      }
      environment = await this.#environments.clone({
        ...input,
        name: requiredText(input.name, 'Environment name'),
      }, source, sourceInstance, sourceRuntime)
      try {
        await this.#store.update(draft => { draft.environments.push(environment!) })
      } catch (error) {
        await this.#environments.discard(environment)
        environment = undefined
        throw error
      }
      this.#emit()
    } catch (error) {
      cloneError = error
    } finally {
      if (wasRunning && sourceInstance && !this.#supervisor.isRunning(sourceInstance.id)) stoppedForClone = true
      this.#environmentReservations.delete(source.path)
    }
    if (stoppedForClone) {
      try {
        await this.startInstance(sourceInstance!.id)
      } catch (restartError) {
        if (!cloneError) throw new Error(`Environment was cloned, but the source instance could not restart: ${restartError instanceof Error ? restartError.message : String(restartError)}`)
      }
    }
    if (cloneError) throw cloneError
    return environment!
  }

  async deleteEnvironment(environmentId: string, deleteData = true): Promise<void> {
    const snapshot = this.snapshot()
    const environment = requiredById(snapshot.environments, environmentId, 'Environment')
    if (snapshot.instances.some(instance => instance.environmentId === environmentId)) throw new Error('仍有实例使用该环境，请先删除实例。')
    if (snapshot.templates.some(template => template.environmentId === environmentId)) throw new Error('仍有实例模板使用该环境。')
    if (this.#environmentReservations.has(environment.path)) throw new Error('该环境仍有操作在进行。')
    const planned = deleteData ? this.#environments.planDiscard(environment) : undefined
    const operation: OperationRecord = {
      id: `operation-${randomUUID()}`, requestId: `delete-environment-${environmentId}-${randomUUID()}`,
      type: 'delete-environment', status: 'prepared', phase: 'prepared', resourceKeys: [`environment:${environment.path}`], input: { environmentId },
      artifacts: planned ? { target: planned.original, stagedPath: planned.staged, kind: 'environment' } : { kind: 'metadata' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }
    await this.#store.update(draft => { draft.operations.push(operation) })
    let staged = planned
    try {
      if (planned) {
        staged = await this.#environments.stageDiscard(environment, planned)
        await this.#store.update(draft => { const current = requiredById(draft.operations, operation!.id, 'Operation'); current.status = 'running'; current.phase = 'staged'; current.updatedAt = new Date().toISOString() })
      }
      await this.#store.update(draft => { const current = requiredById(draft.operations, operation.id, 'Operation'); current.status = 'running'; current.phase = 'commit-delete'; current.updatedAt = new Date().toISOString() })
      await this.#store.update(draft => {
        const index = draft.environments.findIndex(item => item.id === environmentId)
        if (index < 0) throw new Error('Environment does not exist')
        draft.environments.splice(index, 1)
        if (operation) { const current = requiredById(draft.operations, operation.id, 'Operation'); current.status = 'running'; current.phase = 'metadata-removed'; current.updatedAt = new Date().toISOString() }
      })
    } catch (error) {
      let restoreError: unknown
      if (staged) await this.#environments.restoreDiscard(staged).catch(reason => { restoreError = reason })
      await this.#store.update(draft => { const current = requiredById(draft.operations, operation.id, 'Operation'); current.status = restoreError ? 'running' : 'failed'; current.phase = restoreError ? 'recovery-required' : 'restored'; current.error = [error, restoreError].filter(Boolean).map(reason => reason instanceof Error ? reason.message : String(reason)).join('；'); current.updatedAt = new Date().toISOString() }).catch(() => undefined)
      if (restoreError) throw new AggregateError([error, restoreError], '环境删除失败且暂存目录恢复未完成。')
      throw error
    }
    if (staged) await this.#environments.finalizeDiscard(staged)
    if (operation) await this.#store.update(draft => { const current = requiredById(draft.operations, operation.id, 'Operation'); current.status = 'committed'; current.phase = 'complete'; current.updatedAt = new Date().toISOString() })
    this.#emit()
  }

  async createEnvironmentBackup(environmentId: string): Promise<BackupRecord> {
    const snapshot = this.snapshot()
    const environment = requiredById(snapshot.environments, environmentId, 'Environment')
    if (this.#environmentReservations.has(environment.path)) throw new Error('该环境仍有操作在进行。')
    const users = snapshot.instances.filter(instance => instance.environmentId === environmentId && this.#supervisor.isRunning(instance.id))
    const now = new Date().toISOString()
    const operationId = `operation-${randomUUID()}`
    const operation: OperationRecord = {
      id: operationId,
      requestId: `backup-${environmentId}-${randomUUID()}`,
      type: 'backup',
      status: 'prepared',
      phase: 'stopping',
      resourceKeys: [`environment:${environment.path}`],
      input: { environmentId },
      artifacts: {},
      restartInstanceIds: users.map(instance => instance.id),
      createdAt: now,
      updatedAt: now,
    }
    await this.#store.update(draft => { draft.operations.push(operation) })
    this.#environmentReservations.add(environment.path)
    let backup: BackupRecord | undefined
    let operationError: unknown
    try {
      for (const instance of users) await this.#supervisor.stop(instance)
      await this.#store.update(draft => {
        const current = requiredById(draft.operations, operationId, 'Operation')
        current.status = 'running'
        current.phase = 'copying'
        current.updatedAt = new Date().toISOString()
      })
      this.#emit()
      backup = await this.#backups.create(environment)
      await this.#store.update(draft => {
        draft.backups.push(backup!)
        const current = requiredById(draft.operations, operationId, 'Operation')
        current.status = 'committed'
        current.phase = 'complete'
        current.artifacts.backupId = backup!.id
        current.updatedAt = new Date().toISOString()
      })
    } catch (error) {
      operationError = error
      await this.#store.update(draft => {
        const current = requiredById(draft.operations, operationId, 'Operation')
        current.status = 'failed'
        current.phase = 'failed'
        current.error = error instanceof Error ? error.message : String(error)
        current.updatedAt = new Date().toISOString()
      }).catch(() => undefined)
    } finally {
      this.#environmentReservations.delete(environment.path)
    }
    for (const instance of users) {
      try {
        await this.startInstance(instance.id)
      } catch (error) {
        operationError ??= error
      }
    }
    this.#emit()
    if (operationError) throw operationError
    return backup!
  }

  async createInstance(input: CreateInstanceInput): Promise<InstanceRecord> {
    const snapshot = this.snapshot()
    requiredById(snapshot.runtimes, input.runtimeId, 'Runtime')
    requiredById(snapshot.environments, input.environmentId, 'Environment')
    const instanceId = `instance-${randomUUID()}`
    const requestedWorkspace = input.workspacePath?.trim()
    const launchWorkspace = join(this.#dataRoot, 'instance-workspaces', instanceId)
    if (!requestedWorkspace) await mkdir(launchWorkspace, { recursive: true })
    const workspacePath = await realpath(requestedWorkspace || launchWorkspace)
    const port = 0
    const instance: InstanceRecord = {
      id: instanceId,
      name: requiredText(input.name, 'Instance name'),
      runtimeId: input.runtimeId,
      workspacePath,
      environmentId: input.environmentId,
      port,
      automaticPort: port === 0,
      createdAt: new Date().toISOString(),
      status: 'stopped',
    }
    await this.#store.update(draft => { draft.instances.push(instance) })
    this.#emit()
    return instance
  }

  async deleteInstance(instanceId: string, deleteEnvironment = false): Promise<void> {
    const before = this.snapshot()
    const instance = requiredById(before.instances, instanceId, 'Instance')
    if (instance.interrupted) throw new Error('该实例仍处于崩溃隔离状态，请先确认旧进程已停止。')
    if (before.promotions.some(promotion => promotion.productionInstanceId === instanceId && (promotion.status === 'awaiting-confirmation' || promotion.status === 'committed'))) throw new Error('该生产实例仍有可确认或可回退的提升记录。')
    const environment = requiredById(before.environments, instance.environmentId, 'Environment')
    if (this.#environmentReservations.has(environment.path)) throw new Error('该环境仍有操作在进行。')
    this.#environmentReservations.add(environment.path)
    try {
      if (this.#supervisor.isRunning(instanceId)) await this.#supervisor.stop(instance)
      const planned = deleteEnvironment && environment.kind !== 'production' ? this.#environments.planDiscard(environment) : undefined
      const deletionOperation: OperationRecord = {
        id: `operation-${randomUUID()}`, requestId: `delete-instance-${instanceId}-${randomUUID()}`, type: 'delete-instance', status: 'prepared', phase: 'prepared',
        resourceKeys: [`instance:${instanceId}`, `environment:${environment.path}`], input: { instanceId, ...(planned ? { environmentId: environment.id } : {}) },
        artifacts: planned ? { target: planned.original, stagedPath: planned.staged, kind: 'environment' } : { kind: 'metadata' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }
      await this.#store.update(draft => { draft.operations.push(deletionOperation) })
      const staged = planned ? await this.#environments.stageDiscard(environment, planned) : undefined
      if (deletionOperation) await this.#store.update(draft => { const current = requiredById(draft.operations, deletionOperation.id, 'Operation'); current.status = 'running'; current.phase = 'staged'; current.updatedAt = new Date().toISOString() })
      try {
        await this.#store.update(draft => { const current = requiredById(draft.operations, deletionOperation.id, 'Operation'); current.status = 'running'; current.phase = 'commit-delete'; current.updatedAt = new Date().toISOString() })
        await this.#store.update(draft => {
          const index = draft.instances.findIndex(item => item.id === instanceId)
          if (index < 0) throw new Error('Instance does not exist')
          if (deleteEnvironment) {
            const other = draft.instances.find(item => item.id !== instanceId && item.environmentId === instance.environmentId)
            if (other) throw new Error('该环境仍被其他实例使用。')
            if (environment.kind !== 'production') {
              const environmentIndex = draft.environments.findIndex(item => item.id === environment.id)
              if (environmentIndex >= 0) draft.environments.splice(environmentIndex, 1)
            }
          }
          draft.instances.splice(index, 1)
          if (draft.settings.productionInstanceId === instanceId) delete draft.settings.productionInstanceId
          if (deletionOperation) { const current = requiredById(draft.operations, deletionOperation.id, 'Operation'); current.status = 'running'; current.phase = 'metadata-removed'; current.updatedAt = new Date().toISOString() }
        })
      } catch (error) {
        let restoreError: unknown
        if (staged) await this.#environments.restoreDiscard(staged).catch(reason => { restoreError = reason })
        await this.#store.update(draft => { const current = requiredById(draft.operations, deletionOperation.id, 'Operation'); current.status = restoreError ? 'running' : 'failed'; current.phase = restoreError ? 'recovery-required' : 'restored'; current.error = [error, restoreError].filter(Boolean).map(reason => reason instanceof Error ? reason.message : String(reason)).join('；'); current.updatedAt = new Date().toISOString() }).catch(() => undefined)
        if (restoreError) throw new AggregateError([error, restoreError], '实例删除失败且环境暂存目录恢复未完成。')
        throw error
      }
      await this.#supervisor.deleteLog(instanceId).catch(error => console.error('Failed to delete instance log', error))
      if (staged) await this.#environments.finalizeDiscard(staged)
      if (deletionOperation) await this.#store.update(draft => { const current = requiredById(draft.operations, deletionOperation.id, 'Operation'); current.status = 'committed'; current.phase = 'complete'; current.updatedAt = new Date().toISOString() })
      this.#emit()
    } finally {
      this.#environmentReservations.delete(environment.path)
    }
  }

  async preparePromotion(candidateInstanceId: string, productionInstanceId: string, testConfirmed: boolean): Promise<PromotionRecord> {
    if (!testConfirmed) throw new Error('请先确认候选实例已完成一次实际测试对话。')
    const snapshot = this.snapshot()
    const candidate = requiredById(snapshot.instances, candidateInstanceId, 'Candidate instance')
    const production = requiredById(snapshot.instances, productionInstanceId, 'Production instance')
    if (candidate.id === production.id) throw new Error('候选实例与生产实例不能相同。')
    if (candidate.status !== 'running' || !candidate.health?.ok) throw new Error('候选实例必须正在运行且健康检查通过。')
    const candidateEnvironment = requiredById(snapshot.environments, candidate.environmentId, 'Candidate environment')
    const productionEnvironment = requiredById(snapshot.environments, production.environmentId, 'Production environment')
    if (candidateEnvironment.kind === 'production') throw new Error('候选实例必须使用隔离或克隆环境。')
    if (productionEnvironment.kind !== 'production') throw new Error('目标实例必须使用生产环境。')
    const targetRuntime = requiredById(snapshot.runtimes, candidate.runtimeId, 'Candidate runtime')
    const previousRuntime = requiredById(snapshot.runtimes, production.runtimeId, 'Production runtime')
    if (!targetRuntime.preflight.ready || targetRuntime.taskBlocked) throw new Error('候选运行版本未通过构建与预检门禁。')
    if (this.#environmentReservations.has(productionEnvironment.path)) throw new Error('生产环境仍有操作在进行。')
    if (this.#runtimeReservations.has(targetRuntime.id) || this.#runtimeReservations.has(previousRuntime.id)) throw new Error('候选或回退运行版本仍有生产操作在进行。')
    this.#environmentReservations.add(productionEnvironment.path)
    this.#runtimeReservations.add(targetRuntime.id)
    this.#runtimeReservations.add(previousRuntime.id)
    try {
      await verifyOfficialRuntime(targetRuntime)
      const freshTarget = await preflightRuntime(targetRuntime.path)
      if (!freshTarget.report.ready || !targetRuntime.preflight.buildFingerprint || freshTarget.report.buildFingerprint !== targetRuntime.preflight.buildFingerprint) throw new Error('候选运行版本的构建产物在测试后发生变化，请重新启动并完成测试。')
      if (targetRuntime.source === 'local' && (!freshTarget.report.gitCommit || freshTarget.report.gitCommit !== targetRuntime.preflight.gitCommit || freshTarget.report.gitDirty !== false)) throw new Error('本地候选运行版本必须保持测试时的干净已提交 commit。')
    } catch (error) {
      this.#environmentReservations.delete(productionEnvironment.path)
      this.#runtimeReservations.delete(targetRuntime.id)
      this.#runtimeReservations.delete(previousRuntime.id)
      throw error
    }

    const now = new Date().toISOString()
    const operationId = `operation-${randomUUID()}`
    const promotionId = `promotion-${randomUUID()}`
    let effectiveTargetRuntime = targetRuntime
    const operation: OperationRecord = {
      id: operationId,
      requestId: `promotion-${production.id}-${randomUUID()}`,
      type: 'promotion',
      status: 'prepared',
      phase: 'stopping-production',
      resourceKeys: ['production', `instance:${production.id}`, `environment:${productionEnvironment.path}`, `runtime:${targetRuntime.id}`],
      input: { candidateInstanceId, productionInstanceId, previousRuntimeId: previousRuntime.id, targetRuntimeId: targetRuntime.id },
      artifacts: {},
      createdAt: now,
      updatedAt: now,
    }
    try {
      await this.#store.update(draft => { draft.operations.push(operation) })
    } catch (error) {
      this.#environmentReservations.delete(productionEnvironment.path)
      this.#runtimeReservations.delete(targetRuntime.id)
      this.#runtimeReservations.delete(previousRuntime.id)
      throw error
    }
    let backup: BackupRecord | undefined
    let promotion: PromotionRecord | undefined
    try {
      if (targetRuntime.source === 'local') {
        effectiveTargetRuntime = await this.#snapshotLocalRuntime(targetRuntime, promotionId)
        this.#runtimeReservations.add(effectiveTargetRuntime.id)
        await this.#store.update(draft => {
          draft.runtimes.push(effectiveTargetRuntime)
          const current = requiredById(draft.operations, operationId, 'Operation')
          current.artifacts.snapshotRuntimeId = effectiveTargetRuntime.id
          current.artifacts.snapshotPath = effectiveTargetRuntime.managedPath ?? ''
          current.input.targetRuntimeId = effectiveTargetRuntime.id
          current.resourceKeys.push(`runtime:${effectiveTargetRuntime.id}`)
          current.updatedAt = new Date().toISOString()
        })
      }
      if (this.#supervisor.isRunning(production.id)) await this.#supervisor.stop(production)
      await this.#store.update(draft => {
        const current = requiredById(draft.operations, operationId, 'Operation')
        current.status = 'running'
        current.phase = 'backing-up'
        current.updatedAt = new Date().toISOString()
      })
      backup = await this.#backups.create(productionEnvironment)
      promotion = {
        id: promotionId,
        candidateInstanceId,
        productionInstanceId,
        previousRuntimeId: previousRuntime.id,
        targetRuntimeId: effectiveTargetRuntime.id,
        backupId: backup.id,
        ...(previousRuntime.preflight.buildFingerprint ? { previousBuildFingerprint: previousRuntime.preflight.buildFingerprint } : {}),
        ...(effectiveTargetRuntime.preflight.buildFingerprint ? { targetBuildFingerprint: effectiveTargetRuntime.preflight.buildFingerprint } : {}),
        status: 'awaiting-confirmation',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      await this.#store.update(draft => {
        draft.backups.push(backup!)
        draft.promotions.push(promotion!)
        const instance = requiredById(draft.instances, production.id, 'Production instance')
        instance.runtimeId = effectiveTargetRuntime.id
        instance.status = 'stopped'
        delete instance.health
        const current = requiredById(draft.operations, operationId, 'Operation')
        current.status = 'running'
        current.phase = 'starting-candidate-runtime'
        current.artifacts.backupId = backup!.id
        current.artifacts.promotionId = promotion!.id
        current.updatedAt = new Date().toISOString()
      })
      const latest = requiredById(this.snapshot().instances, production.id, 'Production instance')
      await this.#startVerified(latest, effectiveTargetRuntime, productionEnvironment, promotion.targetBuildFingerprint)
      await this.#store.update(draft => {
        draft.settings.productionInstanceId = production.id
        const currentPromotion = requiredById(draft.promotions, promotion!.id, 'Promotion')
        currentPromotion.status = 'awaiting-confirmation'
        currentPromotion.updatedAt = new Date().toISOString()
        const current = requiredById(draft.operations, operationId, 'Operation')
        current.status = 'awaiting-confirmation'
        current.phase = 'awaiting-production-confirmation'
        current.updatedAt = currentPromotion.updatedAt
      })
      this.#emit()
      return requiredById(this.snapshot().promotions, promotion.id, 'Promotion')
    } catch (error) {
      const recoveryErrors: unknown[] = []
      if (this.#supervisor.isRunning(production.id)) await this.#supervisor.stop(requiredById(this.snapshot().instances, production.id, 'Production instance'), true).catch(reason => recoveryErrors.push(reason))
      if (backup) await this.#backups.restore(backup, productionEnvironment).catch(reason => recoveryErrors.push(reason))
      await this.#store.update(draft => {
        const instance = requiredById(draft.instances, production.id, 'Production instance')
        instance.runtimeId = previousRuntime.id
        instance.status = 'stopped'
        delete instance.health
        if (promotion) {
          const currentPromotion = draft.promotions.find(item => item.id === promotion!.id)
          if (currentPromotion) {
            currentPromotion.status = 'failed'
            currentPromotion.error = error instanceof Error ? error.message : String(error)
            currentPromotion.updatedAt = new Date().toISOString()
          }
        }
        const current = requiredById(draft.operations, operationId, 'Operation')
        current.status = 'failed'
        current.phase = 'recovery-required'
        current.error = error instanceof Error ? error.message : String(error)
        current.updatedAt = new Date().toISOString()
      }).catch(reason => recoveryErrors.push(reason))
      if (backup && recoveryErrors.length === 0) await this.#backups.commitRestore(backup).catch(reason => recoveryErrors.push(reason))
      const restored = this.snapshot().instances.find(item => item.id === production.id)
      if (restored && recoveryErrors.length === 0) await this.#startVerified(restored, previousRuntime, productionEnvironment, promotion?.previousBuildFingerprint).catch(reason => recoveryErrors.push(reason))
      if (recoveryErrors.length) {
        await this.#store.update(draft => {
          const instance = requiredById(draft.instances, production.id, 'Production instance')
          instance.status = 'failed'
          instance.interrupted = true
          instance.lastError = '生产提升自动恢复未完成；请检查备份、诊断目录与日志后再解除隔离。'
          const current = requiredById(draft.operations, operationId, 'Operation')
          current.status = 'failed'
          current.phase = 'recovery-required'
          current.error = recoveryErrors.map(reason => reason instanceof Error ? reason.message : String(reason)).join('；')
          current.updatedAt = new Date().toISOString()
        }).catch(() => undefined)
      }
      if (recoveryErrors.length === 0) {
        await this.#store.update(draft => {
          const current = requiredById(draft.operations, operationId, 'Operation')
          current.phase = 'rolled-back-after-failure'
          current.updatedAt = new Date().toISOString()
        }).catch(reason => recoveryErrors.push(reason))
      }
      this.#emit()
      if (recoveryErrors.length) throw new AggregateError([error, ...recoveryErrors], '生产提升失败，自动恢复未完成，需要人工恢复。')
      throw error
    } finally {
      this.#environmentReservations.delete(productionEnvironment.path)
      this.#runtimeReservations.delete(targetRuntime.id)
      this.#runtimeReservations.delete(previousRuntime.id)
      this.#runtimeReservations.delete(effectiveTargetRuntime.id)
    }
  }

  async confirmPromotion(promotionId: string): Promise<PromotionRecord> {
    let result!: PromotionRecord
    await this.#store.update(draft => {
      const promotion = requiredById(draft.promotions, promotionId, 'Promotion')
      if (promotion.status !== 'awaiting-confirmation') throw new Error('该提升不在等待确认状态。')
      const production = requiredById(draft.instances, promotion.productionInstanceId, 'Production instance')
      if (production.status !== 'running' || !production.health?.ok || production.runtimeId !== promotion.targetRuntimeId) throw new Error('生产实例尚未以候选运行版本健康运行。')
      promotion.status = 'committed'
      promotion.updatedAt = new Date().toISOString()
      draft.settings.defaultRuntimeId = promotion.targetRuntimeId
      draft.settings.productionInstanceId = promotion.productionInstanceId
      const operation = draft.operations.find(item => item.artifacts.promotionId === promotionId)
      if (operation) {
        operation.status = 'committed'
        operation.phase = 'complete'
        operation.updatedAt = promotion.updatedAt
      }
      result = { ...promotion }
    })
    this.#emit()
    return result
  }

  async rollbackPromotion(promotionId: string): Promise<PromotionRecord> {
    const snapshot = this.snapshot()
    const promotion = requiredById(snapshot.promotions, promotionId, 'Promotion')
    if (promotion.status !== 'awaiting-confirmation' && promotion.status !== 'committed') throw new Error('该提升不可回退。')
    const production = requiredById(snapshot.instances, promotion.productionInstanceId, 'Production instance')
    const environment = requiredById(snapshot.environments, production.environmentId, 'Production environment')
    const previousRuntime = requiredById(snapshot.runtimes, promotion.previousRuntimeId, 'Previous runtime')
    if (!promotion.previousBuildFingerprint) throw new Error('该旧回退点缺少持久化运行版本身份，不能自动执行。')
    const backup = requiredById(snapshot.backups, promotion.backupId, 'Backup')
    if (snapshot.tasks.some(task => task.runtimeId === previousRuntime.id && (task.status === 'prepared' || task.status === 'running'))) throw new Error('回退运行版本仍有构建或诊断任务在执行。')
    if (this.#environmentReservations.has(environment.path)) throw new Error('生产环境仍有操作在进行。')
    if (this.#runtimeReservations.has(previousRuntime.id)) throw new Error('回退运行版本仍有生产操作在进行。')
    this.#environmentReservations.add(environment.path)
    this.#runtimeReservations.add(previousRuntime.id)
    try {
      const operation = snapshot.operations.find(item => item.artifacts.promotionId === promotionId)
      await this.#store.update(draft => {
        if (operation) {
          const current = requiredById(draft.operations, operation.id, 'Operation')
          current.status = 'running'
          current.phase = 'restoring-production'
          current.updatedAt = new Date().toISOString()
        }
      })
      if (this.#supervisor.isRunning(production.id)) await this.#supervisor.stop(production)
      const diagnostic = await this.#backups.restore(backup, environment)
      await this.#store.update(draft => {
        const instance = requiredById(draft.instances, production.id, 'Production instance')
        instance.runtimeId = previousRuntime.id
        instance.status = 'stopped'
        delete instance.health
        const currentPromotion = requiredById(draft.promotions, promotionId, 'Promotion')
        currentPromotion.updatedAt = new Date().toISOString()
        if (operation) {
          const current = requiredById(draft.operations, operation.id, 'Operation')
          current.status = 'running'
          current.phase = 'starting-previous-runtime'
          current.artifacts.diagnosticPath = diagnostic
          current.updatedAt = currentPromotion.updatedAt
        }
      })
      await this.#backups.commitRestore(backup)
      const restored = requiredById(this.snapshot().instances, production.id, 'Production instance')
      await this.#startVerified(restored, previousRuntime, environment, promotion.previousBuildFingerprint)
      let result!: PromotionRecord
      await this.#store.update(draft => {
        const currentPromotion = requiredById(draft.promotions, promotionId, 'Promotion')
        currentPromotion.status = 'rolled-back'
        currentPromotion.updatedAt = new Date().toISOString()
        draft.settings.defaultRuntimeId = previousRuntime.id
        if (operation) {
          const current = requiredById(draft.operations, operation.id, 'Operation')
          current.status = 'rolled-back'
          current.phase = 'rollback-complete'
          current.updatedAt = currentPromotion.updatedAt
        }
        result = { ...currentPromotion }
      })
      this.#emit()
      return result
    } catch (error) {
      await this.#store.update(draft => {
        const instance = requiredById(draft.instances, production.id, 'Production instance')
        instance.status = 'failed'
        instance.interrupted = true
        instance.lastError = '生产回退未完成；请检查备份、诊断目录与日志后再解除隔离。'
        const currentPromotion = requiredById(draft.promotions, promotionId, 'Promotion')
        currentPromotion.error = error instanceof Error ? error.message : String(error)
        currentPromotion.updatedAt = new Date().toISOString()
        const operation = draft.operations.find(item => item.artifacts.promotionId === promotionId)
        if (operation) { operation.status = 'failed'; operation.phase = 'recovery-required'; operation.error = currentPromotion.error; operation.updatedAt = currentPromotion.updatedAt }
      }).catch(() => undefined)
      this.#emit()
      throw error
    } finally {
      this.#environmentReservations.delete(environment.path)
      this.#runtimeReservations.delete(previousRuntime.id)
    }
  }

  async dismissPromotion(promotionId: string): Promise<PromotionRecord> {
    let result!: PromotionRecord
    await this.#store.update(draft => {
      const promotion = requiredById(draft.promotions, promotionId, 'Promotion')
      if (promotion.status !== 'committed') throw new Error('只能放弃已确认的生产回退点。')
      promotion.status = 'failed'
      promotion.error = '用户已明确放弃该回退点。'
      promotion.updatedAt = new Date().toISOString()
      result = { ...promotion }
    })
    this.#emit()
    return result
  }

  async saveInstanceTemplate(instanceId: string, name: string): Promise<InstanceTemplate> {
    const snapshot = this.snapshot()
    const instance = requiredById(snapshot.instances, instanceId, 'Instance')
    const environment = requiredById(snapshot.environments, instance.environmentId, 'Environment')
    const template: InstanceTemplate = {
      id: `template-${randomUUID()}`,
      name: requiredText(name, 'Template name'),
      runtimeId: instance.runtimeId,
      workspacePath: instance.workspacePath,
      environmentMode: environment.kind === 'production' ? 'existing' : 'new-isolated',
      ...(environment.kind === 'production' ? { environmentId: environment.id } : {}),
      port: instance.automaticPort ? 0 : instance.port,
      createdAt: new Date().toISOString(),
    }
    await this.#store.update(draft => { draft.templates.push(template) })
    this.#emit()
    return template
  }

  async createInstanceFromTemplate(templateId: string, name: string): Promise<InstanceRecord> {
    const template = requiredById(this.snapshot().templates, templateId, 'Template')
    let environmentId = template.environmentId
    let createdEnvironment: EnvironmentRecord | undefined
    if (template.environmentMode === 'new-isolated') {
      createdEnvironment = await this.createEnvironment({ name: `${requiredText(name, 'Instance name')} 环境`, kind: 'isolated' })
      environmentId = createdEnvironment.id
    }
    try {
      return await this.createInstance({ name, runtimeId: template.runtimeId, environmentId: requiredText(environmentId ?? '', 'Template environment') })
    } catch (error) {
      if (createdEnvironment) await this.deleteEnvironment(createdEnvironment.id, true).catch(() => undefined)
      throw error
    }
  }

  async deleteInstanceTemplate(templateId: string): Promise<void> {
    await this.#store.update(draft => {
      const index = draft.templates.findIndex(template => template.id === templateId)
      if (index < 0) throw new Error('Template does not exist')
      draft.templates.splice(index, 1)
    })
    this.#emit()
  }

  async startInstance(instanceId: string): Promise<InstanceRecord> {
    let snapshot = this.snapshot()
    const instance = requiredById(snapshot.instances, instanceId, 'Instance')
    if (instance.interrupted) throw new Error('该实例上次被中断，请先确认旧进程已停止。')
    if (instance.portModeReviewRequired) throw new Error('该实例来自旧版状态，请先选择自动或固定端口模式。')
    const selectedRuntime = requiredById(snapshot.runtimes, instance.runtimeId, 'Runtime')
    if (selectedRuntime.taskBlocked) throw new Error(`运行版本被任务门禁阻止：${selectedRuntime.taskBlocked}`)
    const activeRuntimeTask = snapshot.tasks.find(task => task.runtimeId === instance.runtimeId && (task.status === 'prepared' || task.status === 'running'))
    if (activeRuntimeTask) throw new Error('该运行版本仍有任务在执行。')
    const environment = requiredById(snapshot.environments, instance.environmentId, 'Environment')
    const occupant = snapshot.instances.find(candidate => {
      if (candidate.id === instance.id || !['starting', 'running', 'stopping'].includes(candidate.status)) return false
      const candidateEnvironment = snapshot.environments.find(item => item.id === candidate.environmentId)
      return candidateEnvironment?.path === environment.path
    })
    if (occupant) throw new Error(`Environment is already occupied by ${occupant.name}`)
    if (this.#environmentReservations.has(environment.path)) throw new Error('Environment has another operation in progress')
    if (environment.kind === 'production' && this.#runtimeReservations.has(selectedRuntime.id)) throw new Error('生产运行版本仍有操作在进行。')
    this.#environmentReservations.add(environment.path)
    if (environment.kind === 'production') this.#runtimeReservations.add(selectedRuntime.id)

    try {
      await verifyOfficialRuntime(selectedRuntime)
      const runtime = environment.kind === 'production' ? selectedRuntime : await this.refreshRuntime(instance.runtimeId)
      if (environment.kind === 'production' && !selectedRuntime.preflight.buildFingerprint) throw new Error('生产运行版本缺少已登记的构建身份，请先在隔离环境测试并通过提升流程。')
      snapshot = this.snapshot()
      const latestInstance = requiredById(snapshot.instances, instanceId, 'Instance')
      try {
        if (environment.kind === 'production') {
          return await this.#startVerified(latestInstance, runtime, environment, selectedRuntime.preflight.buildFingerprint)
        }
        const projection = await this.#modelSettings.projectInto(environment.path)
        const modelLaunch = this.#modelLaunchOptions(projection.credentialRefs)
        return await this.#supervisor.start(latestInstance, runtime, environment, modelLaunch)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await this.#store.update(draft => {
          const failed = requiredById(draft.instances, instanceId, 'Instance')
          const survivor = this.#supervisor.isRunning(instanceId)
          failed.status = 'failed'
          failed.lastError = message
          failed.interrupted = survivor
          if (!survivor) failed.pid = undefined
        })
        this.#emit()
        throw error
      }
    } finally {
      this.#environmentReservations.delete(environment.path)
      if (environment.kind === 'production') this.#runtimeReservations.delete(selectedRuntime.id)
    }
  }

  async stopInstance(instanceId: string, force = false): Promise<InstanceRecord> {
    const snapshot = this.snapshot()
    const instance = requiredById(snapshot.instances, instanceId, 'Instance')
    const environment = requiredById(snapshot.environments, instance.environmentId, 'Environment')
    if (this.#environmentReservations.has(environment.path)) throw new Error('Environment has another operation in progress')
    return this.#supervisor.stop(instance, force)
  }

  async restartInstance(instanceId: string): Promise<InstanceRecord> {
    const snapshot = this.snapshot()
    const instance = requiredById(snapshot.instances, instanceId, 'Instance')
    const environment = requiredById(snapshot.environments, instance.environmentId, 'Environment')
    if (this.#environmentReservations.has(environment.path)) throw new Error('Environment has another operation in progress')
    if (this.#supervisor.isRunning(instanceId)) await this.#supervisor.stop(instance)
    return this.startInstance(instanceId)
  }

  async recoverInstance(instanceId: string, automaticPort: boolean): Promise<InstanceRecord> {
    const snapshot = this.snapshot()
    const current = requiredById(snapshot.instances, instanceId, 'Instance')
    const environment = snapshot.environments.find(item => item.id === current.environmentId)
    const productionRecovery = environment?.kind === 'production' && snapshot.operations.some(operation => operation.phase.includes('recovery-required') && (operation.resourceKeys.includes(`instance:${instanceId}`) || operation.resourceKeys.includes(`environment:${environment.path}`)))
    if (productionRecovery) throw new Error('该生产实例仍有未完成的提升或回退恢复，不能用普通进程恢复解除隔离。')
    if (!current.interrupted && !current.portModeReviewRequired) return current
    if (current.interrupted && current.pid && processGroupAlive(current.pid)) {
      throw new Error(`旧进程组 ${current.pid} 仍在运行，无法解除隔离。`)
    }
    if (current.interrupted && current.port > 0 && !(await portAvailable(current.port))) {
      throw new Error(`端口 ${current.port} 仍被占用，请先停止旧进程。`)
    }
    if (!automaticPort && (!Number.isInteger(current.port) || current.port < 1 || current.port > 65_535)) {
      throw new Error('当前记录没有可保留的固定端口，请选择自动端口。')
    }
    let recovered!: InstanceRecord
    await this.#store.update(draft => {
      const instance = requiredById(draft.instances, instanceId, 'Instance')
      instance.automaticPort = automaticPort
      if (automaticPort) instance.port = 0
      instance.portModeReviewRequired = false
      instance.interrupted = false
      instance.status = 'stopped'
      instance.pid = undefined
      delete instance.health
      instance.lastError = undefined
      recovered = { ...instance }
    })
    this.#emit()
    return recovered
  }

  getUnifiedConfiguration(): Promise<UnifiedConfiguration> {
    return this.#modelConfiguration.read()
  }

  saveUnifiedConfiguration(input: SaveUnifiedConfigurationInput): Promise<UnifiedConfiguration> {
    return this.#modelConfiguration.save(input)
  }

  setUnifiedCredential(input: SetUnifiedCredentialInput): Promise<UnifiedConfiguration> {
    return this.#modelConfiguration.setCredential(input)
  }

  readInstanceLog(instanceId: string) {
    requiredById(this.snapshot().instances, instanceId, 'Instance')
    return this.#supervisor.readLog(instanceId)
  }

  async shutdown(): Promise<void> {
    await Promise.all([this.#taskRunner.cancelAll(), this.#officialInstaller.cancelAll()])
    if (this.#environmentReservations.size) throw new Error('环境操作仍在进行，请等待完成后再退出。')
    await this.#supervisor.stopAll(this.snapshot().instances)
  }

  async #runRuntimeTask(taskId: string, operationId: string): Promise<void> {
    try {
      let task!: RuntimeTaskRecord
      let runtime!: RuntimeRecord
      let shouldRun = true
      await this.#store.update(draft => {
        task = requiredById(draft.tasks, taskId, 'Task')
        if (task.status === 'cancelled') {
          shouldRun = false
          return
        }
        runtime = requiredById(draft.runtimes, task.runtimeId, 'Runtime')
        task.status = 'running'
        task.phase = 'running'
        task.startedAt = new Date().toISOString()
        const operation = requiredById(draft.operations, operationId, 'Operation')
        operation.status = 'running'
        operation.phase = 'running'
        operation.updatedAt = task.startedAt
      })
      if (!shouldRun) {
        this.#taskRunner.discard(taskId)
        return
      }
      this.#emit()
      await this.#taskRunner.run(task, runtime)
      const checked = await preflightRuntime(runtime.path)
      if ((task.kind === 'build' || task.kind === 'install') && !checked.report.ready) throw new Error(`任务完成但运行时预检仍失败：${checked.report.checks.filter(check => check.level === 'failure').map(check => check.detail).join('；')}`)
      await this.#store.update(draft => {
        const current = requiredById(draft.tasks, taskId, 'Task')
        if (current.status === 'cancelled') return
        current.status = 'succeeded'
        current.phase = 'complete'
        current.finishedAt = new Date().toISOString()
        const target = requiredById(draft.runtimes, current.runtimeId, 'Runtime')
        target.path = checked.path
        target.preflight = checked.report
        const operation = requiredById(draft.operations, operationId, 'Operation')
        if (current.kind === 'build') {
          delete target.taskBlocked
        } else if (operation.artifacts.previousTaskBlocked) {
          target.taskBlocked = operation.artifacts.previousTaskBlocked
        } else {
          delete target.taskBlocked
        }
        operation.status = 'committed'
        operation.phase = 'complete'
        operation.updatedAt = current.finishedAt
      })
    } catch (error) {
      await this.#store.update(draft => {
        const task = draft.tasks.find(item => item.id === taskId)
        if (!task || task.status === 'cancelled') return
        task.status = 'failed'
        task.phase = 'failed'
        task.finishedAt = new Date().toISOString()
        task.error = error instanceof Error ? error.message : String(error)
        const runtime = draft.runtimes.find(item => item.id === task.runtimeId)
        if (runtime) runtime.taskBlocked = task.error
        const operation = draft.operations.find(item => item.id === operationId)
        if (operation) {
          operation.status = 'failed'
          operation.phase = 'failed'
          operation.error = task.error
          operation.updatedAt = task.finishedAt
        }
      }).catch(() => undefined)
    }
    this.#emit()
  }

  async #runOfficialInstall(operationId: string, version: string): Promise<void> {
    let installedRuntime: RuntimeRecord | undefined
    try {
      const runtime = await this.#officialInstaller.install(operationId, version, async progress => {
        await this.#store.update(draft => {
          const operation = requiredById(draft.operations, operationId, 'Operation')
          if (operation.phase === 'cancelling' || operation.phase === 'cancelled') throw new Error('安装已取消')
          operation.status = 'running'
          operation.phase = progress.phase
          operation.input.detail = progress.detail
          operation.updatedAt = new Date().toISOString()
        })
        this.#emit()
      })
      installedRuntime = runtime
      const checked = await preflightRuntime(runtime.path)
      if (!checked.report.ready) throw new Error(`官方运行时最终预检失败：${checked.report.checks.filter(check => check.level === 'failure').map(check => check.detail).join('；')}`)
      await this.#store.update(draft => {
        const operation = requiredById(draft.operations, operationId, 'Operation')
        if (operation.status === 'failed' && operation.phase === 'cancelled') throw new Error('安装已取消')
        if (!draft.runtimes.some(item => item.id === runtime.id || item.path === checked.path)) {
          draft.runtimes.push({ ...runtime, path: checked.path, preflight: checked.report })
        }
        if (!draft.settings.defaultRuntimeId) draft.settings.defaultRuntimeId = runtime.id
        operation.status = 'committed'
        operation.phase = 'complete'
        operation.artifacts.runtimeId = runtime.id
        operation.updatedAt = new Date().toISOString()
      })
    } catch (error) {
      const cancelled = this.snapshot().operations.find(item => item.id === operationId)
      if (installedRuntime?.source === 'downloaded' && installedRuntime.managedPath && (cancelled?.phase === 'cancelling' || cancelled?.phase === 'cancelled')) {
        await rm(installedRuntime.managedPath, { recursive: true, force: true }).catch(() => undefined)
      }
      await this.#store.update(draft => {
        const operation = draft.operations.find(item => item.id === operationId)
        if (!operation || operation.phase === 'cancelling' || operation.phase === 'cancelled') return
        operation.status = 'failed'
        operation.phase = 'failed'
        operation.error = error instanceof Error ? error.message : String(error)
        operation.updatedAt = new Date().toISOString()
      }).catch(() => undefined)
    }
    this.#emit()
  }

  async #recoverDeletionOperations(): Promise<void> {
    const operations = this.snapshot().operations.filter(operation => ['delete-runtime', 'delete-environment', 'delete-instance'].includes(operation.type) && (operation.status === 'prepared' || operation.status === 'running'))
    for (const operation of operations) {
      const target = operation.artifacts.target
      const stagedPath = operation.artifacts.stagedPath
      const snapshot = this.snapshot()
      const entityExists = operation.type === 'delete-runtime'
        ? snapshot.runtimes.some(item => item.id === operation.input.runtimeId)
        : operation.type === 'delete-environment'
          ? snapshot.environments.some(item => item.id === operation.input.environmentId)
          : snapshot.instances.some(item => item.id === operation.input.instanceId)
      if (!target || !stagedPath) {
        const finalizeMetadata = !entityExists || operation.phase === 'commit-delete' || operation.phase === 'metadata-removed'
        await this.#store.update(draft => {
          if (finalizeMetadata && entityExists) {
            if (operation.type === 'delete-runtime') {
              const id = String(operation.input.runtimeId)
              draft.runtimes = draft.runtimes.filter(item => item.id !== id)
              if (draft.settings.defaultRuntimeId === id) {
                const fallback = draft.runtimes.find(item => item.source === 'bundled')?.id ?? draft.runtimes[0]?.id
                if (fallback) draft.settings.defaultRuntimeId = fallback
                else delete draft.settings.defaultRuntimeId
              }
            } else if (operation.type === 'delete-environment') draft.environments = draft.environments.filter(item => item.id !== operation.input.environmentId)
            else draft.instances = draft.instances.filter(item => item.id !== operation.input.instanceId)
          }
          const current = requiredById(draft.operations, operation.id, 'Operation')
          current.status = finalizeMetadata ? 'committed' : 'failed'
          current.phase = finalizeMetadata ? 'complete-after-recovery' : 'not-started'
          current.updatedAt = new Date().toISOString()
        })
        continue
      }
      const targetExists = await pathExists(target)
      const stagedExists = await pathExists(stagedPath)
      if (entityExists && stagedExists && !targetExists && operation.phase !== 'commit-delete') {
        if (operation.artifacts.kind === 'worktree' && operation.artifacts.sourcePath) await execFileAsync('git', ['-C', operation.artifacts.sourcePath, 'worktree', 'move', stagedPath, target], { timeout: 60_000 })
        else await rename(stagedPath, target)
        await this.#store.update(draft => { const current = requiredById(draft.operations, operation.id, 'Operation'); current.status = 'failed'; current.phase = 'restored-after-crash'; current.error = '删除在状态提交前中断，磁盘对象已恢复。'; current.updatedAt = new Date().toISOString() })
        continue
      }
      const finalizeMetadata = entityExists && !targetExists && (!stagedExists || operation.phase === 'commit-delete')
      if (!entityExists || finalizeMetadata) {
        if (stagedExists) {
          if (operation.artifacts.kind === 'worktree' && operation.artifacts.sourcePath) await execFileAsync('git', ['-C', operation.artifacts.sourcePath, 'worktree', 'remove', '--force', stagedPath], { timeout: 60_000 })
          else await rm(stagedPath, { recursive: true, force: true })
        }
        await this.#store.update(draft => {
          if (finalizeMetadata) {
            if (operation.type === 'delete-runtime') {
              const id = String(operation.input.runtimeId)
              draft.runtimes = draft.runtimes.filter(item => item.id !== id)
              if (draft.settings.defaultRuntimeId === id) {
                const fallback = draft.runtimes.find(item => item.source === 'bundled')?.id ?? draft.runtimes[0]?.id
                if (fallback) draft.settings.defaultRuntimeId = fallback
                else delete draft.settings.defaultRuntimeId
              }
            } else if (operation.type === 'delete-environment') {
              draft.environments = draft.environments.filter(item => item.id !== operation.input.environmentId)
            } else {
              draft.instances = draft.instances.filter(item => item.id !== operation.input.instanceId)
              draft.environments = draft.environments.filter(item => item.id !== operation.input.environmentId)
            }
          }
          const current = requiredById(draft.operations, operation.id, 'Operation')
          current.status = 'committed'; current.phase = 'complete-after-recovery'; current.updatedAt = new Date().toISOString()
        })
      } else {
        await this.#store.update(draft => { const current = requiredById(draft.operations, operation.id, 'Operation'); current.status = 'failed'; current.phase = 'not-started'; current.error = '删除未移动磁盘对象，可安全重试。'; current.updatedAt = new Date().toISOString() })
      }
    }
  }

  async #snapshotLocalRuntime(runtime: RuntimeRecord, promotionId: string): Promise<RuntimeRecord> {
    const target = join(this.#dataRoot, 'runtimes', 'promotion-snapshots', promotionId)
    await mkdir(dirname(target), { recursive: true, mode: 0o700 })
    await rm(target, { recursive: true, force: true })
    try {
      await cp(runtime.path, target, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true, force: false, errorOnExist: true })
      const checked = await preflightRuntime(target)
      if (!checked.report.ready || !runtime.preflight.buildFingerprint || checked.report.buildFingerprint !== runtime.preflight.buildFingerprint) throw new Error('本地候选的不可变生产快照与已测试构建身份不一致。')
      const { worktreeSourcePath: _worktreeSourcePath, ...snapshotRuntime } = runtime
      return {
        ...snapshotRuntime,
        id: `runtime-promotion-${promotionId}`,
        name: `${runtime.name} · 生产快照`,
        path: checked.path,
        managedPath: target,
        immutable: true,
        registeredAt: new Date().toISOString(),
        preflight: checked.report,
      }
    } catch (error) {
      await rm(target, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  #modelLaunchOptions(credentialRefs: readonly string[]) {
    return {
      patchPaths: [this.#modelSettings.overlayPath],
      removeEnvironmentKeys: credentialRefs,
    }
  }

  async #startVerified(instance: InstanceRecord, runtime: RuntimeRecord, environment: EnvironmentRecord, expectedFingerprint?: string): Promise<InstanceRecord> {
    await verifyOfficialRuntime(runtime)
    const fresh = await preflightRuntime(runtime.path)
    if (!fresh.report.ready) throw new Error(`运行版本最终预检失败：${fresh.report.checks.filter(check => check.level === 'failure').map(check => check.detail).join('；')}`)
    if (!expectedFingerprint) throw new Error('生产运行版本缺少持久化构建身份，不能直接启动。')
    if (fresh.report.buildFingerprint !== expectedFingerprint) throw new Error('运行版本构建闭包与已测试或备份时的身份不一致。')
    const projection = await this.#modelSettings.projectInto(environment.path)
    const modelLaunch = this.#modelLaunchOptions(projection.credentialRefs)
    return this.#supervisor.start(instance, { ...runtime, path: fresh.path, preflight: fresh.report }, environment, modelLaunch)
  }

  #emit(): void {
    const snapshot = this.snapshot()
    for (const listener of this.#listeners) listener(snapshot)
  }
}
