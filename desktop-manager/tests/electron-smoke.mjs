import { _electron as electron } from 'playwright-core'
import electronPath from 'electron'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'

const projectRoot = new URL('..', import.meta.url).pathname
const workspaceRoot = new URL('../..', import.meta.url).pathname
const userData = await mkdtemp(join(tmpdir(), 'dsh-manager-electron-'))
const artifacts = join(projectRoot, '.artifacts')
await mkdir(artifacts, { recursive: true })

const executablePath = process.env.DSH_MANAGER_EXECUTABLE || electronPath
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
    const managedUrls = await application.evaluate(({ webContents }) => webContents.getAllWebContents().map(contents => contents.getURL()))
    if (!managedUrls.includes(`http://127.0.0.1:${instancePort}/`)) {
      throw new Error(`Embedded DSH view did not load the managed origin: ${JSON.stringify(managedUrls)}`)
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
