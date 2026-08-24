import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { EnvironmentService } from './environment-service.js'
import { InstanceSupervisor, portAvailable, processGroupAlive } from './instance-supervisor.js'
import { preflightRuntime } from './runtime-preflight.js'
import { StateStore } from './state-store.js'
import type {
  CloneEnvironmentInput,
  CreateEnvironmentInput,
  CreateInstanceInput,
  EnvironmentRecord,
  InstanceRecord,
  ManagerSnapshot,
  RegisterRuntimeInput,
  RuntimeRecord,
} from '../shared/types.js'

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
  readonly #supervisor: InstanceSupervisor
  readonly #environments: EnvironmentService
  readonly #listeners = new Set<(snapshot: ManagerSnapshot) => void>()
  readonly #environmentReservations = new Set<string>()

  constructor(dataRoot: string) {
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
  }

  async initialize(): Promise<void> {
    await this.#store.load()
    const interrupted = this.snapshot().instances.some(instance => ['starting', 'running', 'stopping'].includes(instance.status))
    if (interrupted) {
      await this.#store.update(draft => {
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
    await this.#store.update(draft => { draft.runtimes.push(runtime) })
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

  async createInstance(input: CreateInstanceInput): Promise<InstanceRecord> {
    const snapshot = this.snapshot()
    requiredById(snapshot.runtimes, input.runtimeId, 'Runtime')
    requiredById(snapshot.environments, input.environmentId, 'Environment')
    const workspacePath = await realpath(requiredText(input.workspacePath, 'Workspace path'))
    const port = input.port ?? 0
    if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('Port must be 0 or an integer between 1 and 65535')
    const instance: InstanceRecord = {
      id: `instance-${randomUUID()}`,
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

  async startInstance(instanceId: string): Promise<InstanceRecord> {
    let snapshot = this.snapshot()
    const instance = requiredById(snapshot.instances, instanceId, 'Instance')
    if (instance.interrupted) throw new Error('该实例上次被中断，请先确认旧进程已停止。')
    if (instance.portModeReviewRequired) throw new Error('该实例来自旧版状态，请先选择自动或固定端口模式。')
    const environment = requiredById(snapshot.environments, instance.environmentId, 'Environment')
    const occupant = snapshot.instances.find(candidate => {
      if (candidate.id === instance.id || !['starting', 'running', 'stopping'].includes(candidate.status)) return false
      const candidateEnvironment = snapshot.environments.find(item => item.id === candidate.environmentId)
      return candidateEnvironment?.path === environment.path
    })
    if (occupant) throw new Error(`Environment is already occupied by ${occupant.name}`)
    if (this.#environmentReservations.has(environment.path)) throw new Error('Environment has another operation in progress')
    this.#environmentReservations.add(environment.path)

    try {
      const runtime = await this.refreshRuntime(instance.runtimeId)
      snapshot = this.snapshot()
      const latestInstance = requiredById(snapshot.instances, instanceId, 'Instance')
      try {
        return await this.#supervisor.start(latestInstance, runtime, environment)
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
    const current = requiredById(this.snapshot().instances, instanceId, 'Instance')
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

  readInstanceLog(instanceId: string) {
    requiredById(this.snapshot().instances, instanceId, 'Instance')
    return this.#supervisor.readLog(instanceId)
  }

  async shutdown(): Promise<void> {
    if (this.#environmentReservations.size) throw new Error('环境操作仍在进行，请等待完成后再退出。')
    await this.#supervisor.stopAll(this.snapshot().instances)
  }

  #emit(): void {
    const snapshot = this.snapshot()
    for (const listener of this.#listeners) listener(snapshot)
  }
}
