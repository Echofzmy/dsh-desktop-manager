import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, open, readFile, stat, type FileHandle } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import type { EnvironmentRecord, InstanceLog, InstanceRecord, RuntimeRecord } from '../shared/types.js'

interface ExitResult {
  code: number | null
  signal: NodeJS.Signals | null
  error?: Error
}

interface RunningProcess {
  child: ChildProcess
  pid: number
  exit: Promise<ExitResult>
  exited: boolean
  stopping: boolean
  finalized: boolean
  log: FileHandle
  logQueue: Promise<void>
  logError?: Error
  logPath: string
  rejectReady(error: Error): void
}

export interface InstanceSupervisorEvents {
  onStatus(instanceId: string, patch: Partial<InstanceRecord>): void | Promise<void>
}

export async function portAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

export function processGroupAlive(pid: number): boolean {
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function waitForGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (processGroupAlive(pid)) {
    if (Date.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return true
}

async function confirmHealth(port: number): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) })
  if (!response.ok) throw new Error(`DSH readiness URL returned HTTP ${response.status}`)
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, signal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}

function combinedError(message: string, errors: unknown[]): Error | undefined {
  const actual = errors.filter((error): error is Error => error instanceof Error)
  if (!actual.length) return undefined
  return actual.length === 1 ? actual[0] : new AggregateError(actual, message)
}

export class InstanceSupervisor {
  readonly #logsRoot: string
  readonly #events: InstanceSupervisorEvents
  readonly #running = new Map<string, RunningProcess>()

  constructor(logsRoot: string, events: InstanceSupervisorEvents) {
    this.#logsRoot = logsRoot
    this.#events = events
  }

  isRunning(instanceId: string): boolean {
    return this.#running.has(instanceId)
  }

  async findAvailablePort(start = 3080, end = 3999): Promise<number> {
    for (let port = start; port <= end; port += 1) {
      if (await portAvailable(port)) return port
    }
    throw new Error(`No available loopback port between ${start} and ${end}`)
  }

