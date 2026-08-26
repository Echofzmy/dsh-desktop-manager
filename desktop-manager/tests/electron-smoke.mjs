import { randomUUID } from 'node:crypto'
import { _electron as electron } from 'playwright-core'
import electronPath from 'electron'
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer as createHttpServer } from 'node:http'
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
const discoveredModelId = `smoke-discovered-${sentinel}`
let discoveryAuthorization
const discoveryServer = createHttpServer((request, response) => {
  discoveryAuthorization = request.headers.authorization
  if (request.url !== '/v1/models') { response.writeHead(404).end(); return }
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({ data: [{ id: fixtureModelId }, { id: discoveredModelId, name: 'Discovered Smoke Model', context_window: 96000, max_output_tokens: 6000 }] }))
})
await new Promise((resolve, reject) => discoveryServer.listen(0, '127.0.0.1', resolve).once('error', reject))
const discoveryBaseURL = `http://127.0.0.1:${discoveryServer.address().port}/v1`
const sentinelPath = join(canonicalUserData, '.electron-smoke-sentinel')
const modelHome = join(canonicalUserData, 'model-configuration', 'home')
await mkdir(modelHome, { recursive: true, mode: 0o700 })
await writeFile(sentinelPath, `${sentinel}\n`, { mode: 0o600, flag: 'wx' })
if ((await readFile(sentinelPath, 'utf8')).trim() !== sentinel) throw new Error('Electron fixture sentinel verification failed')
await writeFile(join(modelHome, '.credentials.yaml'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: electron-fixture-deepseek\n  SUB2API_API_KEY: electron-fixture-sub2api\n', { mode: 0o600, flag: 'wx' })
await writeFile(join(modelHome, 'settings.yaml'), `llm-pi-ai:\n  providers:\n    sub2api:\n      apiKeyEnv: SUB2API_API_KEY\n      api: openai-completions\n      baseURL: ${discoveryBaseURL}\n      models:\n        - id: ${fixtureModelId}\npermission:\n  defaultPreset: workspace-write\nui-theme:\n  preference: dark\nui-conversation:\n  busyEnter: steer\n`, { mode: 0o600, flag: 'wx' })
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
  await page.locator('.configuration-page').waitFor()
  if (await page.locator('.web-host').count()) throw new Error('Unified configuration still renders an embedded DSH Host')
  const configurationContents = await application.evaluate(({ webContents }) => webContents.getAllWebContents().map(contents => contents.getURL()))
  if (configurationContents.some(url => /^http:\/\/127\.0\.0\.1:\d+\/$/u.test(url))) {
    throw new Error(`Unified configuration started a DSH Web Host: ${JSON.stringify(configurationContents)}`)
  }
  const configurationViews = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.contentView.children.length ?? -1)
  if (configurationViews !== 0) throw new Error(`Unified configuration attached a WebContentsView: ${configurationViews}`)
  const initialConfiguration = await page.evaluate(() => window.manager.getUnifiedConfiguration())
  const initialProvider = initialConfiguration.providers.find(provider => provider.id === 'sub2api')
  if (!initialProvider?.hasApiKey || !initialProvider.models.some(model => model.id === fixtureModelId)) {
    throw new Error(`Native configuration did not read the isolated fixture: ${JSON.stringify(initialConfiguration)}`)
  }
  if (JSON.stringify(initialConfiguration).includes('electron-fixture')) throw new Error('Native configuration returned credential plaintext')

  await page.locator('.configuration-row').filter({ hasText: '默认权限' }).locator('select').selectOption('read-only')
  await page.locator('.configuration-row').filter({ hasText: '忙碌时按 Enter' }).locator('select').selectOption('queue')
  await page.getByLabel('默认 Agent preset').fill('minimal')
  await page.getByLabel('默认模型').selectOption({ label: 'DeepSeek / DeepSeek-V4-Flash' })
  await page.getByLabel('默认思考深度').selectOption('high')
  await page.locator('.configuration-nav').getByRole('button', { name: '模型', exact: true }).click()
  const providerCard = page.locator('.provider-profile').filter({ hasText: 'sub2api' })
  await providerCard.locator('.provider-summary').click()
  await providerCard.getByLabel('显示名称').fill('Smoke Gateway')
  await providerCard.getByLabel('请求超时（分钟）').fill('15')
  await providerCard.getByLabel('流空闲超时（分钟）').fill('10')
  await providerCard.getByLabel('API Key').fill(`rotated-${sentinel}`)
  await providerCard.getByRole('button', { name: '发现可用模型' }).click()
  const discoveryDialog = page.getByRole('dialog', { name: '发现可用模型' })
  await discoveryDialog.waitFor()
  const existingCandidate = discoveryDialog.locator('li').filter({ hasText: fixtureModelId })
  const newCandidate = discoveryDialog.locator('li').filter({ hasText: discoveredModelId })
  if (!await existingCandidate.getByRole('checkbox').isDisabled()) throw new Error('Already configured discovery candidate was selectable')
  if (!await newCandidate.getByRole('checkbox').isChecked()) throw new Error('New discovery candidate was not selected by default')
  await discoveryDialog.getByRole('button', { name: '添加所选模型' }).click()
  if (discoveryAuthorization !== `Bearer rotated-${sentinel}`) throw new Error('Discovery did not use the one-shot typed API key')
  await page.getByRole('button', { name: '保存更改' }).click()
  let savedConfiguration
  for (let attempt = 0; attempt < 100; attempt += 1) {
    savedConfiguration = await page.evaluate(() => window.manager.getUnifiedConfiguration())
    const provider = savedConfiguration.providers.find(candidate => candidate.id === 'sub2api')
    if (provider?.displayName === 'Smoke Gateway' && provider.hasApiKey && provider.models.some(model => model.id === discoveredModelId) && provider.timeoutMs === 900000 && provider.streamIdleTimeoutMs === 600000 && savedConfiguration.defaultReasoningEffort === 'high') break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const savedProvider = savedConfiguration.providers.find(provider => provider.id === 'sub2api')
  if (savedProvider?.displayName !== 'Smoke Gateway' || !savedProvider.hasApiKey || !savedProvider.models.some(model => model.id === discoveredModelId) || savedProvider.timeoutMs !== 900000 || savedProvider.streamIdleTimeoutMs !== 600000 || savedConfiguration.defaultReasoningEffort !== 'high' || savedConfiguration.defaultPermission !== 'read-only' || savedConfiguration.busyEnter !== 'queue' || savedConfiguration.defaultAgentPreset !== 'minimal') {
    throw new Error(`Native configuration controls did not persist: ${JSON.stringify(savedConfiguration)}`)
  }
  if (JSON.stringify(savedConfiguration).includes(`rotated-${sentinel}`)) throw new Error('Saved configuration returned credential plaintext')
  const sharedCredentialPath = join(userData, 'model-configuration', 'home', '.credentials.yaml')
  const sharedCredential = await readFile(sharedCredentialPath, 'utf8')
  if (!sharedCredential.includes(`rotated-${sentinel}`)) throw new Error('Native API Key field did not update the isolated credential file')
  if (process.platform !== 'win32' && ((await stat(sharedCredentialPath)).mode & 0o077) !== 0) throw new Error('Shared credential file is not owner-only')
  const credentialOverlayPath = join(userData, 'model-configuration', 'credentials.cordis.yml')
  const credentialOverlay = await readFile(credentialOverlayPath, 'utf8')
  if (!credentialOverlay.includes('.credentials.yaml') || credentialOverlay.includes('API_KEY')) throw new Error('Credential overlay contains the wrong data')
  if (process.platform !== 'win32' && ((await stat(credentialOverlayPath)).mode & 0o077) !== 0) throw new Error('Credential overlay is not owner-only')
  await page.screenshot({ path: join(artifacts, 'configuration-1440x920.png'), fullPage: true })
  await page.setViewportSize({ width: 1000, height: 700 })
  const configurationOverflow = await page.evaluate(() => ({
    horizontal: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    vertical: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  }))
  if (configurationOverflow.horizontal > 0 || configurationOverflow.vertical > 0) throw new Error(`Compact configuration page overflowed: ${JSON.stringify(configurationOverflow)}`)
  await page.screenshot({ path: join(artifacts, 'configuration-1000x700.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 920 })

  await providerCard.getByLabel('显示名称').fill('Unsaved Gateway')
  await page.getByRole('button', { name: '概览', exact: true }).click()
  const discardDialog = page.getByRole('dialog', { name: '放弃未保存的更改？' })
  await discardDialog.waitFor()
  await discardDialog.getByRole('button', { name: '取消' }).click()
  if (await providerCard.getByLabel('显示名称').inputValue() !== 'Unsaved Gateway') throw new Error('Canceling navigation discarded the provider draft')
  await providerCard.getByLabel('显示名称').fill('Smoke Gateway')
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent?.includes('保存更改') && button.hasAttribute('disabled')))
  await page.getByRole('button', { name: '概览', exact: true }).click()

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
    if (defaultModel?.provider !== 'deepseek-official' || defaultModel?.reasoningEffort !== 'high') throw new Error(`Managed DSH default model or reasoning is wrong: ${JSON.stringify(defaultModel)}`)
    const piSettings = settings.namespaces.find(namespace => namespace.ns === 'llm-pi-ai')?.value
    const projectedProvider = piSettings?.providers?.sub2api
    if (projectedProvider?.timeoutMs !== 900000 || projectedProvider?.streamIdleTimeoutMs !== 600000 || !projectedProvider?.models?.some(model => model.id === discoveredModelId)) throw new Error(`Managed DSH provider discovery projection is wrong: ${JSON.stringify(projectedProvider)}`)
    const permission = settings.namespaces.find(namespace => namespace.ns === 'permission')?.value
    const theme = settings.namespaces.find(namespace => namespace.ns === 'ui-theme')?.value
    const conversation = settings.namespaces.find(namespace => namespace.ns === 'ui-conversation')?.value
    if (permission?.defaultPreset !== 'read-only' || theme?.preference !== 'dark' || conversation?.busyEnter !== 'queue') {
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
  await new Promise((resolve, reject) => discoveryServer.close(error => error ? reject(error) : resolve()))
  await rm(userData, { recursive: true, force: true })
}
