import { BrowserWindow, WebContentsView, session, shell, type Rectangle } from 'electron'
import type { InstanceRecord, ModelConfigurationViewResult } from '../shared/types.js'

const MODEL_CONFIGURATION_INSTANCE_ID = 'internal-model-configuration'
const MODEL_CONFIGURATION_MODE_SCRIPT = String.raw`(() => {
  if (document.getElementById('dsh-manager-configuration-style')) return
  const style = document.createElement('style')
  style.id = 'dsh-manager-configuration-style'
  style.textContent = [
    'html,body{background:#f5f7fa!important;}',
    'body>*{visibility:hidden!important;pointer-events:none!important;}',
    '[data-dsh-manager-configuration-visible],[data-dsh-manager-configuration-visible] *{visibility:visible!important;}',
    '[data-dsh-manager-configuration-visible]{pointer-events:auto!important;}',
    '#dsh-manager-configuration-guard{position:fixed;inset:0;z-index:2147483646;display:grid;place-items:center;background:#f5f7fa;color:#626a78;font:14px/22px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;visibility:visible!important;pointer-events:auto!important;}',
    '#dsh-manager-configuration-guard[hidden]{display:none!important;}',
  ].join('')
  document.head.appendChild(style)
  const guard = document.createElement('div')
  guard.id = 'dsh-manager-configuration-guard'
  guard.textContent = '正在打开统一设置…'
  document.body.appendChild(guard)
  const dialogs = () => [...document.querySelectorAll('[role="dialog"]')]
  const isSettingsDialog = dialog => {
    const text = dialog.textContent || ''
    return (text.includes('通用设置') && text.includes('模型')) || (text.includes('General') && text.includes('Models'))
  }
  const isOnboardingDialog = dialog => [
    '内测声明',
    'Internal Testing Notice',
    '添加一个 API Key 开始使用',
    'Add an API key to get started',
  ].includes(dialog.getAttribute('aria-label') || '')
  const isApprovedNestedDialog = dialog => {
    const title = dialog.getAttribute('aria-label') || ''
    return [
      '选择要添加的模型',
      'Choose models to add',
      '复制预设',
      'Duplicate preset',
      '删除该预设？',
      'Delete this preset?',
      '确认启用 Full access？',
      'Enable Full access?',
    ].includes(title)
      || title.startsWith('复制预设 · ')
      || title.startsWith('Duplicate preset · ')
      || title.startsWith('查看 · ')
      || title.startsWith('View · ')
      || (title.startsWith('删除 ') && title.endsWith('？'))
      || (title.startsWith('Delete ') && title.endsWith('?'))
  }
  const refresh = () => {
    const open = dialogs()
    const menus = [...document.querySelectorAll('[role="menu"]')]
    for (const element of [...open, ...menus]) element.removeAttribute('data-dsh-manager-configuration-visible')
    const settings = open.find(isSettingsDialog)
    const visible = settings
      ? open.filter(dialog => dialog === settings || isApprovedNestedDialog(dialog))
      : open.filter(isOnboardingDialog)
    for (const dialog of visible) dialog.setAttribute('data-dsh-manager-configuration-visible', '')
    if (settings) for (const menu of menus) menu.setAttribute('data-dsh-manager-configuration-visible', '')
    guard.hidden = visible.length > 0
  }
  new MutationObserver(refresh).observe(document.body, { childList: true, subtree: true })
  refresh()
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return
    const open = dialogs().filter(dialog => dialog.hasAttribute('data-dsh-manager-configuration-visible'))
    const settings = open.find(isSettingsDialog)
    if (!settings) return
    event.preventDefault()
    event.stopImmediatePropagation()
    const menu = [...document.querySelectorAll('[role="menu"]')].reverse().find(element => element.hasAttribute('data-dsh-manager-configuration-visible'))
    if (menu) {
      settings.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }))
      return
    }
    const nested = [...open].reverse().find(dialog => dialog !== settings)
    const dismiss = nested ? [...nested.querySelectorAll('button')].find(button => {
      const labels = [button.getAttribute('aria-label'), button.getAttribute('title'), button.textContent].filter(Boolean).map(value => value.trim())
      return labels.some(value => ['关闭', 'Close', '取消', 'Cancel'].includes(value))
    }) : null
    dismiss?.click()
  }, true)
  document.addEventListener('click', event => {
    const open = dialogs().filter(dialog => dialog.hasAttribute('data-dsh-manager-configuration-visible'))
    const settings = open.find(isSettingsDialog)
    if (!settings) return
    const target = event.target instanceof Element ? event.target : null
    const button = target?.closest('button')
    const closestDialog = target?.closest('[role="dialog"]')
    const label = button ? [button.getAttribute('aria-label'), button.getAttribute('title'), button.textContent].filter(Boolean).map(value => value.trim()) : []
    if (target?.getAttribute('aria-hidden') === 'true' && target.parentElement?.contains(settings)) {
      event.preventDefault()
      event.stopImmediatePropagation()
      return
    }
    if (button && closestDialog === settings && label.some(value => ['关闭', '关闭设置', 'Close', 'Close settings'].includes(value))) {
      event.preventDefault()
      event.stopImmediatePropagation()
      return
    }
  }, true)
})()`

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
      if (instance.id === MODEL_CONFIGURATION_INSTANCE_ID) {
        const configurationView = view
        configurationView.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
          if (isMainFrame && !isInPlace) configurationView.setVisible(false)
        })
        configurationView.webContents.on('did-finish-load', () => {
          void configurationView.webContents.executeJavaScript(MODEL_CONFIGURATION_MODE_SCRIPT, true).then(async () => {
            if (this.#visibleId !== instance.id) return
            configurationView.setVisible(true)
            await this.openConfigurationSettings(instance.id)
          }).catch(() => configurationView.setVisible(false))
        })
      }
      this.#views.set(instance.id, view)
      this.#origins.set(instance.id, origin)
    }
    await this.#load(instance.id, view, url, origin)
    if (instance.id === MODEL_CONFIGURATION_INSTANCE_ID) await view.webContents.executeJavaScript(MODEL_CONFIGURATION_MODE_SCRIPT, true)
    if (intent !== this.#intent) return

    this.#detachVisible()
    this.#visibleId = instance.id
    this.#window.contentView.addChildView(view)
    view.setBounds(safeBounds(bounds, this.#window))
    view.setVisible(true)
  }

  async openConfigurationSettings(instanceId: string): Promise<ModelConfigurationViewResult> {
    const view = this.#views.get(instanceId)
    if (!view) throw new Error('Configuration view is not loaded')
    return view.webContents.executeJavaScript(`new Promise(resolve => {
      const isSettingsDialog = dialog => {
        const text = dialog.textContent || ''
        return (text.includes('通用设置') && text.includes('模型')) || (text.includes('General') && text.includes('Models'))
      }
      if ([...document.querySelectorAll('[role="dialog"]')].some(isSettingsDialog)) { resolve('already-open'); return }
      if (document.querySelector('[role="dialog"]')) { resolve('dialog-blocked'); return }
      const labels = element => [element.getAttribute('aria-label'), element.getAttribute('title'), element.textContent].filter(Boolean).map(value => value.trim())
      const find = names => [...document.querySelectorAll('button,[role="tab"],[role="menuitem"]')].find(element => labels(element).some(label => names.includes(label)))
      let attempts = 0
      const step = () => {
        if ([...document.querySelectorAll('[role="dialog"]')].some(isSettingsDialog)) { resolve('opened'); return }
        find(['设置', 'Settings'])?.click()
        attempts += 1
        if (attempts >= 100) { resolve('unavailable'); return }
        setTimeout(step, 100)
      }
      step()
    })`, true) as Promise<ModelConfigurationViewResult>
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
