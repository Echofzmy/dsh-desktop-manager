import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { embeddedNodeLaunch, isolatedInstallerEnvironment } from '../embedded-node.js'
import { preflightRuntime } from '../runtime-preflight.js'
import { verifyRuntimeManifest, writeRuntimeManifest } from './integrity.js'
import { OFFICIAL_REGISTRY_ORIGIN, resolveOfficialVersion } from './registry-client.js'
import type { RuntimeRecord } from '../../shared/types.js'

export interface InstallProgress {
  phase: string
  detail: string
}

interface InstallReceipt {
  schema: 1
  package: '@deepseek-ai/dsh'
  version: string
  source: 'npm'
  registry: string
  rootIntegrity: string
  manifestDigest: string
  files: number
  nodeVersion: string
  platform: NodeJS.Platform
  arch: string
  installedAt: string
}

export class OfficialRuntimeInstaller {
  readonly #root: string
  readonly #children = new Map<string, ChildProcess>()
  readonly #controllers = new Map<string, AbortController>()
  readonly #operations = new Map<string, Promise<RuntimeRecord>>()
  readonly #singleFlight = new Map<string, Promise<RuntimeRecord>>()

  constructor(dataRoot: string) {
    this.#root = join(dataRoot, 'runtimes', 'official', 'downloaded')
  }

  install(operationId: string, version: string, onProgress: (progress: InstallProgress) => Promise<void>): Promise<RuntimeRecord> {
    const existing = this.#singleFlight.get(version)
    if (existing) return existing
    const controller = new AbortController()
    this.#controllers.set(operationId, controller)
    const operation = this.#install(operationId, version, onProgress, controller.signal)
    this.#operations.set(operationId, operation)
    this.#singleFlight.set(version, operation)
    void operation.finally(() => {
      this.#singleFlight.delete(version)
      this.#controllers.delete(operationId)
      this.#operations.delete(operationId)
    }).catch(() => undefined)
    return operation
  }

