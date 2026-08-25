import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { InstanceSupervisor, processGroupAlive } from '../src/main/instance-supervisor.js'
import type { EnvironmentRecord, InstanceRecord, RuntimeRecord } from '../src/shared/types.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

async function fixture(stubbornChild = false): Promise<{ root: string; instance: InstanceRecord; runtime: RuntimeRecord; environment: EnvironmentRecord }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-manager-supervisor-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  const home = join(root, 'home')
  await mkdir(workspace)
  await mkdir(home)
  const entry = join(root, 'launcher.cjs')
  const child = stubbornChild
    ? "const stubborn = require('node:child_process').spawn(process.execPath, ['-e', \"process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)\"], { stdio: ['ignore', 'pipe', 'ignore'] })"
    : ''
  const listen = stubbornChild ? "stubborn.stdout.once('data', start)" : 'start()'
  await writeFile(entry, `
const http = require('node:http')
${child}
const server = http.createServer((_request, response) => { response.statusCode = 200; response.end('ok') })
const start = () => server.listen(0, '127.0.0.1', () => console.log('dsh web: http://127.0.0.1:' + server.address().port))
${listen}
`)
  const instance: InstanceRecord = {
    id: 'instance', name: 'Test', runtimeId: 'runtime', workspacePath: workspace, environmentId: 'environment',
    port: 0, automaticPort: true, createdAt: new Date().toISOString(), status: 'stopped',
  }
  const runtime: RuntimeRecord = {
    id: 'runtime', name: 'Test runtime', source: 'local', path: root, registeredAt: new Date().toISOString(),
    preflight: { checkedAt: new Date().toISOString(), ready: true, entryPath: entry, checks: [] },
  }
  const environment: EnvironmentRecord = { id: 'environment', name: 'Test home', kind: 'isolated', path: home, createdAt: new Date().toISOString() }
  return { root, instance, runtime, environment }
}

describe('InstanceSupervisor', () => {
  it('waits for the whole process group and force-kills descendants even when status persistence fails', async () => {
    const { root, instance, runtime, environment } = await fixture(true)
    const supervisor = new InstanceSupervisor(join(root, 'logs'), {
      onStatus: (_id, patch) => {
        if (patch.status === 'stopping') throw new Error('simulated state failure')
      },
    })
    const running = await supervisor.start(instance, runtime, environment)
    expect(running.pid).toBeTypeOf('number')

    await expect(supervisor.stop(running)).rejects.toThrow(/simulated state failure|still stopping/u)
    expect(supervisor.isRunning(instance.id)).toBe(true)
    expect(processGroupAlive(running.pid!)).toBe(true)

    await expect(supervisor.stop(running, true)).rejects.toThrow('simulated state failure')
    expect(supervisor.isRunning(instance.id)).toBe(false)
    expect(processGroupAlive(running.pid!)).toBe(false)
  }, 15_000)

  it('contains a spawn error before a pid is published', async () => {
    const { root, instance, runtime, environment } = await fixture()
    const supervisor = new InstanceSupervisor(join(root, 'logs'), { onStatus: () => undefined })
    const missingWorkspace = { ...instance, workspacePath: join(root, 'missing') }
    await expect(supervisor.start(missingWorkspace, runtime, environment)).rejects.toThrow()
    expect(supervisor.isRunning(instance.id)).toBe(false)
  })
})
