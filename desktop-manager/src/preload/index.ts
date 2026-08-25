import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc.js'
import type {
  CloneEnvironmentInput,
  CreateEnvironmentInput,
  CreateInstanceInput,
  CreateWorktreeInput,
  EmbeddedViewBounds,
  InstallOfficialRuntimeInput,
  ManagerApi,
  ManagerSnapshot,
  RegisterRuntimeInput,
  UpdateSettingsInput,
} from '../shared/types.js'

const api: ManagerApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC.snapshot),
  checkOfficialUpdate: (channel: 'stable' | 'prerelease') => ipcRenderer.invoke(IPC.officialCheck, channel),
  installOfficialRuntime: (input: InstallOfficialRuntimeInput) => ipcRenderer.invoke(IPC.officialInstall, input),
  cancelRuntimeInstall: (operationId: string) => ipcRenderer.invoke(IPC.officialInstallCancel, operationId),
  updateSettings: (input: UpdateSettingsInput) => ipcRenderer.invoke(IPC.settingsUpdate, input),
  registerRuntime: (input: RegisterRuntimeInput) => ipcRenderer.invoke(IPC.runtimeRegister, input),
  refreshRuntime: (runtimeId: string) => ipcRenderer.invoke(IPC.runtimeRefresh, runtimeId),
  setDefaultRuntime: (runtimeId: string) => ipcRenderer.invoke(IPC.runtimeSetDefault, runtimeId),
  deleteRuntime: (runtimeId: string) => ipcRenderer.invoke(IPC.runtimeDelete, runtimeId),
  startRuntimeTask: (runtimeId, kind) => ipcRenderer.invoke(IPC.runtimeTaskStart, runtimeId, kind),
  cancelRuntimeTask: (taskId: string) => ipcRenderer.invoke(IPC.runtimeTaskCancel, taskId),
  readRuntimeTaskLog: (taskId: string) => ipcRenderer.invoke(IPC.runtimeTaskLog, taskId),
  createWorktree: (input: CreateWorktreeInput) => ipcRenderer.invoke(IPC.runtimeWorktreeCreate, input),
  createEnvironment: (input: CreateEnvironmentInput) => ipcRenderer.invoke(IPC.environmentCreate, input),
  cloneEnvironment: (input: CloneEnvironmentInput) => ipcRenderer.invoke(IPC.environmentClone, input),
  deleteEnvironment: (environmentId: string, deleteData?: boolean) => ipcRenderer.invoke(IPC.environmentDelete, environmentId, deleteData),
  createEnvironmentBackup: (environmentId: string) => ipcRenderer.invoke(IPC.environmentBackup, environmentId),
  createInstance: (input: CreateInstanceInput) => ipcRenderer.invoke(IPC.instanceCreate, input),
  deleteInstance: (instanceId: string, deleteEnvironment?: boolean) => ipcRenderer.invoke(IPC.instanceDelete, instanceId, deleteEnvironment),
  preparePromotion: (candidateInstanceId: string, productionInstanceId: string, testConfirmed: boolean) => ipcRenderer.invoke(IPC.promotionPrepare, candidateInstanceId, productionInstanceId, testConfirmed),
  confirmPromotion: (promotionId: string) => ipcRenderer.invoke(IPC.promotionConfirm, promotionId),
  rollbackPromotion: (promotionId: string) => ipcRenderer.invoke(IPC.promotionRollback, promotionId),
  dismissPromotion: (promotionId: string) => ipcRenderer.invoke(IPC.promotionDismiss, promotionId),
  saveInstanceTemplate: (instanceId: string, name: string) => ipcRenderer.invoke(IPC.templateSave, instanceId, name),
  createInstanceFromTemplate: (templateId: string, name: string) => ipcRenderer.invoke(IPC.templateInstantiate, templateId, name),
  deleteInstanceTemplate: (templateId: string) => ipcRenderer.invoke(IPC.templateDelete, templateId),
  startInstance: (instanceId: string) => ipcRenderer.invoke(IPC.instanceStart, instanceId),
  stopInstance: (instanceId: string, force?: boolean) => ipcRenderer.invoke(IPC.instanceStop, instanceId, force),
  restartInstance: (instanceId: string) => ipcRenderer.invoke(IPC.instanceRestart, instanceId),
  recoverInstance: (instanceId: string, automaticPort: boolean) => ipcRenderer.invoke(IPC.instanceRecover, instanceId, automaticPort),
  readInstanceLog: (instanceId: string) => ipcRenderer.invoke(IPC.instanceLog, instanceId),
  chooseDirectory: () => ipcRenderer.invoke(IPC.directoryChoose),
  openExternal: (instanceId: string) => ipcRenderer.invoke(IPC.externalOpen, instanceId),
  showInstanceView: (instanceId: string, bounds: EmbeddedViewBounds) => ipcRenderer.invoke(IPC.viewShow, instanceId, bounds),
  showModelConfiguration: (bounds: EmbeddedViewBounds, openSettings: boolean) => ipcRenderer.invoke(IPC.modelViewShow, bounds, openSettings),
  closeModelConfiguration: () => ipcRenderer.invoke(IPC.modelViewClose),
  hideInstanceView: () => ipcRenderer.invoke(IPC.viewHide),
  onSnapshotChanged: (listener: (snapshot: ManagerSnapshot) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, snapshot: ManagerSnapshot): void => listener(snapshot)
    ipcRenderer.on(IPC.snapshotChanged, wrapped)
    return () => ipcRenderer.removeListener(IPC.snapshotChanged, wrapped)
  },
  onMenuCommand: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, command: 'home' | 'runtimes' | 'models' | 'settings' | 'new-instance'): void => listener(command)
    ipcRenderer.on(IPC.menuCommand, wrapped)
    return () => ipcRenderer.removeListener(IPC.menuCommand, wrapped)
  },
}

contextBridge.exposeInMainWorld('manager', api)