  async start(instance: InstanceRecord, runtime: RuntimeRecord, environment: EnvironmentRecord): Promise<InstanceRecord> {
    if (this.#running.has(instance.id)) throw new Error(`Instance ${instance.name} is already running`)
    if (!runtime.preflight.ready || !runtime.preflight.entryPath) throw new Error(`Runtime ${runtime.name} has not passed preflight`)
    const requestedPort = instance.automaticPort ? 0 : instance.port
    if (requestedPort !== 0 && !(await portAvailable(requestedPort))) throw new Error(`Port ${requestedPort} is already in use`)

    const logDirectory = join(this.#logsRoot, instance.id)
    await mkdir(logDirectory, { recursive: true, mode: 0o700 })
    const logPath = join(logDirectory, 'current.log')
    const log = await open(logPath, 'a', 0o600)
    await log.appendFile(`\n[manager] ${new Date().toISOString()} starting ${runtime.name}\n`, 'utf8')
    await log.sync()

    let resolveReady!: (port: number) => void
    let rejectReady!: (error: Error) => void
    const ready = new Promise<number>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })

    let child: ChildProcess
    try {
      child = spawn('node', [
        runtime.preflight.entryPath,
        'web',
        '--host', '127.0.0.1',
        '--port', String(requestedPort),
        '--no-open',
      ], {
        cwd: instance.workspacePath,
        env: { ...process.env, DSH_HOME: environment.path },
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      await log.close()
      throw error
    }

    const exit = new Promise<ExitResult>(resolve => {
      let settled = false
      const settle = (result: ExitResult): void => {
        if (settled) return
        settled = true
        resolve(result)
      }
      child.once('error', error => settle({ code: null, signal: null, error }))
      child.once('exit', (code, signal) => settle({ code, signal }))
    })
    const spawned = new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })

    let readinessBuffer = ''
    let launch: RunningProcess | undefined
    const capture = (chunk: Buffer): void => {
      const text = chunk.toString('utf8')
      if (launch) this.#appendLog(launch, text)
      else void log.appendFile(text, 'utf8').catch(error => rejectReady(error))
      readinessBuffer = `${readinessBuffer}${text}`.slice(-8_192)
      const match = /(?:^|\n)dsh web: http:\/\/127\.0\.0\.1:(\d+)(?:\s|$)/.exec(readinessBuffer)
      if (match?.[1]) resolveReady(Number(match[1]))
    }
    child.stdout?.on('data', capture)
    child.stderr?.on('data', capture)

    try {
      await spawned
    } catch (error) {
      await exit
      await log.close()
      throw error
    }
    if (child.pid === undefined) {
      await log.close()
      throw new Error('DSH process did not publish a pid')
    }

    launch = {
      child,
      pid: child.pid,
      exit,
      exited: false,
      stopping: false,
      finalized: false,
      log,
      logQueue: Promise.resolve(),
      logPath,
      rejectReady,
    }
    this.#running.set(instance.id, launch)
    void exit.then(result => this.#monitorUnexpectedExit(instance, launch!, result)).catch(error => console.error('DSH exit monitor failed', error))

    const starting: InstanceRecord = {
      ...instance,
      status: 'starting',
      pid: launch.pid,
      startedAt: new Date().toISOString(),
      lastError: undefined,
      interrupted: false,
    }
    try {
      await this.#events.onStatus(instance.id, starting)
    } catch (error) {
      const teardownError = await this.#terminate(instance.id, launch, true).then(() => undefined, reason => reason as Error)
      throw combinedError('Failed to persist start state and terminate DSH', [error, teardownError])!
    }

    try {
      const actualPort = await Promise.race([
        ready,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for DSH readiness output')), 20_000)),
      ])
      await confirmHealth(actualPort)
      if (launch.exited || this.#running.get(instance.id) !== launch || !processGroupAlive(launch.pid)) {
        throw new Error('DSH exited before its running state could be committed')
      }
      const running: InstanceRecord = {
        ...starting,
        port: actualPort,
        status: 'running',
        health: { checkedAt: new Date().toISOString(), ok: true, detail: 'DSH readiness confirmed' },
      }
      try {
        await this.#events.onStatus(instance.id, running)
      } catch (error) {
        const teardownError = await this.#terminate(instance.id, launch, true).then(() => undefined, reason => reason as Error)
        throw combinedError('Failed to persist running state and terminate DSH', [error, teardownError])!
      }
      return running
    } catch (error) {
      const teardownError = await this.#terminate(instance.id, launch, true).then(() => undefined, reason => reason as Error)
      throw combinedError('DSH launch failed', [error, teardownError])!
    }
  }

  async stop(instance: InstanceRecord, force = false): Promise<InstanceRecord> {
    const launch = this.#running.get(instance.id)
    if (!launch) {
      const stopped = { ...instance, status: 'stopped' as const, pid: undefined }
      await this.#events.onStatus(instance.id, stopped)
      return stopped
    }

    const errors: unknown[] = []
    try {
      await this.#events.onStatus(instance.id, { status: 'stopping' })
    } catch (error) {
      errors.push(error)
    }
    let result: ExitResult | undefined
    try {
      result = await this.#terminate(instance.id, launch, force)
    } catch (error) {
      errors.push(error)
    }
    if (!result) throw combinedError('DSH is still stopping', errors)!

    const stopped: InstanceRecord = {
      ...instance,
      status: result.error || (result.code !== 0 && result.signal !== 'SIGTERM' && result.signal !== 'SIGKILL') ? 'failed' : 'stopped',
      pid: undefined,
      stoppedAt: new Date().toISOString(),
      exitCode: result.code,
      interrupted: false,
    }
    try {
      await this.#events.onStatus(instance.id, stopped)
    } catch (error) {
      errors.push(error)
    }
    const error = combinedError('DSH stopped but status persistence failed', errors)
    if (error) throw error
    return stopped
  }

  async stopAll(instances: InstanceRecord[]): Promise<void> {
    const active = instances.filter(instance => this.isRunning(instance.id))
    await Promise.allSettled(active.map(instance => this.stop(instance)))
    const remaining = active.filter(instance => this.isRunning(instance.id))
    await Promise.allSettled(remaining.map(instance => this.stop(instance, true)))
    const survivors = active.filter(instance => this.isRunning(instance.id))
    if (survivors.length) throw new Error(`Could not stop instances: ${survivors.map(instance => instance.name).join(', ')}`)
  }

  async readLog(instanceId: string, maxBytes = 256 * 1024): Promise<InstanceLog> {
    const path = this.#running.get(instanceId)?.logPath ?? join(this.#logsRoot, instanceId, 'current.log')
    try {
      const info = await stat(path)
      const content = await readFile(path, 'utf8')
      const truncated = info.size > maxBytes
      return { path, content: truncated ? content.slice(-maxBytes) : content, truncated }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, content: '', truncated: false }
      throw error
    }
  }

