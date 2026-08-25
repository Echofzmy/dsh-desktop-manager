import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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

  it('applies trusted patches and removes inherited credential references', async () => {
    const { root, instance, runtime, environment } = await fixture()
    const capture = join(root, 'capture.json')
    await writeFile(runtime.preflight.entryPath!, `
const fs = require('node:fs')
const http = require('node:http')
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ argv: process.argv.slice(2), shadow: process.env.SUB2API_API_KEY, unrelated: process.env.GITHUB_TOKEN, home: process.env.DSH_HOME }))
const server = http.createServer((_request, response) => response.end('ok'))
server.listen(0, '127.0.0.1', () => console.log('dsh web: http://127.0.0.1:' + server.address().port))
`)
    const previous = process.env.SUB2API_API_KEY
    const previousGithub = process.env.GITHUB_TOKEN
    process.env.SUB2API_API_KEY = 'must-not-reach-child'
    process.env.GITHUB_TOKEN = 'must-reach-child'
    const supervisor = new InstanceSupervisor(join(root, 'logs'), { onStatus: () => undefined })
    try {
      const running = await supervisor.start(instance, runtime, environment, {
        patchPaths: ['/manager/model-credentials.yml'],
        removeEnvironmentKeys: ['sub2api_api_key', 'dsh_home', 'electron_run_as_node'],
      })
      const result = JSON.parse(await readFile(capture, 'utf8')) as { argv: string[]; shadow?: string; unrelated?: string; home?: string }
      expect(result.argv).toEqual(['web', '--patch', '/manager/model-credentials.yml', '--host', '127.0.0.1', '--port', '0', '--no-open'])
      expect(result.shadow).toBeUndefined()
      expect(result.unrelated).toBe('must-reach-child')
      expect(result.home).toBe(environment.path)
      await supervisor.stop(running, true)
    } finally {
      if (previous === undefined) delete process.env.SUB2API_API_KEY
      else process.env.SUB2API_API_KEY = previous
      if (previousGithub === undefined) delete process.env.GITHUB_TOKEN
      else process.env.GITHUB_TOKEN = previousGithub
    }
  })

  it('contains a spawn error before a pid is published', async () => {
    const { root, instance, runtime, environment } = await fixture()
    const supervisor = new InstanceSupervisor(join(root, 'logs'), { onStatus: () => undefined })
    const missingWorkspace = { ...instance, workspacePath: join(root, 'missing') }
    await expect(supervisor.start(missingWorkspace, runtime, environment)).rejects.toThrow()
    expect(supervisor.isRunning(instance.id)).toBe(false)
  })
})
