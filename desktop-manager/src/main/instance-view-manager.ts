import { BrowserWindow, WebContentsView, session, shell, type Rectangle } from 'electron'
import type { InstanceRecord } from '../shared/types.js'

function managedUrl(instance: InstanceRecord): string {
  if (instance.status !== 'running' || instance.port <= 0) throw new Error('Instance is not ready for a Web view')
  return `http://127.0.0.1:${instance.port}/`
}

function safeBounds(bounds: Rectangle, window: BrowserWindow): Rectangle {
  const content = window.getContentBounds()
  const x = Math.max(0, Math.round(bounds.x))
  const y = Math.max(0, Math.round(bounds.y))
  return {
    x,
    y,
    width: Math.max(1, Math.min(Math.round(bounds.width), content.width - x)),
    height: Math.max(1, Math.min(Math.round(bounds.height), content.height - y)),
  }
}

export class InstanceViewManager {
  readonly #window: BrowserWindow
  readonly #views = new Map<string, WebContentsView>()
  readonly #origins = new Map<string, string>()
  readonly #loads = new Map<string, Promise<void>>()
  #visibleId: string | undefined
  #intent = 0

  constructor(window: BrowserWindow) {
    this.#window = window
  }

  async show(instance: InstanceRecord, bounds: Rectangle): Promise<void> {
    const intent = ++this.#intent
    const url = managedUrl(instance)
    const origin = new URL(url).origin
    let view = this.#views.get(instance.id)
    if (view && this.#origins.get(instance.id) !== origin) {
      if (this.#visibleId === instance.id) this.#detachVisible()
      view.webContents.close()
      this.#views.delete(instance.id)
      this.#origins.delete(instance.id)
      this.#loads.delete(instance.id)
      view = undefined
    }
    if (!view) {
      const partition = `persist:dsh-instance-${instance.id}`
      const isolatedSession = session.fromPartition(partition)
      isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      isolatedSession.setPermissionCheckHandler(() => false)
      view = new WebContentsView({
        webPreferences: {
          partition,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
        },
      })
      view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      view.webContents.on('will-navigate', event => {
        if (new URL(event.url).origin !== origin) event.preventDefault()
      })
      view.webContents.on('will-redirect', event => {
        if (new URL(event.url).origin !== origin) event.preventDefault()
      })
      view.webContents.session.on('will-download', event => event.preventDefault())
      this.#views.set(instance.id, view)
      this.#origins.set(instance.id, origin)
    }
    await this.#load(instance.id, view, url, origin)
    if (intent !== this.#intent) return
    this.#detachVisible()
    this.#visibleId = instance.id
    this.#window.contentView.addChildView(view)
    view.setBounds(safeBounds(bounds, this.#window))
    view.setVisible(true)
  }

  hide(): void {
    this.#intent += 1
    this.#detachVisible()
  }

  #detachVisible(): void {
    if (!this.#visibleId) return
    const current = this.#views.get(this.#visibleId)
    if (current) this.#window.contentView.removeChildView(current)
    this.#visibleId = undefined
  }

  resize(bounds: Rectangle): void {
    if (!this.#visibleId) return
    this.#views.get(this.#visibleId)?.setBounds(safeBounds(bounds, this.#window))
  }

  async #load(id: string, view: WebContentsView, url: string, origin: string): Promise<void> {
    const pending = this.#loads.get(id)
    if (pending) return pending
    const currentUrl = view.webContents.getURL()
    if (currentUrl && new URL(currentUrl).origin === origin) return
    const loading = view.webContents.loadURL(url).then(() => undefined).finally(() => {
      if (this.#loads.get(id) === loading) this.#loads.delete(id)
    })
    this.#loads.set(id, loading)
    return loading
  }

  async openExternal(instance: InstanceRecord): Promise<void> {
    await shell.openExternal(managedUrl(instance))
  }

  destroy(): void {
    this.hide()
    for (const view of this.#views.values()) view.webContents.close()
    this.#views.clear()
    this.#origins.clear()
    this.#loads.clear()
  }
}
