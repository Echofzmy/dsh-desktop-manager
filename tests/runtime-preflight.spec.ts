import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { preflightRuntime } from '../src/main/runtime-preflight.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

async function runtimeFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-manager-runtime-'))
  roots.push(root)
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh-root',
    version: '1.2.3',
    engines: { node: '>=22' },
    packageManager: 'pnpm@11.5.2',
  }))
  return root
}

describe('preflightRuntime', () => {
  it('keeps an unbuilt source checkout registered but blocked', async () => {
    const root = await runtimeFixture()
    const { report } = await preflightRuntime(root)
    expect(report.ready).toBe(false)
    expect(report.checks.find(check => check.id === 'build')?.level).toBe('failure')
    expect(report.checks.find(check => check.id === 'web-build')?.level).toBe('failure')
  })

  it('accepts complete launcher and Web artifacts', async () => {
    const root = await runtimeFixture()
    await mkdir(join(root, 'node_modules'))
    await mkdir(join(root, 'apps', 'cli', 'lib'), { recursive: true })
    await mkdir(join(root, 'apps', 'web', 'dist'), { recursive: true })
    await writeFile(join(root, 'apps', 'cli', 'lib', 'bin.js'), '')
    await writeFile(join(root, 'apps', 'web', 'dist', 'index.html'), '')

    const { report } = await preflightRuntime(root)
    expect(report.ready).toBe(true)
    expect(report.entryPath).toBe(join(await realpath(root), 'apps', 'cli', 'lib', 'bin.js'))
  })

  it('accepts a published package with an ancestor-hoisted frontend dependency', async () => {
    const project = await mkdtemp(join(tmpdir(), 'dsh-manager-package-'))
    roots.push(project)
    const root = join(project, 'node_modules', '@deepseek-ai', 'dsh')
    await mkdir(join(root, 'lib'), { recursive: true })
    await writeFile(join(root, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh',
      version: '1.2.3',
      engines: { node: '>=22' },
      bin: { dsh: 'lib/bin.js' },
    }))
    const frontend = join(project, 'node_modules', '@deepseek-ai', 'dsh-web-frontend')
    await mkdir(join(frontend, 'dist'), { recursive: true })
    await writeFile(join(frontend, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-web-frontend', version: '1.2.3' }))
    await writeFile(join(root, 'lib', 'bin.js'), '')
    await writeFile(join(frontend, 'dist', 'index.html'), '')

    const { report } = await preflightRuntime(root)
    expect(report.ready).toBe(true)
    expect(report.entryPath).toBe(join(await realpath(root), 'lib', 'bin.js'))
  })
})