  async cancel(operationId: string): Promise<void> {
    this.#controllers.get(operationId)?.abort()
    const child = this.#children.get(operationId)
    if (child?.pid) {
      try {
        if (process.platform === 'win32') child.kill('SIGTERM')
        else process.kill(-child.pid, 'SIGTERM')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    await this.#operations.get(operationId)?.catch(() => undefined)
  }

  async cancelAll(): Promise<void> {
    await Promise.allSettled([...this.#operations.keys()].map(id => this.cancel(id)))
  }

  async #install(operationId: string, version: string, onProgress: (progress: InstallProgress) => Promise<void>, signal: AbortSignal): Promise<RuntimeRecord> {
    await mkdir(this.#root, { recursive: true, mode: 0o700 })
    const finalRoot = join(this.#root, version)
    signal.throwIfAborted()
    const metadata = await resolveOfficialVersion(version, signal)
    signal.throwIfAborted()
    try {
      const receipt = await this.#validateInstalledRoot(finalRoot, version, metadata.integrity, signal)
      return this.#record(finalRoot, receipt)
    } catch {
      // A fully verified matching runtime is the only idempotent success case.
    }

    const staging = join(this.#root, '.staging', `${version}-${randomUUID()}`)
    const home = join(staging, '.installer-home')
    const cache = join(staging, '.npm-cache')
    const userConfig = join(home, '.npmrc')
    const logPath = join(staging, 'install.log')
    await mkdir(home, { recursive: true, mode: 0o700 })
    await mkdir(cache, { recursive: true, mode: 0o700 })
    await writeFile(userConfig, `registry=${OFFICIAL_REGISTRY_ORIGIN}\naudit=false\nfund=false\n`, { mode: 0o600 })
    await writeFile(join(staging, 'package.json'), `${JSON.stringify({ private: true, name: 'dsh-official-runtime', version: '1.0.0' }, null, 2)}\n`, { mode: 0o600 })

    try {
      await onProgress({ phase: 'installing', detail: `正在安装 @deepseek-ai/dsh@${version} 的完整依赖` })
      await this.#runNpm(operationId, staging, home, cache, userConfig, logPath, version)
      signal.throwIfAborted()
      await onProgress({ phase: 'verifying', detail: '正在核对包版本、lockfile integrity 与运行入口' })
      const packageRoot = join(staging, 'node_modules', '@deepseek-ai', 'dsh')
      const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown; bin?: { dsh?: unknown } }
      if (manifest.name !== '@deepseek-ai/dsh' || manifest.version !== version || typeof manifest.bin?.dsh !== 'string') throw new Error('安装后的官方 DSH 包身份无效')
      const lock = JSON.parse(await readFile(join(staging, 'package-lock.json'), 'utf8')) as { packages?: Record<string, { version?: unknown; integrity?: unknown; resolved?: unknown }> }
      const locked = lock.packages?.['node_modules/@deepseek-ai/dsh']
      if (locked?.version !== version || locked.integrity !== metadata.integrity) throw new Error('package-lock 中的根包 integrity 与官方元数据不一致')
      for (const [path, entry] of Object.entries(lock.packages ?? {})) {
        if (!path) continue
        if (typeof entry.resolved !== 'string') throw new Error(`依赖缺少固定下载地址：${path}`)
        const resolved = new URL(entry.resolved)
        if (resolved.protocol !== 'https:' || resolved.origin !== OFFICIAL_REGISTRY_ORIGIN) throw new Error(`依赖逃逸固定 npm registry：${path}`)
        if (typeof entry.integrity !== 'string' || !entry.integrity.startsWith('sha512-')) throw new Error(`依赖缺少 sha512 integrity：${path}`)
      }
      const entryPath = join(packageRoot, manifest.bin.dsh)
      const launch = embeddedNodeLaunch()
      await this.#runProbe(operationId, launch.executable, [entryPath, '--version'], staging, launch.env, signal)
      await this.#runWebProbe(entryPath, staging, signal)
      signal.throwIfAborted()
      const checked = await preflightRuntime(packageRoot)
      if (!checked.report.ready) throw new Error(`安装后的官方运行时预检失败：${checked.report.checks.filter(check => check.level === 'failure').map(check => check.detail).join('；')}`)

      await rm(home, { recursive: true, force: true })
      await rm(cache, { recursive: true, force: true })
      await onProgress({ phase: 'manifest', detail: '正在生成完整运行时文件清单' })
      const fileManifest = await writeRuntimeManifest(staging, signal)
      const installedAt = new Date().toISOString()
      const receipt: InstallReceipt = {
        schema: 1,
        package: '@deepseek-ai/dsh',
        version,
        source: 'npm',
        registry: OFFICIAL_REGISTRY_ORIGIN,
        rootIntegrity: metadata.integrity,
        manifestDigest: fileManifest.digest,
        files: fileManifest.files,
        nodeVersion: process.versions.node,
        platform: process.platform,
        arch: process.arch,
        installedAt,
      }
      await this.#writeSynced(join(staging, 'install-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
      await this.#writeSynced(join(staging, 'READY'), `${fileManifest.digest}\n`)
      signal.throwIfAborted()
      await mkdir(dirname(finalRoot), { recursive: true, mode: 0o700 })
      try {
        await rename(staging, finalRoot)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' && (error as NodeJS.ErrnoException).code !== 'ENOTEMPTY') throw error
        try {
          const winner = await this.#validateInstalledRoot(finalRoot, version, metadata.integrity, signal)
          await rm(staging, { recursive: true, force: true })
          return this.#record(finalRoot, winner)
        } catch {
          const quarantine = `${finalRoot}.corrupt-${randomUUID()}`
          await rename(finalRoot, quarantine)
          try {
            await rename(staging, finalRoot)
          } catch (publishError) {
            await rename(quarantine, finalRoot).catch(() => undefined)
            throw publishError
          }
        }
      }
      return this.#record(finalRoot, receipt)
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      throw error
    } finally {
      this.#children.delete(operationId)
    }
  }

  async #runNpm(operationId: string, staging: string, home: string, cache: string, userConfig: string, logPath: string, version: string): Promise<void> {
    const require = createRequire(import.meta.url)
    const npmRoot = dirname(require.resolve('npm'))
    const npmCli = join(npmRoot, 'bin', 'npm-cli.js')
    const env = isolatedInstallerEnvironment(home, userConfig, cache)
    const child = spawn(process.execPath, [
      npmCli,
      'install',
      '--save-exact',
      '--package-lock=true',
      '--ignore-scripts=true',
      '--audit=false',
      '--fund=false',
      `--registry=${OFFICIAL_REGISTRY_ORIGIN}`,
      `--userconfig=${userConfig}`,
      `@deepseek-ai/dsh@${version}`,
    ], {
      cwd: staging,
      env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.#children.set(operationId, child)
    const log = await open(logPath, 'a', 0o600)
    child.stdout?.on('data', chunk => { void log.appendFile(chunk).catch(() => undefined) })
    child.stderr?.on('data', chunk => { void log.appendFile(chunk).catch(() => undefined) })
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>(resolve => {
      child.once('error', error => resolve({ code: null, signal: null, error }))
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    await log.sync().catch(() => undefined)
    await log.close().catch(() => undefined)
    if (result.error) throw result.error
    if (result.code !== 0) throw new Error(`官方运行时安装失败（退出码 ${result.code ?? result.signal ?? 'unknown'}），详见 ${logPath}`)
  }

  async #runWebProbe(entryPath: string, cwd: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const home = join(cwd, '.probe-home')
    await mkdir(home, { recursive: true, mode: 0o700 })
    const launch = embeddedNodeLaunch({ DSH_HOME: home })
    const child = spawn(launch.executable, ['--expose-internals', entryPath, 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
      cwd,
      env: launch.env,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve({ code, signal }))
    })
    const ready = new Promise<number>((resolve, reject) => {
      const inspect = (chunk: Buffer): void => {
        output = `${output}${chunk.toString('utf8')}`.slice(-64 * 1024)
        const match = output.match(/dsh web: http:\/\/127\.0\.0\.1:(\d+)/u)
        if (match) resolve(Number(match[1]))
      }
      child.stdout?.on('data', inspect)
      child.stderr?.on('data', inspect)
      void exit.then(result => reject(new Error(`官方运行时 Web 探针提前退出：${result.code ?? result.signal ?? 'unknown'}\n${output}`)), reject)
    })
    try {
      const aborted = new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason instanceof Error ? signal.reason : new Error('安装已取消')), { once: true }))
      const port = await Promise.race([ready, aborted, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`官方运行时 Web 探针超时\n${output}`)), 30_000))])
      const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5_000) })
      if (!response.ok) throw new Error(`官方运行时 Web 探针返回 HTTP ${response.status}`)
    } finally {
      if (child.pid) {
        try {
          if (process.platform === 'win32') child.kill('SIGTERM')
          else process.kill(-child.pid, 'SIGTERM')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
        await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 6_000))])
        try {
          if (process.platform === 'win32') child.kill('SIGKILL')
          else process.kill(-child.pid, 'SIGKILL')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
      await rm(home, { recursive: true, force: true })
    }
  }

  async #runProbe(operationId: string, executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const child = spawn(executable, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    this.#children.set(operationId, child)
    let output = ''
    child.stdout?.on('data', chunk => { output += String(chunk) })
    child.stderr?.on('data', chunk => { output += String(chunk) })
    const send = (value: NodeJS.Signals): void => {
      if (!child.pid) return
      try {
        if (process.platform === 'win32') child.kill(value)
        else process.kill(-child.pid, value)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    let killTimer: NodeJS.Timeout | undefined
    const abort = (): void => {
      send('SIGTERM')
      killTimer = setTimeout(() => send('SIGKILL'), 6_000)
      killTimer.unref()
    }
    signal.addEventListener('abort', abort, { once: true })
    let timedOut = false
    const timeout = setTimeout(() => { timedOut = true; send('SIGKILL') }, 15_000)
    timeout.unref()
    try {
      const result = await new Promise<{ code: number | null; error?: Error }>(resolve => {
        child.once('error', error => resolve({ code: null, error }))
        child.once('exit', code => resolve({ code }))
      })
      if (timedOut) throw new Error('官方运行时 CLI 探针超时')
      signal.throwIfAborted()
      if (result.error) throw result.error
      if (result.code !== 0) throw new Error(`官方运行时执行探针失败：${output.trim()}`)
    } finally {
      clearTimeout(timeout)
      if (killTimer) clearTimeout(killTimer)
      signal.removeEventListener('abort', abort)
      if (this.#children.get(operationId) === child) this.#children.delete(operationId)
    }
  }

  async #validateInstalledRoot(root: string, version: string, integrity: string, signal?: AbortSignal): Promise<InstallReceipt> {
    const receipt = JSON.parse(await readFile(join(root, 'install-receipt.json'), 'utf8')) as InstallReceipt
    if (receipt.schema !== 1 || receipt.package !== '@deepseek-ai/dsh' || receipt.version !== version || receipt.source !== 'npm' || receipt.registry !== OFFICIAL_REGISTRY_ORIGIN || receipt.rootIntegrity !== integrity || receipt.platform !== process.platform || receipt.arch !== process.arch) throw new Error('官方运行时安装收据身份或平台不匹配')
    const ready = (await readFile(join(root, 'READY'), 'utf8')).trim()
    const verified = await verifyRuntimeManifest(root, signal)
    if (receipt.manifestDigest !== verified.digest || receipt.files !== verified.files || ready !== verified.digest) throw new Error('官方运行时文件清单与安装收据不匹配')
    return receipt
  }

  async #writeSynced(path: string, content: string): Promise<void> {
    const file = await open(path, 'w', 0o600)
    try {
      await file.writeFile(content, 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
  }

  #record(root: string, receipt: InstallReceipt): RuntimeRecord {
    const packageRoot = join(root, 'node_modules', '@deepseek-ai', 'dsh')
    return {
      id: `runtime-official-${receipt.version}`,
      name: `DSH ${receipt.version}`,
      source: 'downloaded',
      path: packageRoot,
      managedPath: root,
      integrity: receipt.rootIntegrity,
      installReceiptPath: join(root, 'install-receipt.json'),
      version: receipt.version,
      registeredAt: receipt.installedAt,
      preflight: { checkedAt: receipt.installedAt, ready: false, checks: [] },
    }
  }
}
