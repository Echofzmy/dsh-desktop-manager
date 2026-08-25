import { randomUUID } from 'node:crypto'
import { _electron as electron } from 'playwright-core'
import electronPath from 'electron'
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'

const projectRoot = new URL('..', import.meta.url).pathname
const workspaceRoot = new URL('../..', import.meta.url).pathname
const userData = await mkdtemp(join(tmpdir(), 'dsh-manager-electron-'))
const canonicalUserData = await realpath(userData)
const canonicalTmp = await realpath(tmpdir())
const relativeUserData = relative(canonicalTmp, canonicalUserData)
if (!relativeUserData || relativeUserData.startsWith('..') || relativeUserData.includes('/') || !basename(canonicalUserData).startsWith('dsh-manager-electron-')) {
  throw new Error(`Refusing to create Electron fixtures outside an isolated temporary root: ${canonicalUserData}`)
}
const sentinel = randomUUID()
const fixtureModelId = `smoke-custom-${sentinel}`
const sentinelPath = join(canonicalUserData, '.electron-smoke-sentinel')
const modelHome = join(canonicalUserData, 'model-configuration', 'home')
await mkdir(modelHome, { recursive: true, mode: 0o700 })
await writeFile(sentinelPath, `${sentinel}\n`, { mode: 0o600, flag: 'wx' })
if ((await readFile(sentinelPath, 'utf8')).trim() !== sentinel) throw new Error('Electron fixture sentinel verification failed')
await writeFile(join(modelHome, '.credentials.yaml'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: electron-fixture-deepseek\n  SUB2API_API_KEY: electron-fixture-sub2api\n', { mode: 0o600, flag: 'wx' })
await writeFile(join(modelHome, 'settings.yaml'), `llm-pi-ai:\n  providers:\n    sub2api:\n      apiKeyEnv: SUB2API_API_KEY\n      api: openai-completions\n      baseURL: https://sub2api.invalid/v1\n      models:\n        - id: ${fixtureModelId}\npermission:\n  defaultPreset: workspace-write\nui-theme:\n  preference: dark\nui-conversation:\n  busyEnter: steer\n`, { mode: 0o600, flag: 'wx' })
const artifacts = join(projectRoot, '.artifacts')
await mkdir(artifacts, { recursive: true })

const executablePath = process.env.DSH_MANAGER_EXECUTABLE || electronPath
async function dshRpc(baseUrl, method, payload) {
  const rpcId = randomUUID()
  const response = await fetch(new URL(`/api/${method}`, baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  })
  const result = await response.json()
  if (!response.ok || result?.rpcId !== rpcId || result?.result?.ok !== true) {
    throw new Error(`DSH RPC ${method} failed: ${JSON.stringify({ status: response.status, result })}`)
  }
  return result.result.value
}

const application = await electron.launch({
  executablePath,
  args: process.env.DSH_MANAGER_EXECUTABLE ? [] : ['.'],
  cwd: projectRoot,
  env: { ...process.env, DSH_MANAGER_USER_DATA: userData },
})

try {
  const page = await application.firstWindow()
  const errors = []
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewportSize({ width: 1440, height: 920 })
  await page.getByRole('heading', { name: '概览' }).waitFor({ timeout: 10_000 })
  await page.evaluate(() => document.fonts.ready)

  const apiReady = await page.evaluate(() => typeof window.manager?.getSnapshot === 'function')
  if (!apiReady) throw new Error('Manager preload API is unavailable')
  const brandIcon = await page.locator('.brand-icon').evaluate(image => ({ complete: image.complete, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight }))
  if (!brandIcon.complete || brandIcon.naturalWidth !== 1024 || brandIcon.naturalHeight !== 1024) throw new Error(`Application brand icon did not load: ${JSON.stringify(brandIcon)}`)

  const secondProcess = spawn(executablePath, process.env.DSH_MANAGER_EXECUTABLE ? [] : ['.'], {
    cwd: projectRoot,
    env: { ...process.env, DSH_MANAGER_USER_DATA: userData },
    stdio: 'ignore',
  })
  const secondExitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      secondProcess.kill('SIGKILL')
      reject(new Error('Second manager process did not yield to the single-instance lock'))
    }, 10_000)
    secondProcess.once('exit', code => {
      clearTimeout(timeout)
      resolve(code)
    })
    secondProcess.once('error', error => {
      clearTimeout(timeout)
      reject(error)
    })
  })
  if (secondExitCode !== 0) throw new Error(`Second manager process exited with code ${String(secondExitCode)}`)
  const overflow = await page.evaluate(() => ({
    horizontal: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    vertical: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  }))
  if (overflow.horizontal > 0 || overflow.vertical > 0) throw new Error(`Application shell overflowed: ${JSON.stringify(overflow)}`)

  await page.getByRole('button', { name: '运行时', exact: true }).click()
  await page.getByRole('button', { name: '注册本地运行时' }).click()
  await page.getByRole('textbox', { name: /运行时目录/u }).fill(join(workspaceRoot, 'dsh-v1'))
  await page.getByRole('button', { name: '注册', exact: true }).click()
  let registered
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = await page.evaluate(() => window.manager.getSnapshot())
    registered = current.runtimes.find(runtime => runtime.source === 'local')
    if (registered) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (!registered || registered.preflight.checks.length === 0) {
    const body = (await page.locator('body').innerText()).slice(0, 1_000)
    throw new Error(`Expected dsh-v1 to remain registered with a preflight report: ${JSON.stringify({ registered, body })}`)
  }

  await page.getByRole('button', { name: '概览', exact: true }).click()
  await page.getByTitle('创建环境').click()
  await page.getByRole('dialog', { name: '创建环境' }).getByRole('button', { name: '创建' }).click()
  await page.getByText('可用', { exact: true }).waitFor()
  const bundledProbe = await page.evaluate(async ({ workspace }) => {
    const snapshot = await window.manager.getSnapshot()
    const runtime = snapshot.runtimes.find(item => item.source === 'bundled')
    if (!runtime) throw new Error('Bundled runtime is missing')
    const environment = await window.manager.createEnvironment({ name: '内置探针环境', kind: 'isolated' })
    let instance = await window.manager.createInstance({ name: '内置运行时探针', runtimeId: runtime.id, environmentId: environment.id, workspacePath: workspace, port: 0 })
    instance = await window.manager.startInstance(instance.id)
    if (instance.status !== 'running') throw new Error(`Bundled runtime did not start: ${JSON.stringify(instance)}`)
    await window.manager.stopInstance(instance.id)
    await window.manager.deleteInstance(instance.id, true)
    return { version: runtime.version, port: instance.port }
  }, { workspace: workspaceRoot })
  if (!bundledProbe.version || !bundledProbe.port) throw new Error(`Bundled runtime probe was incomplete: ${JSON.stringify(bundledProbe)}`)

  await page.getByRole('button', { name: '统一配置', exact: true }).click()
  await page.locator('.web-host').waitFor()
  let modelConfigurationUrl
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const urls = await application.evaluate(({ webContents }) => webContents.getAllWebContents().map(contents => contents.getURL()))
    modelConfigurationUrl = urls.find(url => /^http:\/\/127\.0\.0\.1:\d+\/$/u.test(url))
    if (modelConfigurationUrl) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (!modelConfigurationUrl) throw new Error('Native DSH model configuration host did not load')
  let configurationMode
  for (let attempt = 0; attempt < 100; attempt += 1) {
    configurationMode = await application.evaluate(async ({ webContents }, url) => {
      const contents = webContents.getAllWebContents().find(item => item.getURL() === url)
      if (!contents) throw new Error('Configuration WebContents is missing')
      return contents.executeJavaScript(`(() => {
        const guard = document.getElementById('dsh-manager-configuration-guard')
        const roots = [...document.body.children].filter(element => element !== guard)
        return {
          styleInstalled: Boolean(document.getElementById('dsh-manager-configuration-style')),
          guardInstalled: Boolean(guard),
          applicationRootsHidden: roots.length > 0 && roots.every(element => {
            const style = getComputedStyle(element)
            return style.visibility === 'hidden' && style.pointerEvents === 'none'
          }),
        }
      })()`)
    }, modelConfigurationUrl)
    if (configurationMode.styleInstalled && configurationMode.guardInstalled && configurationMode.applicationRootsHidden) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (!configurationMode?.styleInstalled || !configurationMode.guardInstalled || !configurationMode.applicationRootsHidden) {
    throw new Error(`Embedded DSH is not configuration-only: ${JSON.stringify(configurationMode)}`)
  }
  const initialModelHostSettings = await dshRpc(modelConfigurationUrl, 'settings.describe', {})
  const guardedProvider = initialModelHostSettings.namespaces.find(namespace => namespace.ns === 'llm-pi-ai')?.user?.providers?.sub2api
  if (!guardedProvider?.models?.some(model => model.id === fixtureModelId)) {
    throw new Error(`Refusing to interact with a model Host outside the sentinel fixture: ${JSON.stringify(initialModelHostSettings.namespaces.map(namespace => ({ ns: namespace.ns, user: namespace.user })) )}`)
  }
  const modelHostBounds = await page.locator('.web-host').evaluate(element => {
    const rect = element.getBoundingClientRect()
    return { width: rect.width, height: rect.height }
  })
  if (modelHostBounds.width < 100 || modelHostBounds.height < 100) throw new Error(`Model configuration host collapsed: ${JSON.stringify(modelHostBounds)}`)
  const credentialOverlayPath = join(userData, 'model-configuration', 'credentials.cordis.yml')
  const credentialOverlay = await readFile(credentialOverlayPath, 'utf8')
  if (!credentialOverlay.includes('.credentials.yaml') || credentialOverlay.includes('API_KEY')) throw new Error('Credential overlay contains the wrong data')
  if (process.platform !== 'win32' && ((await stat(credentialOverlayPath)).mode & 0o077) !== 0) throw new Error('Credential overlay is not owner-only')
  await application.evaluate(async ({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL() === url)
    if (!contents) throw new Error('Model configuration WebContents is missing')
    return contents.executeJavaScript(`(() => {
      const button = [...document.querySelectorAll('button')].find(item => ['继续', 'Continue'].includes(item.textContent?.trim()))
      if (button) button.click()
      return Boolean(button)
    })()`)
  }, modelConfigurationUrl)
  const sharedCredentialPath = join(userData, 'model-configuration', 'home', '.credentials.yaml')
  if (process.platform !== 'win32' && ((await stat(sharedCredentialPath)).mode & 0o077) !== 0) throw new Error('Shared DSH credential file is not owner-only')
  await page.waitForTimeout(500)
  await page.getByTitle('打开统一设置').click()
  let nativeSettingsText = ''
  for (let attempt = 0; attempt < 100; attempt += 1) {
    nativeSettingsText = await application.evaluate(async ({ webContents }, url) => {
      const contents = webContents.getAllWebContents().find(item => item.getURL() === url)
      return contents ? contents.executeJavaScript('document.body.innerText') : ''
    }, modelConfigurationUrl)
    if (nativeSettingsText.includes('通用设置') && nativeSettingsText.includes('权限')) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (!nativeSettingsText.includes('通用设置') || !nativeSettingsText.includes('权限')) {
    throw new Error('Manager did not open native DSH General settings with permission defaults')
  }
  const permissionMenuPoint = await application.evaluate(async ({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL() === url)
    if (!contents) throw new Error('Configuration WebContents is missing')
    return contents.executeJavaScript(`(() => {
      const button = [...document.querySelectorAll('button[aria-haspopup="menu"]')].find(element => {
        const rowText = element.parentElement?.parentElement?.textContent || ''
        return rowText.includes('权限') || rowText.includes('Permission')
      })
      const rect = button?.getBoundingClientRect()
      return rect ? { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) } : null
    })()`)
  }, modelConfigurationUrl)
  if (!permissionMenuPoint) throw new Error('Permission preset menu control is missing')
  await application.evaluate(({ webContents }, { url, point }) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL() === url)
    if (!contents) throw new Error('Configuration WebContents is missing')
    contents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  }, { url: modelConfigurationUrl, point: permissionMenuPoint })
  await new Promise(resolve => setTimeout(resolve, 100))
  const permissionMenuVisible = await application.evaluate(async ({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL() === url)
    if (!contents) throw new Error('Configuration WebContents is missing')
    return contents.executeJavaScript(`(() => {
      const menu = document.querySelector('[role="menu"]')
      return Boolean(menu?.hasAttribute('data-dsh-manager-configuration-visible') && getComputedStyle(menu).visibility === 'visible' && getComputedStyle(menu).pointerEvents !== 'none')
    })()`)
  }, modelConfigurationUrl)
  if (!permissionMenuVisible) throw new Error('Portaled Permission preset menu is hidden in unified Settings')
  await application.evaluate(({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL() === url)
    if (!contents) throw new Error('Configuration WebContents is missing')
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' })
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' })
  }, modelConfigurationUrl)
  await new Promise(resolve => setTimeout(resolve, 100))
  const menuEscapeResult = await application.evaluate(async ({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL() === url)
    if (!contents) throw new Error('Configuration WebContents is missing')
    return contents.executeJavaScript(`({
      menuClosed: !document.querySelector('[role="menu"]'),
      settingsOpen: [...document.querySelectorAll('[role="dialog"]')].some(dialog => dialog.hasAttribute('data-dsh-manager-configuration-visible') && ((dialog.textContent || '').includes('通用设置') || (dialog.textContent || '').includes('General'))),
    })`)
  }, modelConfigurationUrl)
  if (!menuEscapeResult.menuClosed || !menuEscapeResult.settingsOpen) throw new Error(`Permission menu Escape closed unified Settings: ${JSON.stringify(menuEscapeResult)}`)
  await application.evaluate(async ({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL() === url)
    if (!contents) throw new Error('Configuration WebContents is missing')
    return contents.executeJavaScript(`(() => {
      const labels = element => [element.getAttribute('aria-label'), element.getAttribute('title'), element.textContent].filter(Boolean).map(value => value.trim())
      const models = [...document.querySelectorAll('button,[role="tab"],[role="menuitem"]')].find(element => labels(element).some(label => ['模型', 'Models'].includes(label)))
      models?.click()
      return Boolean(models)
    })()`)
  }, modelConfigurationUrl)
  let nativeModelsText = ''
  for (let attempt = 0; attempt < 100; attempt += 1) {
    nativeModelsText = await application.evaluate(async ({ webContents }, url) => {
      const contents = webContents.getAllWebContents().find(item => item.getURL() === url)
      return contents ? contents.executeJavaScript('document.body.innerText') : ''
    }, modelConfigurationUrl)
    if (nativeModelsText.includes('添加自定义提供方')) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (!nativeModelsText.includes('添加自定义提供方')) throw new Error('Manager did not open the native DSH Models section')
  const settingsControls = await application.evaluate(async ({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL() === url)
    if (!contents) throw new Error('Configuration WebContents is missing')
    return contents.executeJavaScript(`(() => {
      const settingsDialog = [...document.querySelectorAll('[role="dialog"]')].find(dialog => (dialog.textContent || '').includes('添加自定义提供方'))
      const close = settingsDialog ? [...settingsDialog.querySelectorAll('button')].find(button => ['关闭', '关闭设置', 'Close', 'Close settings'].includes(button.getAttribute('aria-label') || button.getAttribute('title') || button.textContent?.trim())) : null
      const rect = close?.getBoundingClientRect()
      return rect ? { close: { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }, mask: { x: 2, y: 2 } } : null
    })()`)
  }, modelConfigurationUrl)
  if (!settingsControls) throw new Error('Native Settings close control is missing')
  await application.evaluate(({ webContents }, { url, controls }) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL() === url)
    if (!contents) throw new Error('Configuration WebContents is missing')
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' })
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' })
    for (const point of [controls.close, controls.mask]) {
      contents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 })
      contents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    }
  }, { url: modelConfigurationUrl, controls: settingsControls })
  await new Promise(resolve => setTimeout(resolve, 100))
  const settingsLock = await application.evaluate(async ({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL() === url)
    if (!contents) throw new Error('Configuration WebContents is missing')
    return contents.executeJavaScript(`(() => {
      const stillOpen = [...document.querySelectorAll('[role="dialog"]')].some(dialog => (dialog.textContent || '').includes('添加自定义提供方'))
      const guard = document.getElementById('dsh-manager-configuration-guard')
      const roots = [...document.body.children].filter(element => element !== guard)
      return { stillOpen, applicationRootsDisabled: roots.every(element => getComputedStyle(element).pointerEvents === 'none') }
    })()`)
  }, modelConfigurationUrl)
  if (!settingsLock.stillOpen || !settingsLock.applicationRootsDisabled) {
    throw new Error(`Unified Settings can escape to embedded conversation UI: ${JSON.stringify(settingsLock)}`)
  }
  await application.evaluate(({ webContents }, url) => new Promise((resolve, reject) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL() === url)
    if (!contents) { reject(new Error('Configuration WebContents is missing')); return }
    contents.once('did-finish-load', () => resolve(undefined))
    contents.reload()
  }), modelConfigurationUrl)
  let reloadGuard
  for (let attempt = 0; attempt < 100; attempt += 1) {
    reloadGuard = await application.evaluate(async ({ webContents }, url) => {
      const contents = webContents.getAllWebContents().find(item => item.getURL() === url)
      if (!contents) throw new Error('Configuration WebContents is missing')
      return contents.executeJavaScript(`(() => {
        const guard = document.getElementById('dsh-manager-configuration-guard')
        const roots = [...document.body.children].filter(element => element !== guard)
        const settingsOpen = [...document.querySelectorAll('[role="dialog"]')].some(dialog => dialog.hasAttribute('data-dsh-manager-configuration-visible') && ((dialog.textContent || '').includes('通用设置') || (dialog.textContent || '').includes('General')))
        return { styleInstalled: Boolean(document.getElementById('dsh-manager-configuration-style')), settingsOpen, applicationRootsDisabled: roots.length > 0 && roots.every(element => getComputedStyle(element).pointerEvents === 'none') }
      })()`)
    }, modelConfigurationUrl)
    if (reloadGuard.styleInstalled && reloadGuard.settingsOpen && reloadGuard.applicationRootsDisabled) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (!reloadGuard?.styleInstalled || !reloadGuard.settingsOpen || !reloadGuard.applicationRootsDisabled) {
    throw new Error(`Configuration-only mode did not survive reload: ${JSON.stringify(reloadGuard)}`)
  }
  const nestedVisible = await application.evaluate(async ({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL() === url)
    if (!contents) throw new Error('Configuration WebContents is missing')
    return contents.executeJavaScript(`new Promise(resolve => {
      const root = document.createElement('div')
      root.setAttribute('role', 'presentation')
      const nested = document.createElement('div')
      nested.setAttribute('role', 'dialog')
      nested.setAttribute('aria-label', 'Choose models to add')
      nested.id = 'dsh-manager-nested-dialog-smoke'
      const cancel = document.createElement('button')
      cancel.textContent = 'Cancel'
      cancel.addEventListener('click', () => root.remove())
      nested.appendChild(cancel)
      root.appendChild(nested)
      document.body.appendChild(root)
      setTimeout(() => resolve(nested.hasAttribute('data-dsh-manager-configuration-visible') && getComputedStyle(nested).visibility === 'visible'), 50)
    })`)
  }, modelConfigurationUrl)
  if (!nestedVisible) throw new Error('Approved nested Settings dialog was not exposed')
  await application.evaluate(({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL() === url)
    if (!contents) throw new Error('Configuration WebContents is missing')
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' })
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' })
  }, modelConfigurationUrl)
  await new Promise(resolve => setTimeout(resolve, 100))
  const nestedEscapeResult = await application.evaluate(async ({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL() === url)
    if (!contents) throw new Error('Configuration WebContents is missing')
    return contents.executeJavaScript(`({
      nestedClosed: !document.getElementById('dsh-manager-nested-dialog-smoke'),
      settingsOpen: [...document.querySelectorAll('[role="dialog"]')].some(dialog => dialog.hasAttribute('data-dsh-manager-configuration-visible') && ((dialog.textContent || '').includes('通用设置') || (dialog.textContent || '').includes('General'))),
    })`)
  }, modelConfigurationUrl)
  if (!nestedEscapeResult.nestedClosed || !nestedEscapeResult.settingsOpen) {
    throw new Error(`Nested Escape closed unified Settings: ${JSON.stringify(nestedEscapeResult)}`)
  }
  const generalNavigationPoint = await application.evaluate(async ({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL() === url)
    if (!contents) throw new Error('Configuration WebContents is missing')
    return contents.executeJavaScript(`(() => {
      const labels = element => [element.getAttribute('aria-label'), element.getAttribute('title'), element.textContent].filter(Boolean).map(value => value.trim())
      const general = [...document.querySelectorAll('button,[role="tab"],[role="menuitem"]')].find(element => labels(element).some(label => ['通用设置', 'General'].includes(label)))
      const rect = general?.getBoundingClientRect()
      return rect ? { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) } : null
    })()`)
  }, modelConfigurationUrl)
  if (!generalNavigationPoint) throw new Error('General Settings navigation control is missing')
  await application.evaluate(({ webContents }, { url, point }) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL() === url)
    if (!contents) throw new Error('Configuration WebContents is missing')
    contents.sendInputEvent({ type: 'mouseDown', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    contents.sendInputEvent({ type: 'mouseUp', x: point.x, y: point.y, button: 'left', clickCount: 1 })
  }, { url: modelConfigurationUrl, point: generalNavigationPoint })
  await application.evaluate(({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL() === url)
    if (!contents) throw new Error('Configuration WebContents is missing')
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'TAB' })
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'TAB' })
  }, modelConfigurationUrl)
  const unrelatedDialogHidden = await application.evaluate(async ({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL() === url)
    if (!contents) throw new Error('Configuration WebContents is missing')
    return contents.executeJavaScript(`new Promise(resolve => {
      const root = document.createElement('div')
      root.setAttribute('role', 'presentation')
      const unrelated = document.createElement('div')
      unrelated.setAttribute('role', 'dialog')
      unrelated.setAttribute('aria-label', 'Unrelated dialog')
      unrelated.textContent = 'UNRELATED_DIALOG_SENTINEL'
      root.appendChild(unrelated)
      document.body.appendChild(root)
      setTimeout(() => {
        const style = getComputedStyle(unrelated)
        const result = !unrelated.hasAttribute('data-dsh-manager-configuration-visible') && style.visibility === 'hidden' && style.pointerEvents === 'none'
        root.remove()
        resolve(result)
      }, 50)
    })`)
  }, modelConfigurationUrl)
  if (!unrelatedDialogHidden) throw new Error('Configuration-only mode exposed an unrelated DSH dialog')
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.webContents.send('manager:menu:command', 'home'))
  await page.getByRole('heading', { name: '概览' }).waitFor()
  await page.waitForTimeout(200)
  const attachedViews = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.contentView.children.length ?? -1)
  if (attachedViews !== 0) throw new Error(`Model WebContentsView remained attached after menu navigation: ${attachedViews}`)
  let modelHostClosed = false
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fetch(modelConfigurationUrl, { signal: AbortSignal.timeout(250) })
    } catch {
      modelHostClosed = true
      break
    }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  if (!modelHostClosed) throw new Error('Model configuration host remained alive after leaving Models')

  await page.screenshot({ path: join(artifacts, 'home-1440x920.png'), fullPage: true })
  await page.setViewportSize({ width: 1000, height: 700 })
  const compactOverflow = await page.evaluate(() => ({
    horizontal: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    vertical: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  }))
  if (compactOverflow.horizontal > 0 || compactOverflow.vertical > 0) {
    throw new Error(`Compact application shell overflowed: ${JSON.stringify(compactOverflow)}`)
  }
  await page.screenshot({ path: join(artifacts, 'home-1000x700.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 920 })

  let instancePort
  if (registered.preflight.ready) {
    await page.getByRole('button', { name: '新建实例' }).first().click()
    const instanceDialog = page.getByRole('dialog', { name: '新建实例' })
    if (await instanceDialog.getByLabel('工作区').count()) throw new Error('New instance dialog still exposes a workspace choice')
    if (await instanceDialog.getByLabel('端口').count()) throw new Error('New instance dialog still exposes a port choice')
    await instanceDialog.getByLabel('运行时').selectOption(registered.id)
    await instanceDialog.getByRole('button', { name: '创建' }).click()
    let instance
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = await page.evaluate(() => window.manager.getSnapshot())
      instance = current.instances[0]
      if (instance) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (!instance) throw new Error('Instance was not persisted through the manager API')
    await page.getByRole('button', { name: '启动', exact: true }).click()
    for (let attempt = 0; attempt < 900; attempt += 1) {
      const current = await page.evaluate(() => window.manager.getSnapshot())
      instance = current.instances[0]
      if (instance?.status === 'running' || instance?.status === 'failed') break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    if (instance?.status !== 'running') {
      const currentLog = instance ? await page.evaluate(id => window.manager.readInstanceLog(id), instance.id) : undefined
      throw new Error(`Instance did not become ready: ${JSON.stringify({ instance, currentLog })}`)
    }
    instancePort = instance.port
    if (!Number.isInteger(instancePort) || instancePort <= 0 || instancePort === 3080) {
      throw new Error(`Automatic instance port is invalid: ${String(instancePort)}`)
    }
    await page.getByText('开发实例', { exact: true }).first().click()
    await page.waitForTimeout(1_000)
    const webHostBounds = await page.locator('.web-host').evaluate(element => {
      const rect = element.getBoundingClientRect()
      return { width: rect.width, height: rect.height }
    })
    if (webHostBounds.width < 100 || webHostBounds.height < 100) {
      throw new Error(`Embedded DSH host collapsed: ${JSON.stringify(webHostBounds)}`)
    }
    const managedUrls = await application.evaluate(({ webContents }) => webContents.getAllWebContents().map(contents => contents.getURL()))
    if (!managedUrls.includes(`http://127.0.0.1:${instancePort}/`)) {
      throw new Error(`Embedded DSH view did not load the managed origin: ${JSON.stringify(managedUrls)}`)
    }
    const dshBody = await application.evaluate(async ({ webContents }, url) => {
      const contents = webContents.getAllWebContents().find(item => item.getURL() === url)
      if (!contents) throw new Error('Managed DSH WebContents is missing')
      return contents.executeJavaScript('document.body.innerText')
    }, `http://127.0.0.1:${instancePort}/`)
    if (!dshBody.includes('选择工作区')) throw new Error('Managed DSH did not reach workspace selection')
    if (dshBody.includes('添加一个 API Key')) throw new Error('Managed DSH still displayed API-key onboarding')
    const targetUrl = `http://127.0.0.1:${instancePort}/`
    const catalog = await dshRpc(targetUrl, 'llm.models', {})
    const customGroup = catalog.groups.find(group => group.id === 'sub2api')
    if (!customGroup?.models.some(model => model.id === fixtureModelId)) throw new Error(`Projected custom model is missing from the managed DSH catalog: ${JSON.stringify(catalog)}`)
    if (!catalog.groups.some(group => group.id === 'deepseek-official')) throw new Error('DeepSeek official is missing from the managed DSH catalog')
    const credentials = await dshRpc(targetUrl, 'credentials.describe', { refs: ['DEEPSEEK_API_KEY', 'SUB2API_API_KEY'] })
    for (const ref of ['DEEPSEEK_API_KEY', 'SUB2API_API_KEY']) {
      const view = credentials.credentials[ref]
      if (!view?.configured || view.source === 'env') throw new Error(`Managed credential ${ref} did not resolve from shared native storage: ${JSON.stringify(view)}`)
    }
    const settings = await dshRpc(targetUrl, 'settings.describe', {})
    const defaultModel = settings.namespaces.find(namespace => namespace.ns === 'agent-default-model')?.value
    if (defaultModel?.provider !== 'deepseek-official') throw new Error(`Managed DSH default is not DeepSeek official: ${JSON.stringify(defaultModel)}`)
    const permission = settings.namespaces.find(namespace => namespace.ns === 'permission')?.value
    const theme = settings.namespaces.find(namespace => namespace.ns === 'ui-theme')?.value
    const conversation = settings.namespaces.find(namespace => namespace.ns === 'ui-conversation')?.value
    if (permission?.defaultPreset !== 'workspace-write' || theme?.preference !== 'dark' || conversation?.busyEnter !== 'steer') {
      throw new Error(`Managed DSH did not inherit unified startup settings: ${JSON.stringify({ permission, theme, conversation })}`)
    }

    await page.evaluate(id => window.manager.stopInstance(id), instance.id)
    const blockedPort = instancePort
    const blocker = createServer()
    const blockerSockets = new Set()
    blocker.on('connection', socket => {
      blockerSockets.add(socket)
      socket.once('close', () => blockerSockets.delete(socket))
    })
    await new Promise((resolve, reject) => {
      blocker.once('error', reject)
      blocker.listen(blockedPort, '127.0.0.1', resolve)
    })
    try {
      instance = await page.evaluate(id => window.manager.startInstance(id), instance.id)
    } finally {
      for (const socket of blockerSockets) socket.destroy()
      await new Promise(resolve => blocker.close(resolve))
    }
    if (instance.status !== 'running' || instance.port === blockedPort) {
      throw new Error(`Automatic relaunch did not select a new port: ${JSON.stringify(instance)}`)
    }
    instancePort = instance.port
    await page.waitForTimeout(1_000)
    const relaunchedUrls = await application.evaluate(({ webContents }) => webContents.getAllWebContents().map(contents => contents.getURL()))
    if (!relaunchedUrls.includes(`http://127.0.0.1:${instancePort}/`)) {
      throw new Error(`Embedded view retained its previous allowed origin: ${JSON.stringify(relaunchedUrls)}`)
    }

    const beforeClone = await page.evaluate(() => window.manager.getSnapshot())
    const sourceEnvironment = beforeClone.environments[0]
    const sourceRuntime = beforeClone.runtimes[0]
    if (!sourceEnvironment || !sourceRuntime) throw new Error('Clone smoke is missing its source environment or runtime')
    const cloned = await page.evaluate(input => window.manager.cloneEnvironment(input), {
      name: '历史副本',
      sourceEnvironmentId: sourceEnvironment.id,
      sourceInstanceId: instance.id,
      targetRuntimeId: sourceRuntime.id,
    })
    const afterClone = await page.evaluate(() => window.manager.getSnapshot())
    instance = afterClone.instances.find(candidate => candidate.id === instance.id)
    if (!instance || instance.status !== 'running' || cloned.lineage?.sourceEnvironmentId !== sourceEnvironment.id || cloned.path === sourceEnvironment.path) {
      throw new Error(`Running environment clone did not stop, copy, and restore correctly: ${JSON.stringify({ instance, cloned })}`)
    }
    instancePort = instance.port
    await page.waitForTimeout(1_000)
    const attachedBeforeDialog = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.contentView.children.length ?? -1)
    await page.getByRole('button', { name: '新建实例' }).first().click()
    await page.getByRole('dialog', { name: '新建实例' }).waitFor()
    await page.waitForTimeout(200)
    const attachedDuringDialog = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.contentView.children.length ?? -1)
    if (attachedBeforeDialog < 1 || attachedDuringDialog !== 0) {
      throw new Error(`Native DSH view covered a manager dialog: ${JSON.stringify({ attachedBeforeDialog, attachedDuringDialog })}`)
    }
    await page.getByRole('dialog', { name: '新建实例' }).getByRole('button', { name: '关闭' }).click()
    await page.waitForTimeout(500)
    const attachedAfterDialog = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.contentView.children.length ?? -1)
    if (attachedAfterDialog < 1) throw new Error('Native DSH view was not restored after closing the manager dialog')
    await page.screenshot({ path: join(artifacts, 'instance-1440x920.png'), fullPage: true })
  }

  if (errors.length) throw new Error(`Renderer errors:\n${errors.join('\n')}`)
  console.log(JSON.stringify({ screenshot: join(artifacts, 'home-1440x920.png'), compactScreenshot: join(artifacts, 'home-1000x700.png'), instanceScreenshot: instancePort ? join(artifacts, 'instance-1440x920.png') : undefined, instancePort, overflow, compactOverflow, apiReady }))
} finally {
  await application.close()
  await rm(userData, { recursive: true, force: true })
}
