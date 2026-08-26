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
  buildFingerprint?: string
  checks: PreflightCheck[]
}

export interface RuntimeRecord {
  id: string
  name: string
  source: RuntimeSource
  path: string
  managedPath?: string
  integrity?: string
  installReceiptPath?: string
  version?: string
  taskBlocked?: string
  immutable?: boolean
  worktreeSourcePath?: string
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

export type RuntimeTaskKind = 'install' | 'typecheck' | 'test' | 'build'
export type RuntimeTaskStatus = 'prepared' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
export type OperationStatus = 'prepared' | 'running' | 'awaiting-confirmation' | 'recovery-required' | 'committed' | 'rolled-back' | 'failed'

export interface ManagerSettings {
  defaultRuntimeId?: string
  productionInstanceId?: string
  openMode: 'embedded' | 'external'
  checkUpdatesOnStartup: boolean
}

export interface UpdateSettingsInput {
  openMode?: 'embedded' | 'external'
  checkUpdatesOnStartup?: boolean
}

export interface RuntimeTaskRecord {
  id: string
  requestId: string
  runtimeId: string
  kind: RuntimeTaskKind
  status: RuntimeTaskStatus
  phase: string
  logPath: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
  pid?: number
  error?: string
}

export interface BackupRecord {
  id: string
  environmentId: string
  path: string
  manifestPath: string
  status: 'ready' | 'failed'
  createdAt: string
  error?: string
}

export interface PromotionRecord {
  id: string
  candidateInstanceId: string
  productionInstanceId: string
  previousRuntimeId: string
  targetRuntimeId: string
  backupId: string
  previousBuildFingerprint?: string
  targetBuildFingerprint?: string
  status: 'awaiting-confirmation' | 'committed' | 'rolled-back' | 'failed'
  createdAt: string
  updatedAt: string
  error?: string
}

export interface OperationRecord {
  id: string
  requestId: string
  type: 'runtime-install' | 'runtime-task' | 'delete-instance' | 'delete-environment' | 'delete-runtime' | 'backup' | 'promotion' | 'rollback'
  status: OperationStatus
  phase: string
  resourceKeys: string[]
  input: Record<string, string | boolean | number | null>
  artifacts: Record<string, string>
  restartInstanceIds?: string[]
  error?: string
  createdAt: string
  updatedAt: string
}

export interface InstanceTemplate {
  id: string
  name: string
  runtimeId: string
  workspacePath: string
  environmentMode: 'new-isolated' | 'existing'
  environmentId?: string
  port: number
  createdAt: string
}

export interface ManagerSnapshot {
  settings: ManagerSettings
  runtimes: RuntimeRecord[]
  environments: EnvironmentRecord[]
  instances: InstanceRecord[]
  tasks: RuntimeTaskRecord[]
  backups: BackupRecord[]
  promotions: PromotionRecord[]
  operations: OperationRecord[]
  templates: InstanceTemplate[]
}

export interface OfficialUpdateInfo {
  channel: 'stable' | 'prerelease'
  version: string
  integrity: string
  tarball: string
  unpackedSize?: number
  installed: boolean
  isDefault: boolean
}

export interface InstallOfficialRuntimeInput {
  version: string
}

export interface RegisterRuntimeInput {
  name: string
  path: string
}

export interface CreateWorktreeInput {
  sourceRuntimeId: string
  name: string
  ref: string
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
  workspacePath?: string
  environmentId: string
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

export interface UnifiedModelProfile {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
}

export type UnifiedProviderProtocol = 'deepseek' | 'openai-completions' | 'openai-responses' | 'anthropic-messages'

export interface UnifiedProviderProfile {
  id: string
  kind: 'deepseek' | 'catalog' | 'custom'
  displayName: string
  protocol: UnifiedProviderProtocol
  apiKeyRef: string
  hasApiKey: boolean
  baseURL?: string
  timeoutMs?: number | null
  streamIdleTimeoutMs?: number | null
  models: UnifiedModelProfile[]
}

export type UnifiedReasoningEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface UnifiedConfiguration {
  providers: UnifiedProviderProfile[]
  defaultModel?: { provider: string; model: string }
  defaultReasoningEffort?: UnifiedReasoningEffort
  defaultPermission: 'read-only' | 'workspace-write' | 'danger-full-access'
  defaultAgentPreset: string
  locale: 'system' | 'zh' | 'en'
  theme: 'system' | 'light' | 'dark'
  busyEnter: 'steer' | 'queue'
}

export interface SaveUnifiedConfigurationInput {
  providers: Array<Omit<UnifiedProviderProfile, 'hasApiKey'>>
  defaultModel?: { provider: string; model: string }
  defaultReasoningEffort?: UnifiedReasoningEffort
  defaultPermission: UnifiedConfiguration['defaultPermission']
  defaultAgentPreset: string
  locale: UnifiedConfiguration['locale']
  theme: UnifiedConfiguration['theme']
  busyEnter: UnifiedConfiguration['busyEnter']
}

export interface DiscoverUnifiedModelsInput {
  providerId: string
  protocol: UnifiedProviderProtocol
  baseURL?: string
  apiKey?: string
}

export interface SetUnifiedCredentialInput {
  ref: string
  value: string | null
}

export interface ManagerApi {
  getSnapshot(): Promise<ManagerSnapshot>
  checkOfficialUpdate(channel: 'stable' | 'prerelease'): Promise<OfficialUpdateInfo>
  installOfficialRuntime(input: InstallOfficialRuntimeInput): Promise<OperationRecord>
  cancelRuntimeInstall(operationId: string): Promise<void>
  updateSettings(input: UpdateSettingsInput): Promise<ManagerSettings>
  registerRuntime(input: RegisterRuntimeInput): Promise<RuntimeRecord>
  refreshRuntime(runtimeId: string): Promise<RuntimeRecord>
  setDefaultRuntime(runtimeId: string): Promise<RuntimeRecord>
  deleteRuntime(runtimeId: string): Promise<void>
  startRuntimeTask(runtimeId: string, kind: RuntimeTaskKind): Promise<RuntimeTaskRecord>
  cancelRuntimeTask(taskId: string): Promise<void>
  readRuntimeTaskLog(taskId: string): Promise<InstanceLog>
  createWorktree(input: CreateWorktreeInput): Promise<RuntimeRecord>
  createEnvironment(input: CreateEnvironmentInput): Promise<EnvironmentRecord>
  cloneEnvironment(input: CloneEnvironmentInput): Promise<EnvironmentRecord>
  deleteEnvironment(environmentId: string, deleteData?: boolean): Promise<void>
  createEnvironmentBackup(environmentId: string): Promise<BackupRecord>
  createInstance(input: CreateInstanceInput): Promise<InstanceRecord>
  deleteInstance(instanceId: string, deleteEnvironment?: boolean): Promise<void>
  preparePromotion(candidateInstanceId: string, productionInstanceId: string, testConfirmed: boolean): Promise<PromotionRecord>
  confirmPromotion(promotionId: string): Promise<PromotionRecord>
  rollbackPromotion(promotionId: string): Promise<PromotionRecord>
  dismissPromotion(promotionId: string): Promise<PromotionRecord>
  saveInstanceTemplate(instanceId: string, name: string): Promise<InstanceTemplate>
  createInstanceFromTemplate(templateId: string, name: string): Promise<InstanceRecord>
  deleteInstanceTemplate(templateId: string): Promise<void>
  startInstance(instanceId: string): Promise<InstanceRecord>
  stopInstance(instanceId: string, force?: boolean): Promise<InstanceRecord>
  restartInstance(instanceId: string): Promise<InstanceRecord>
  recoverInstance(instanceId: string, automaticPort: boolean): Promise<InstanceRecord>
  readInstanceLog(instanceId: string): Promise<InstanceLog>
  chooseDirectory(): Promise<string | null>
  openExternal(instanceId: string): Promise<void>
  showInstanceView(instanceId: string, bounds: EmbeddedViewBounds): Promise<void>
  getUnifiedConfiguration(): Promise<UnifiedConfiguration>
  discoverUnifiedModels(input: DiscoverUnifiedModelsInput): Promise<UnifiedModelProfile[]>
  saveUnifiedConfiguration(input: SaveUnifiedConfigurationInput): Promise<UnifiedConfiguration>
  setUnifiedCredential(input: SetUnifiedCredentialInput): Promise<UnifiedConfiguration>
  hideInstanceView(): Promise<void>
  onSnapshotChanged(listener: (snapshot: ManagerSnapshot) => void): () => void
  onMenuCommand(listener: (command: 'home' | 'runtimes' | 'models' | 'settings' | 'new-instance') => void): () => void
}
