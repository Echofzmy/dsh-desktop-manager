import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { ModelConfigurationService } from '../src/main/model-configuration-service.js'
import { ModelSettingsProjection } from '../src/main/model-settings-projection.js'
import { processGroupAlive } from '../src/main/instance-supervisor.js'
import type { RuntimeRecord } from '../src/shared/types.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

describe('ModelConfigurationService', () => {
  it('preserves its isolated DSH_HOME while removing inherited secret-bearing environment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-model-configuration-env-'))
    roots.push(root)
    const runtimeRoot = join(root, 'runtime')
    const entry = join(runtimeRoot, 'launcher.cjs')
    await mkdir(runtimeRoot)
    await writeFile(entry, `
const http = require('node:http')
const server = http.createServer((_request, response) => {
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify({ home: process.env.DSH_HOME, leaked: process.env.DSH_MANAGER_MODEL_TEST_SECRET }))
})
server.listen(0, '127.0.0.1', () => console.log('dsh web: http://127.0.0.1:' + server.address().port))
`)
    const now = new Date().toISOString()
    const runtime: RuntimeRecord = {
      id: 'runtime-env', name: 'Runtime', source: 'local', path: runtimeRoot, registeredAt: now,
      preflight: { checkedAt: now, ready: true, entryPath: entry, checks: [] },
    }
    const projection = new ModelSettingsProjection(root)
    await projection.initialize()
    const service = new ModelConfigurationService(root, projection)
    process.env.DSH_MANAGER_MODEL_TEST_SECRET = 'must-not-inherit'
    try {
      const instance = await service.ensureRunning(runtime)
      const response = await fetch(`http://127.0.0.1:${instance.port}/`)
      await expect(response.json()).resolves.toEqual({ home: projection.home })
    } finally {
      delete process.env.DSH_MANAGER_MODEL_TEST_SECRET
      await service.stop()
    }
  })

  it('serializes concurrent view requests and stops its DSH process group', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-model-configuration-'))
    roots.push(root)
    const runtimeRoot = join(root, 'runtime')
    const entry = join(runtimeRoot, 'launcher.cjs')
    await mkdir(runtimeRoot)
    await writeFile(entry, `
const http = require('node:http')
const server = http.createServer((_request, response) => response.end('ok'))
server.listen(0, '127.0.0.1', () => console.log('dsh web: http://127.0.0.1:' + server.address().port))
`)
    const now = new Date().toISOString()
    const runtime: RuntimeRecord = {
      id: 'runtime', name: 'Runtime', source: 'local', path: runtimeRoot, registeredAt: now,
      preflight: { checkedAt: now, ready: true, entryPath: entry, checks: [] },
    }
    const projection = new ModelSettingsProjection(root)
    await projection.initialize()
    const service = new ModelConfigurationService(root, projection)

    const [first, second] = await Promise.all([service.ensureRunning(runtime), service.ensureRunning(runtime)])
    expect(first.pid).toBe(second.pid)
    expect(first.port).toBeGreaterThan(0)
    expect(processGroupAlive(first.pid!)).toBe(true)
    expect(service.usesRuntime(runtime.id)).toBe(true)

    await service.stop()
    expect(service.usesRuntime(runtime.id)).toBe(false)
    expect(processGroupAlive(first.pid!)).toBe(false)

    await writeFile(entry, `
const http = require('node:http')
const server = http.createServer((_request, response) => response.end('ok'))
setTimeout(() => server.listen(0, '127.0.0.1', () => console.log('dsh web: http://127.0.0.1:' + server.address().port)), 250)
`)
    const reopening = service.ensureRunning(runtime)
    await new Promise(resolve => setTimeout(resolve, 50))
    const closing = service.stop()
    const reopened = service.ensureRunning(runtime)
    await expect(reopening).rejects.toThrow('统一配置页面已经关闭')
    await closing
    const next = await reopened
    expect(processGroupAlive(next.pid!)).toBe(true)
    expect(service.usesRuntime(runtime.id)).toBe(true)
    await service.stop()
    expect(service.usesRuntime(runtime.id)).toBe(false)
  })
})