  #appendLog(launch: RunningProcess, content: string): void {
    launch.logQueue = launch.logQueue.then(() => launch.log.appendFile(content, 'utf8')).catch(error => {
      launch.logError = error instanceof Error ? error : new Error(String(error))
    })
  }

  async #terminate(instanceId: string, launch: RunningProcess, force: boolean): Promise<ExitResult> {
    launch.stopping = true
    signalProcessGroup(launch.pid, force ? 'SIGKILL' : 'SIGTERM')
    const gone = await waitForGroupExit(launch.pid, force ? 3_000 : 6_000)
    if (!gone) throw new Error(force
      ? 'DSH process group survived SIGKILL.'
      : 'DSH is still stopping. Retry with force enabled to send SIGKILL.')
    const result = await launch.exit
    await this.#finalize(instanceId, launch, result)
    return result
  }

  async #monitorUnexpectedExit(instance: InstanceRecord, launch: RunningProcess, result: ExitResult): Promise<void> {
    launch.exited = true
    launch.rejectReady(result.error ?? new Error(`DSH exited before readiness: ${String(result.code ?? result.signal)}`))
    if (launch.stopping || this.#running.get(instance.id) !== launch) return

    if (processGroupAlive(launch.pid)) {
      signalProcessGroup(launch.pid, 'SIGTERM')
      if (!(await waitForGroupExit(launch.pid, 2_000))) {
        signalProcessGroup(launch.pid, 'SIGKILL')
        await waitForGroupExit(launch.pid, 3_000)
      }
    }
    if (processGroupAlive(launch.pid)) {
      await Promise.resolve(this.#events.onStatus(instance.id, {
        status: 'failed',
        pid: launch.pid,
        interrupted: true,
        lastError: 'DSH 主进程已退出，但进程组仍有后代存活。',
      })).catch((error: unknown) => console.error('Failed to persist surviving DSH process group', error))
      return
    }

    await this.#finalize(instance.id, launch, result)
    await Promise.resolve(this.#events.onStatus(instance.id, {
      status: result.code === 0 || result.signal === 'SIGTERM' ? 'stopped' : 'failed',
      stoppedAt: new Date().toISOString(),
      exitCode: result.code,
      pid: undefined,
      interrupted: false,
      ...(result.code === 0 || result.signal === 'SIGTERM' ? {} : { lastError: `Exited with ${String(result.code ?? result.signal)}` }),
    })).catch((error: unknown) => console.error('Failed to persist DSH exit state', error))
  }

  async #finalize(instanceId: string, launch: RunningProcess, result: ExitResult): Promise<void> {
    if (launch.finalized) return
    launch.finalized = true
    if (this.#running.get(instanceId) === launch) this.#running.delete(instanceId)
    this.#appendLog(launch, `[manager] ${new Date().toISOString()} exited code=${String(result.code)} signal=${String(result.signal)}\n`)
    await launch.logQueue
    await launch.log.sync().catch(error => { launch.logError = error instanceof Error ? error : new Error(String(error)) })
    await launch.log.close().catch(error => { launch.logError = error instanceof Error ? error : new Error(String(error)) })
    if (launch.logError) console.error('DSH log persistence failed', launch.logError)
  }
}
