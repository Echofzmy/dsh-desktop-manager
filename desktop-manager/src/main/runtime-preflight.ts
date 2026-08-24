import { execFile } from 'node:child_process'
import { access, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import semver from 'semver'
import type { PreflightCheck, PreflightReport } from '../shared/types.js'

const execFileAsync = promisify(execFile)
const BUILT_ENTRY = join('apps', 'cli', 'lib', 'bin.js')

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function resolvePackageRoot(fromFile: string, packageName: string): Promise<string | undefined> {
  const resolver = createRequire(fromFile)
  const segments = packageName.split('/')
  for (const searchPath of resolver.resolve.paths(packageName) ?? []) {
    const manifestPath = join(searchPath, ...segments, 'package.json')
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { name?: string }
      if (manifest.name === packageName) return dirname(manifestPath)
    } catch {
      // Continue through Node's remaining search paths.
    }
  }
  return undefined
}

async function command(command: string, args: string[], cwd: string): Promise<string | undefined> {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
    })
    return result.stdout.trim()
  } catch {
    return undefined
  }
}

function addCheck(checks: PreflightCheck[], check: PreflightCheck): void {
  checks.push(check)
}

export async function preflightRuntime(inputPath: string): Promise<{ path: string; report: PreflightReport }> {
  const checks: PreflightCheck[] = []
  const checkedAt = new Date().toISOString()
  let runtimePath: string

  try {
    runtimePath = await realpath(inputPath)
    if (!(await stat(runtimePath)).isDirectory()) throw new Error('path is not a directory')
    addCheck(checks, { id: 'directory', label: 'Runtime directory', level: 'pass', detail: runtimePath })
  } catch (error) {
    return {
      path: inputPath,
      report: {
        checkedAt,
        ready: false,
        checks: [{
          id: 'directory',
          label: 'Runtime directory',
          level: 'failure',
          detail: error instanceof Error ? error.message : 'Directory is unavailable',
          remediation: '请选择现有的 DSH 源码目录或已发布运行时目录。',
        }],
      },
    }
  }

  let manifest: { name?: unknown; version?: unknown; engines?: { node?: unknown }; packageManager?: unknown; bin?: { dsh?: unknown } } = {}
  try {
    manifest = JSON.parse(await readFile(join(runtimePath, 'package.json'), 'utf8')) as typeof manifest
    const isDsh = manifest.name === '@deepseek-ai/dsh-root' || manifest.name === '@deepseek-ai/dsh'
    addCheck(checks, isDsh
      ? { id: 'manifest', label: 'DSH manifest', level: 'pass', detail: String(manifest.name) }
      : {
          id: 'manifest',
          label: 'DSH manifest',
          level: 'failure',
          detail: 'package.json 不是可识别的 DSH 包',
          remediation: '请选择 DeepSeek Harness 源码目录或已发布运行时目录。',
        })
  } catch {
    addCheck(checks, {
      id: 'manifest',
      label: 'DSH manifest',
      level: 'failure',
      detail: '无法读取 package.json',
      remediation: '请选择包含 DSH package.json 的目录。',
    })
  }

  const systemNode = await command('node', ['--version'], runtimePath)
  const nodeVersion = systemNode?.replace(/^v/, '')
  const nodeRange = typeof manifest.engines?.node === 'string' ? manifest.engines.node : undefined
  const nodeCompatible = nodeVersion !== undefined && (nodeRange === undefined || semver.satisfies(nodeVersion, nodeRange))
  addCheck(checks, nodeCompatible
    ? { id: 'node', label: 'Node.js', level: 'pass', detail: `v${nodeVersion}${nodeRange ? `，满足 ${nodeRange}` : ''}` }
    : {
        id: 'node',
        label: 'Node.js',
        level: 'failure',
        detail: nodeVersion ? `v${nodeVersion} 不满足 ${nodeRange}` : '系统中未找到 Node.js',
        remediation: nodeRange ? `请安装满足 ${nodeRange} 的 Node.js 版本。` : '请先安装 Node.js。',
      })

  const pnpmVersion = await command('pnpm', ['--version'], runtimePath)
  const declaredPnpm = typeof manifest.packageManager === 'string' && manifest.packageManager.startsWith('pnpm@')
    ? manifest.packageManager.slice('pnpm@'.length)
    : undefined
  addCheck(checks, pnpmVersion
    ? {
        id: 'pnpm',
        label: 'pnpm',
        level: declaredPnpm && pnpmVersion !== declaredPnpm ? 'warning' : 'pass',
        detail: `v${pnpmVersion}${declaredPnpm ? `（运行时声明 ${declaredPnpm}）` : ''}`,
        ...(declaredPnpm && pnpmVersion !== declaredPnpm ? { remediation: `请使用 corepack 激活 pnpm ${declaredPnpm}。` } : {}),
      }
    : {
        id: 'pnpm',
        label: 'pnpm',
        level: 'warning',
        detail: '系统中未找到 pnpm',
        remediation: '构建运行时前，请先安装其声明的包管理器。',
      })

  const sourceCheckout = manifest.name === '@deepseek-ai/dsh-root'
  const packagedEntry = manifest.name === '@deepseek-ai/dsh' && typeof manifest.bin?.dsh === 'string'
    ? manifest.bin.dsh
    : undefined
  const entryRelativePath = sourceCheckout ? BUILT_ENTRY : packagedEntry
  const entryPath = entryRelativePath ? join(runtimePath, entryRelativePath) : join(runtimePath, BUILT_ENTRY)
  const built = entryRelativePath !== undefined && await exists(entryPath)

  const dependenciesInstalled = sourceCheckout
    ? await exists(join(runtimePath, 'node_modules'))
    : built
  addCheck(checks, dependenciesInstalled
    ? { id: 'dependencies', label: 'Dependencies', level: 'pass', detail: sourceCheckout ? '依赖已安装' : '启动程序可按 Node 规则解析依赖' }
    : {
        id: 'dependencies',
        label: 'Dependencies',
        level: 'failure',
        detail: sourceCheckout ? '缺少 node_modules' : '无法解析已发布运行时的启动程序',
        remediation: sourceCheckout ? '请在运行时目录执行 pnpm install。' : '请重新安装已发布的 DSH 包。',
      })

  addCheck(checks, built
    ? { id: 'build', label: 'Built launcher', level: 'pass', detail: entryPath }
    : {
        id: 'build',
        label: 'Built launcher',
        level: 'failure',
        detail: entryRelativePath ? `缺少 ${entryRelativePath}` : 'package.json 未声明 dsh 启动程序',
        remediation: sourceCheckout ? '请在运行时目录执行 pnpm run build。' : '请重新安装已发布的 DSH 包。',
      })

  let publishedFrontendRoot: string | undefined
  if (!sourceCheckout && built) {
    publishedFrontendRoot = await resolvePackageRoot(entryPath, '@deepseek-ai/dsh-web-frontend')
    if (!publishedFrontendRoot) {
      const webAppRoot = await resolvePackageRoot(entryPath, '@deepseek-ai/dsh-web-app')
      if (webAppRoot) publishedFrontendRoot = await resolvePackageRoot(join(webAppRoot, 'package.json'), '@deepseek-ai/dsh-web-frontend')
    }
  }
  const webEntryPath = sourceCheckout
    ? join(runtimePath, 'apps', 'web', 'dist', 'index.html')
    : publishedFrontendRoot ? join(publishedFrontendRoot, 'dist', 'index.html') : ''
  const webBuilt = Boolean(webEntryPath) && await exists(webEntryPath)
  addCheck(checks, webBuilt
    ? { id: 'web-build', label: 'Built Web GUI', level: 'pass', detail: webEntryPath }
    : {
        id: 'web-build',
        label: 'Built Web GUI',
        level: 'failure',
        detail: sourceCheckout ? '缺少 apps/web/dist/index.html' : '缺少 @deepseek-ai/dsh-web-frontend',
        remediation: sourceCheckout ? '请执行 pnpm run build，生成完整运行时。' : '请重新安装 DSH 包及其依赖。',
      })

  const gitCommit = await command('git', ['rev-parse', 'HEAD'], runtimePath)
  const gitStatus = gitCommit ? await command('git', ['status', '--porcelain', '--', '.'], runtimePath) : undefined
  if (gitCommit) {
    addCheck(checks, {
      id: 'git',
      label: 'Git revision',
      level: gitStatus ? 'warning' : 'pass',
      detail: `${gitCommit.slice(0, 12)}${gitStatus ? '，有本地修改' : '，工作区干净'}`,
    })
  } else {
    addCheck(checks, { id: 'git', label: 'Git revision', level: 'warning', detail: '该目录不在 Git 工作树中' })
  }

  return {
    path: runtimePath,
    report: {
      checkedAt,
      ready: checks.every(check => check.level !== 'failure'),
      ...(built ? { entryPath } : {}),
      nodeVersion,
      ...(pnpmVersion ? { pnpmVersion } : {}),
      ...(typeof manifest.version === 'string' ? { packageVersion: manifest.version } : {}),
      ...(gitCommit ? { gitCommit, gitDirty: Boolean(gitStatus) } : {}),
      checks,
    },
  }
}
