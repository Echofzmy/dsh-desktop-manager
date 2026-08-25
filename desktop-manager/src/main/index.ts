import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { IPC } from '../shared/ipc.js'
import type {
  CloneEnvironmentInput,
  CreateEnvironmentInput,
  CreateInstanceInput,
  CreateWorktreeInput,
  EmbeddedViewBounds,
  InstallOfficialRuntimeInput,
  RegisterRuntimeInput,
  UpdateSettingsInput,
} from '../shared/types.js'
import { InstanceViewManager } from './instance-view-manager.js'
import { ManagerService } from './manager-service.js'

let mainWindow: BrowserWindow | undefined
let manager: ManagerService | undefined
let views: InstanceViewManager | undefined
let shutdownStarted = false
let allowQuit = false

if (process.env.DSH_MANAGER_USER_DATA) {
  app.setPath('userData', process.env.DSH_MANAGER_USER_DATA)
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

function requiredManager(): ManagerService {
  if (!manager) throw new Error('Manager service is not ready')
  return manager
}

function assertSender(event: Electron.IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id || event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('IPC call did not originate from the manager window')
  }
}

function assertId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be a non-empty string`)
  return value
}

function assertBounds(value: unknown): EmbeddedViewBounds {
  if (typeof value !== 'object' || value === null) throw new Error('View bounds are required')
  const bounds = value as Partial<EmbeddedViewBounds>
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    if (typeof bounds[key] !== 'number' || !Number.isFinite(bounds[key])) throw new Error(`View bounds ${key} is invalid`)
  }
  return bounds as EmbeddedViewBounds
}

function registerIpc(): void {
  const handle = <T extends unknown[], R>(channel: string, action: (event: Electron.IpcMainInvokeEvent, ...args: T) => R | Promise<R>): void => {
    ipcMain.handle(channel, async (event, ...args: T) => {
      assertSender(event)
      return action(event, ...args)
    })
  }

  handle(IPC.snapshot, () => requiredManager().snapshot())
  handle(IPC.officialCheck, (_event, channel: unknown) => {
    if (channel !== 'stable' && channel !== 'prerelease') throw new Error('Official update channel is invalid')
    return requiredManager().checkOfficialUpdate(channel)
  })
  handle(IPC.officialInstall, (_event, input: InstallOfficialRuntimeInput) => {
    if (typeof input !== 'object' || input === null) throw new Error('Official install input is required')
    return requiredManager().installOfficialRuntime({ version: assertId(input.version, 'Official version') })
  })
  handle(IPC.officialInstallCancel, (_event, id: string) => requiredManager().cancelRuntimeInstall(assertId(id, 'Operation id')))
  handle(IPC.settingsUpdate, (_event, input: UpdateSettingsInput) => {
    if (typeof input !== 'object' || input === null) throw new Error('Settings input is required')
    if (input.openMode !== undefined && input.openMode !== 'embedded' && input.openMode !== 'external') throw new Error('Open mode is invalid')
    if (input.checkUpdatesOnStartup !== undefined && typeof input.checkUpdatesOnStartup !== 'boolean') throw new Error('Update preference is invalid')
    return requiredManager().updateSettings(input)
  })
  handle(IPC.runtimeRegister, (_event, input: RegisterRuntimeInput) => requiredManager().registerRuntime(input))
  handle(IPC.runtimeRefresh, (_event, id: string) => requiredManager().refreshRuntime(assertId(id, 'Runtime id')))
  handle(IPC.runtimeSetDefault, (_event, id: string) => requiredManager().setDefaultRuntime(assertId(id, 'Runtime id')))
  handle(IPC.runtimeDelete, (_event, id: string) => requiredManager().deleteRuntime(assertId(id, 'Runtime id')))
  handle(IPC.runtimeTaskStart, (_event, id: string, kind: unknown) => {
    if (kind !== 'install' && kind !== 'typecheck' && kind !== 'test' && kind !== 'build') throw new Error('Runtime task kind is invalid')
    return requiredManager().startRuntimeTask(assertId(id, 'Runtime id'), kind)
  })
  handle(IPC.runtimeTaskCancel, (_event, id: string) => requiredManager().cancelRuntimeTask(assertId(id, 'Task id')))
  handle(IPC.runtimeTaskLog, (_event, id: string) => requiredManager().readRuntimeTaskLog(assertId(id, 'Task id')))
  handle(IPC.runtimeWorktreeCreate, (_event, input: CreateWorktreeInput) => {
    if (typeof input !== 'object' || input === null) throw new Error('Worktree input is required')
    return requiredManager().createWorktree({ sourceRuntimeId: assertId(input.sourceRuntimeId, 'Source runtime id'), name: assertId(input.name, 'Worktree name'), ref: assertId(input.ref, 'Git ref') })
  })
  handle(IPC.environmentCreate, (_event, input: CreateEnvironmentInput) => requiredManager().createEnvironment(input))
  handle(IPC.environmentClone, (_event, input: CloneEnvironmentInput) => requiredManager().cloneEnvironment(input))
  handle(IPC.environmentDelete, (_event, id: string, deleteData: unknown) => requiredManager().deleteEnvironment(assertId(id, 'Environment id'), deleteData !== false))
  handle(IPC.environmentBackup, (_event, id: string) => requiredManager().createEnvironmentBackup(assertId(id, 'Environment id')))
  handle(IPC.instanceCreate, (_event, input: CreateInstanceInput) => requiredManager().createInstance(input))
  handle(IPC.instanceDelete, (_event, id: string, deleteEnvironment: unknown) => requiredManager().deleteInstance(assertId(id, 'Instance id'), deleteEnvironment === true))
  handle(IPC.promotionPrepare, (_event, candidateId: string, productionId: string, confirmed: unknown) => {
    if (typeof confirmed !== 'boolean') throw new Error('Promotion confirmation must be a boolean')
    return requiredManager().preparePromotion(assertId(candidateId, 'Candidate instance id'), assertId(productionId, 'Production instance id'), confirmed)
  })
  handle(IPC.promotionConfirm, (_event, id: string) => requiredManager().confirmPromotion(assertId(id, 'Promotion id')))
  handle(IPC.promotionRollback, (_event, id: string) => requiredManager().rollbackPromotion(assertId(id, 'Promotion id')))
  handle(IPC.promotionDismiss, (_event, id: string) => requiredManager().dismissPromotion(assertId(id, 'Promotion id')))
  handle(IPC.templateSave, (_event, instanceId: string, name: string) => requiredManager().saveInstanceTemplate(assertId(instanceId, 'Instance id'), assertId(name, 'Template name')))
  handle(IPC.templateInstantiate, (_event, templateId: string, name: string) => requiredManager().createInstanceFromTemplate(assertId(templateId, 'Template id'), assertId(name, 'Instance name')))
  handle(IPC.templateDelete, (_event, id: string) => requiredManager().deleteInstanceTemplate(assertId(id, 'Template id')))
  handle(IPC.instanceStart, (_event, id: string) => requiredManager().startInstance(assertId(id, 'Instance id')))
  handle(IPC.instanceStop, (_event, id: string, force?: boolean) => requiredManager().stopInstance(assertId(id, 'Instance id'), force === true))
  handle(IPC.instanceRestart, (_event, id: string) => requiredManager().restartInstance(assertId(id, 'Instance id')))
  handle(IPC.instanceRecover, (_event, id: string, automaticPort: unknown) => {
    if (typeof automaticPort !== 'boolean') throw new Error('Port mode must be a boolean')
    return requiredManager().recoverInstance(assertId(id, 'Instance id'), automaticPort)
  })
  handle(IPC.instanceLog, (_event, id: string) => requiredManager().readInstanceLog(assertId(id, 'Instance id')))
  handle(IPC.directoryChoose, async () => {
    const result = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0] ?? null
  })
  handle(IPC.externalOpen, async (_event, id: string) => {
    const instance = requiredManager().snapshot().instances.find(item => item.id === assertId(id, 'Instance id'))
    if (!instance) throw new Error('Instance does not exist')
    await views!.openExternal(instance)
  })
  handle(IPC.viewShow, async (_event, id: string, rawBounds: EmbeddedViewBounds) => {
    const instance = requiredManager().snapshot().instances.find(item => item.id === assertId(id, 'Instance id'))
    if (!instance) throw new Error('Instance does not exist')
    await views!.show(instance, assertBounds(rawBounds))
  })
  handle(IPC.viewHide, () => views!.hide())
}

function installMenu(): void {
  const send = (command: 'home' | 'runtimes' | 'settings' | 'new-instance'): void => {
    mainWindow?.show()
    mainWindow?.focus()
    mainWindow?.webContents.send(IPC.menuCommand, command)
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: 'DSH 管理器', submenu: [{ role: 'about' as const }, { type: 'separator' as const }, { label: '设置…', accelerator: 'CommandOrControl+,', click: () => send('settings') }, { type: 'separator' as const }, { role: 'hide' as const }, { role: 'hideOthers' as const }, { role: 'unhide' as const }, { type: 'separator' as const }, { role: 'quit' as const }] }] : []),
    { label: '文件', submenu: [{ label: '新建实例', accelerator: 'CommandOrControl+N', click: () => send('new-instance') }, { type: 'separator' }, ...(process.platform === 'darwin' ? [] : [{ role: 'quit' as const }])] },
    { label: '前往', submenu: [{ label: '概览', accelerator: 'CommandOrControl+1', click: () => send('home') }, { label: '运行时', accelerator: 'CommandOrControl+2', click: () => send('runtimes') }, { label: '设置', accelerator: 'CommandOrControl+,', click: () => send('settings') }] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, ...(process.platform === 'darwin' ? [{ type: 'separator' as const }, { role: 'front' as const }] : [])] },
  ]))
}

async function createWindow(): Promise<void> {
  const bundledRuntimeRoot = app.isPackaged
    ? join(process.resourcesPath, 'runtimes', 'official', 'bundled', 'current')
    : join(app.getAppPath(), 'build', 'bundled-runtime')
  manager = new ManagerService(app.getPath('userData'), bundledRuntimeRoot)
  await manager.initialize()

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#f5f6f8',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(fileURLToPath(new URL('.', import.meta.url)), '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  views = new InstanceViewManager(mainWindow)
  installMenu()
  registerIpc()
  manager.subscribe(snapshot => {
    if (!mainWindow?.isDestroyed()) mainWindow?.webContents.send(IPC.snapshotChanged, snapshot)
  })

  mainWindow.on('close', event => {
    if (allowQuit) return
    event.preventDefault()
    views?.hide()
    if (process.platform === 'darwin') mainWindow?.hide()
    else app.quit()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    await mainWindow.loadFile(join(fileURLToPath(new URL('.', import.meta.url)), '../renderer/index.html'))
  }
}

if (hasSingleInstanceLock) {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore()
    mainWindow?.show()
    mainWindow?.focus()
  })
  void app.whenReady().then(createWindow)
}

app.on('activate', () => mainWindow?.show())

app.on('before-quit', event => {
  if (!manager) {
    allowQuit = true
    return
  }
  if (allowQuit || shutdownStarted) return
  event.preventDefault()
  shutdownStarted = true
  void requiredManager().shutdown().then(() => {
    allowQuit = true
    views?.destroy()
    app.quit()
  }).catch(error => {
    shutdownStarted = false
    dialog.showErrorBox('无法退出 DSH 管理器', `仍有实例无法停止：${error instanceof Error ? error.message : String(error)}`)
    mainWindow?.show()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
