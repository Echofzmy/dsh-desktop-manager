import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { preflightRuntime } from '../runtime-preflight.js'
import { verifyRuntimeManifest } from './integrity.js'
import { OFFICIAL_REGISTRY_ORIGIN } from './registry-client.js'
import type { RuntimeRecord } from '../../shared/types.js'

interface BundledReceipt {
  package?: unknown
  schema?: unknown
  registry?: unknown
  platform?: unknown
  arch?: unknown
  version?: unknown
  source?: unknown
  rootIntegrity?: unknown
  manifestDigest?: unknown
  files?: unknown
  installedAt?: unknown
}

export async function verifyOfficialRuntime(runtime: RuntimeRecord): Promise<void> {
  if (runtime.source === 'local') return
  if (!runtime.managedPath || !runtime.installReceiptPath) throw new Error('官方运行时缺少受管路径或安装收据')
  const receipt = JSON.parse(await readFile(runtime.installReceiptPath, 'utf8')) as BundledReceipt
  const ready = (await readFile(join(runtime.managedPath, 'READY'), 'utf8')).trim()
  const expectedSource = runtime.source === 'bundled' ? 'bundled' : 'npm'
  if (receipt.schema !== 1 || receipt.package !== '@deepseek-ai/dsh' || receipt.version !== runtime.version || receipt.source !== expectedSource || receipt.registry !== OFFICIAL_REGISTRY_ORIGIN || receipt.platform !== process.platform || receipt.arch !== process.arch || receipt.rootIntegrity !== runtime.integrity || typeof receipt.manifestDigest !== 'string' || typeof receipt.files !== 'number') throw new Error('官方运行时安装收据与注册记录不一致')
  const verified = await verifyRuntimeManifest(runtime.managedPath)
  if (verified.digest !== receipt.manifestDigest || verified.digest !== ready || verified.files !== receipt.files) throw new Error('官方运行时文件完整性校验失败')
}

export async function discoverBundledRuntime(root: string): Promise<RuntimeRecord | undefined> {
  try {
    const ready = (await readFile(join(root, 'READY'), 'utf8')).trim()
    const receiptPath = join(root, 'install-receipt.json')
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as BundledReceipt
    if (receipt.schema !== 1 || receipt.package !== '@deepseek-ai/dsh' || typeof receipt.version !== 'string' || receipt.source !== 'bundled' || receipt.registry !== OFFICIAL_REGISTRY_ORIGIN || receipt.platform !== process.platform || receipt.arch !== process.arch || typeof receipt.rootIntegrity !== 'string' || typeof receipt.manifestDigest !== 'string' || typeof receipt.files !== 'number' || typeof receipt.installedAt !== 'string') {
      throw new Error('内置 DSH 安装收据无效')
    }
    const verified = await verifyRuntimeManifest(root)
    if (verified.digest !== receipt.manifestDigest || verified.digest !== ready || verified.files !== receipt.files) throw new Error('内置 DSH 文件清单与收据不一致')
    const packageRoot = join(root, 'node_modules', '@deepseek-ai', 'dsh')
    const checked = await preflightRuntime(packageRoot)
    if (!checked.report.ready) throw new Error(`内置 DSH 预检失败：${checked.report.checks.filter(check => check.level === 'failure').map(check => check.detail).join('；')}`)
    return {
      id: `runtime-bundled-${receipt.version}`,
      name: `内置 DSH ${receipt.version}`,
      source: 'bundled',
      path: checked.path,
      managedPath: root,
      integrity: receipt.rootIntegrity,
      installReceiptPath: receiptPath,
      version: receipt.version,
      registeredAt: receipt.installedAt,
      preflight: checked.report,
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
