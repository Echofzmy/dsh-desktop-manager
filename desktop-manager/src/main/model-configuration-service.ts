import { join } from 'node:path'
import { InstanceSupervisor } from './instance-supervisor.js'
import { ModelSettingsProjection } from './model-settings-projection.js'
import type { EnvironmentRecord, InstanceRecord, RuntimeRecord } from '../shared/types.js'

const INTERNAL_INSTANCE_ID = 'internal-model-configuration'
const INTERNAL_ENVIRONMENT_ID = 'internal-model-configuration-home'
const MODEL_HOST_ENVIRONMENT_ALLOWLIST = new Set([
  'HOME', 'PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'SHELL', 'TERM',
  'NO_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
])

export class ModelConfigurationService {
  readonly #projection: ModelSettingsProjection
  readonly #supervisor: InstanceSupervisor
  #instance: InstanceRecord | undefined
  #pending: Promise<InstanceRecord> | undefined
  #pendingIntent = 0
  #queue: Promise<void> = Promise.resolve()
  #intent = 0
  #reservedRuntimeId: string | undefined

  constructor(dataRoot: string, projection: ModelSettingsProjection) {
    this.#projection = projection
    this.#supervisor = new InstanceSupervisor(join(dataRoot, 'model-configuration', 'logs'), {
      onStatus: (_instanceId, patch) => {
        if (this.#instance) this.#instance = { ...this.#instance, ...patch }
      },
    })
  }

  reserveRuntime(runtimeId: string): void {
    if (this.#reservedRuntimeId && this.#reservedRuntimeId !== runtimeId) throw new Error('另一个运行版本正在用于模型配置。')
    this.#reservedRuntimeId = runtimeId
  }

  releaseRuntimeReservation(runtimeId: string): void {
    if (this.#reservedRuntimeId === runtimeId && !this.#supervisor.isRunning(INTERNAL_INSTANCE_ID)) this.#reservedRuntimeId = undefined
  }

  usesRuntime(runtimeId: string): boolean {
    return this.#reservedRuntimeId === runtimeId || (this.#instance?.runtimeId === runtimeId && (this.#pending !== undefined || this.#supervisor.isRunning(INTERNAL_INSTANCE_ID)))
  }

  ensureRunning(runtime: RuntimeRecord): Promise<InstanceRecord> {
    this.reserveRuntime(runtime.id)
    if (this.#pending && this.#pendingIntent === this.#intent) return this.#pending
    const intent = ++this.#intent
    const operation = this.#queue.then(async () => {
      if (intent !== this.#intent) throw new Error('模型配置页面已经关闭。')
      const instance = await this.#start(runtime)
      if (intent === this.#intent) return instance
      if (this.#supervisor.isRunning(INTERNAL_INSTANCE_ID)) await this.#supervisor.stop(instance)
      throw new Error('模型配置页面已经关闭。')
    })
    const settled = operation.finally(() => {
      if (this.#pending === settled) this.#pending = undefined
    })
    this.#pending = settled
    this.#pendingIntent = intent
    this.#queue = settled.then(() => undefined, () => undefined)
    return settled
  }

  async #start(runtime: RuntimeRecord): Promise<InstanceRecord> {
    if (this.#instance && this.#supervisor.isRunning(INTERNAL_INSTANCE_ID)) {
      if (this.#instance.runtimeId === runtime.id) return this.#instance
      await this.#supervisor.stop(this.#instance)
    }
    const createdAt = new Date().toISOString()
    const environment: EnvironmentRecord = {
      id: INTERNAL_ENVIRONMENT_ID,
      name: '共享模型配置',
      kind: 'isolated',
      path: this.#projection.home,
      createdAt,
    }
    this.#instance = {
      id: INTERNAL_INSTANCE_ID,
      name: '模型配置',
      runtimeId: runtime.id,
      workspacePath: this.#projection.workspacePath,
      environmentId: environment.id,
      port: 0,
      automaticPort: true,
      createdAt,
      status: 'stopped',
    }
    const inheritedCredentialKeys = Object.keys(process.env).filter(key => !MODEL_HOST_ENVIRONMENT_ALLOWLIST.has(key.toUpperCase()))
    this.#instance = await this.#supervisor.start(this.#instance, runtime, environment, { removeEnvironmentKeys: inheritedCredentialKeys, watchParent: true })
    return this.#instance
  }

  stop(): Promise<void> {
    this.#intent += 1
    const operation = this.#queue.then(async () => {
      if (this.#instance && this.#supervisor.isRunning(INTERNAL_INSTANCE_ID)) await this.#supervisor.stop(this.#instance)
      this.#instance = undefined
      this.#reservedRuntimeId = undefined
    })
    this.#queue = operation.then(() => undefined, () => undefined)
    return operation
  }
}
