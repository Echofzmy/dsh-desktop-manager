import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { processGroupAlive } from './instance-supervisor.js'
import { toolEnvironment } from './runtime-preflight.js'
import type { RuntimeRecord, RuntimeTaskKind, RuntimeTaskRecord } from '../shared/types.js'

const TASK_ARGS: Record<RuntimeTaskKind, string[]> = {
  install: ['install'],
  typecheck: ['run', 'typecheck'],
  test: ['test'],
  build: ['run', 'build'],
}

export class RuntimeTaskRunner {
  readonly #children = new Map<string, ChildProcess>()
  readonly #controllers = new Map<string, AbortController>()

  prepare(taskId: string): void {
    if (this.#controllers.has(taskId)) throw new Error('任务已准备。')
    this.#controllers.set(taskId, new AbortController())
  }

  discard(taskId: string): void {
    if (!this.#children.has(taskId)) this.#controllers.delete(taskId)
  }

  async run(task: RuntimeTaskRecord, runtime: RuntimeRecord): Promise<void> {
    const controller = this.#controllers.get(task.id) ?? new AbortController()
    this.#controllers.set(task.id, controller)
    controller.signal.throwIfAborted()
    if (runtime.source !== 'local') throw new Error('构建与诊断任务仅适用于本地源码运行版本。')
    await mkdir(dirname(task.logPath), { recursive: true, mode: 0o700 })
    const log = await open(task.logPath, 'a', 0o600)
    await log.appendFile(`[manager] ${new Date().toISOString()} pnpm ${TASK_ARGS[task.kind].join(' ')}\n`, 'utf8')
    if (controller.signal.aborted) {
      await log.close()
      controller.signal.throwIfAborted()
    }
    const child = spawn('pnpm', TASK_ARGS[task.kind], {
      cwd: runtime.path,
      env: { ...toolEnvironment(), FORCE_COLOR: '0' },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.#children.set(task.id, child)
    child.stdout?.on('data', chunk => { void log.appendFile(chunk).catch(() => undefined) })
    child.stderr?.on('data', chunk => { void log.appendFile(chunk).catch(() => undefined) })
    try {
      const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>(resolve => {
        child.once('error', error => resolve({ code: null, signal: null, error }))
        child.once('exit', (code, signal) => resolve({ code, signal }))
      })
      if (result.error) throw result.error
      if (result.code !== 0) throw new Error(`任务退出码 ${result.code ?? result.signal ?? 'unknown'}`)
    } finally {
      this.#children.delete(task.id)
      this.#controllers.delete(task.id)
      await log.sync().catch(() => undefined)
      await log.close().catch(() => undefined)
    }
  }

  async cancel(taskId: string): Promise<void> {
    this.#controllers.get(taskId)?.abort(new Error('任务已取消。'))
    const child = this.#children.get(taskId)
    if (!child?.pid) return
    const pid = child.pid
    const signal = (value: NodeJS.Signals): void => {
      try {
        if (process.platform === 'win32') child.kill(value)
        else process.kill(-pid, value)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    signal('SIGTERM')
    const waitForGroup = async (timeout: number): Promise<boolean> => {
      const deadline = Date.now() + timeout
      while (processGroupAlive(pid)) {
        if (Date.now() >= deadline) return false
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      return true
    }
    if (!await waitForGroup(6_000)) {
      signal('SIGKILL')
      if (!await waitForGroup(6_000)) throw new Error('任务进程组在强制停止后仍未退出。')
    }
  }

  async cancelAll(): Promise<void> {
    await Promise.allSettled([...this.#controllers.keys()].map(id => this.cancel(id)))
  }

  async readLog(task: RuntimeTaskRecord, maxBytes = 512 * 1024): Promise<{ path: string; content: string; truncated: boolean }> {
    try {
      const content = await readFile(task.logPath)
      const truncated = content.length > maxBytes
      return { path: task.logPath, content: content.subarray(Math.max(0, content.length - maxBytes)).toString('utf8'), truncated }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path: task.logPath, content: '', truncated: false }
      throw error
    }
  }
}
