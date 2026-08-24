export type RuntimeSource = 'local' | 'bundled' | 'downloaded'
export type CheckLevel = 'pass' | 'warning' | 'failure'
export type InstanceStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed'
export type EnvironmentKind = 'isolated' | 'clone' | 'production'

export interface PreflightCheck {
  id: string
  label: string
  level: CheckLevel
  detail: string
  remediation?: string
}

export interface PreflightReport {
  checkedAt: string
  ready: boolean
  entryPath?: string
  nodeVersion?: string | undefined
  pnpmVersion?: string
  packageVersion?: string
  gitCommit?: string
  gitDirty?: boolean
  checks: PreflightCheck[]
}

export interface RuntimeRecord {
  id: string
  name: string
  source: RuntimeSource
  path: string
  registeredAt: string
  preflight: PreflightReport
}

export interface EnvironmentLineage {
  sourceEnvironmentId: string
  sourceInstanceId?: string
  sourceRuntimeId: string
  sourceRuntimeCommit?: string
  clonedAt: string
  method: 'apfs-clone' | 'copy'
}

export interface EnvironmentRecord {
  id: string
  name: string
  kind: EnvironmentKind
  path: string
  createdAt: string
  lineage?: EnvironmentLineage
}

export interface InstanceRecord {
  id: string
  name: string
  runtimeId: string
  workspacePath: string
  environmentId: string
  port: number
  automaticPort: boolean
  portModeReviewRequired?: boolean
  interrupted?: boolean
  createdAt: string
  status: InstanceStatus
  pid?: number | undefined
  startedAt?: string
  stoppedAt?: string
  exitCode?: number | null
  lastError?: string | undefined
  health?: {
    checkedAt: string
    ok: boolean
    detail: string
  }
}

export interface ManagerSnapshot {
  runtimes: RuntimeRecord[]
  environments: EnvironmentRecord[]
  instances: InstanceRecord[]
}

export interface RegisterRuntimeInput {
  name: string
  path: string
}

export interface CreateEnvironmentInput {
  name: string
  kind: 'isolated' | 'production'
  path?: string
}

export interface CloneEnvironmentInput {
  name: string
  sourceEnvironmentId: string
  sourceInstanceId?: string
  targetRuntimeId: string
}

export interface CreateInstanceInput {
  name: string
  runtimeId: string
  workspacePath: string
  environmentId: string
  port?: number
}

export interface InstanceLog {
  path: string
  content: string
  truncated: boolean
}

export interface EmbeddedViewBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface ManagerApi {
  getSnapshot(): Promise<ManagerSnapshot>
  registerRuntime(input: RegisterRuntimeInput): Promise<RuntimeRecord>
  refreshRuntime(runtimeId: string): Promise<RuntimeRecord>
  createEnvironment(input: CreateEnvironmentInput): Promise<EnvironmentRecord>
  cloneEnvironment(input: CloneEnvironmentInput): Promise<EnvironmentRecord>
  createInstance(input: CreateInstanceInput): Promise<InstanceRecord>
  startInstance(instanceId: string): Promise<InstanceRecord>
  stopInstance(instanceId: string, force?: boolean): Promise<InstanceRecord>
  restartInstance(instanceId: string): Promise<InstanceRecord>
  recoverInstance(instanceId: string, automaticPort: boolean): Promise<InstanceRecord>
  readInstanceLog(instanceId: string): Promise<InstanceLog>
  chooseDirectory(): Promise<string | null>
  openExternal(instanceId: string): Promise<void>
  showInstanceView(instanceId: string, bounds: EmbeddedViewBounds): Promise<void>
  hideInstanceView(): Promise<void>
  onSnapshotChanged(listener: (snapshot: ManagerSnapshot) => void): () => void
}
