import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { IPC } from '../shared/ipc.js'
import type {
  CloneEnvironmentInput,
  CreateEnvironmentInput,
  CreateInstanceInput,
  EmbeddedViewBounds,
  RegisterRuntimeInput,
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
  handle(IPC.runtimeRegister, (_event, input: RegisterRuntimeInput) => requiredManager().registerRuntime(input))
  handle(IPC.runtimeRefresh, (_event, id: string) => requiredManager().refreshRuntime(assertId(id, 'Runtime id')))
  handle(IPC.environmentCreate, (_event, input: CreateEnvironmentInput) => requiredManager().createEnvironment(input))
  handle(IPC.environmentClone, (_event, input: CloneEnvironmentInput) => requiredManager().cloneEnvironment(input))
  handle(IPC.instanceCreate, (_event, input: CreateInstanceInput) => requiredManager().createInstance(input))
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

async function createWindow(): Promise<void> {
  manager = new ManagerService(app.getPath('userData'))
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
