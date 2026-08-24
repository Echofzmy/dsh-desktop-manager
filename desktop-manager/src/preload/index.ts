import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc.js'
import type {
  CloneEnvironmentInput,
  CreateEnvironmentInput,
  CreateInstanceInput,
  EmbeddedViewBounds,
  ManagerApi,
  ManagerSnapshot,
  RegisterRuntimeInput,
} from '../shared/types.js'

const api: ManagerApi = {
  getSnapshot: () => ipcRenderer.invoke(IPC.snapshot),
  registerRuntime: (input: RegisterRuntimeInput) => ipcRenderer.invoke(IPC.runtimeRegister, input),
  refreshRuntime: (runtimeId: string) => ipcRenderer.invoke(IPC.runtimeRefresh, runtimeId),
  createEnvironment: (input: CreateEnvironmentInput) => ipcRenderer.invoke(IPC.environmentCreate, input),
  cloneEnvironment: (input: CloneEnvironmentInput) => ipcRenderer.invoke(IPC.environmentClone, input),
  createInstance: (input: CreateInstanceInput) => ipcRenderer.invoke(IPC.instanceCreate, input),
  startInstance: (instanceId: string) => ipcRenderer.invoke(IPC.instanceStart, instanceId),
  stopInstance: (instanceId: string, force?: boolean) => ipcRenderer.invoke(IPC.instanceStop, instanceId, force),
  restartInstance: (instanceId: string) => ipcRenderer.invoke(IPC.instanceRestart, instanceId),
  recoverInstance: (instanceId: string, automaticPort: boolean) => ipcRenderer.invoke(IPC.instanceRecover, instanceId, automaticPort),
  readInstanceLog: (instanceId: string) => ipcRenderer.invoke(IPC.instanceLog, instanceId),
  chooseDirectory: () => ipcRenderer.invoke(IPC.directoryChoose),
  openExternal: (instanceId: string) => ipcRenderer.invoke(IPC.externalOpen, instanceId),
  showInstanceView: (instanceId: string, bounds: EmbeddedViewBounds) => ipcRenderer.invoke(IPC.viewShow, instanceId, bounds),
  hideInstanceView: () => ipcRenderer.invoke(IPC.viewHide),
  onSnapshotChanged: (listener: (snapshot: ManagerSnapshot) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, snapshot: ManagerSnapshot): void => listener(snapshot)
    ipcRenderer.on(IPC.snapshotChanged, wrapped)
    return () => ipcRenderer.removeListener(IPC.snapshotChanged, wrapped)
  },
}

contextBridge.exposeInMainWorld('manager', api)
