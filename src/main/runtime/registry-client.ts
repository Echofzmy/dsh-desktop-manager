import type { OfficialUpdateInfo } from '../../shared/types.js'

const REGISTRY_ORIGIN = 'https://registry.npmjs.org'
const PACKAGE_PATH = '/@deepseek-ai%2Fdsh'
const REQUEST_TIMEOUT_MS = 10_000

interface PackageMetadata {
  name?: unknown
  version?: unknown
  ['dist-tags']?: Record<string, unknown>
  versions?: Record<string, VersionMetadata>
  dist?: VersionMetadata['dist']
}

interface VersionMetadata {
  name?: unknown
  version?: unknown
  dist?: {
    integrity?: unknown
    tarball?: unknown
    unpackedSize?: unknown
  }
}

async function registryJson(path: string, signal?: AbortSignal): Promise<PackageMetadata> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  const response = await fetch(`${REGISTRY_ORIGIN}${path}`, {
    signal: combined,
    headers: { accept: 'application/vnd.npm.install-v1+json' },
    redirect: 'error',
  })
  if (!response.ok) throw new Error(`官方 npm registry 返回 HTTP ${response.status}`)
  return response.json() as Promise<PackageMetadata>
}

function checkedVersion(metadata: VersionMetadata, expected: string): Required<Pick<OfficialUpdateInfo, 'version' | 'integrity' | 'tarball'>> & Pick<OfficialUpdateInfo, 'unpackedSize'> {
  if (metadata.name !== '@deepseek-ai/dsh' || metadata.version !== expected) throw new Error('官方版本元数据中的包名或版本不匹配')
  const integrity = metadata.dist?.integrity
  const tarball = metadata.dist?.tarball
  if (typeof integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrity)) throw new Error('官方版本缺少有效的 sha512 integrity')
  if (typeof tarball !== 'string') throw new Error('官方版本缺少 tarball 地址')
  const url = new URL(tarball)
  if (url.protocol !== 'https:' || url.origin !== REGISTRY_ORIGIN || !url.pathname.startsWith('/@deepseek-ai/dsh/-/')) throw new Error('官方 tarball 地址不在固定 npm registry 内')
  const unpackedSize = metadata.dist?.unpackedSize
  return {
    version: expected,
    integrity,
    tarball,
    ...(typeof unpackedSize === 'number' && Number.isFinite(unpackedSize) && unpackedSize >= 0 ? { unpackedSize } : {}),
  }
}

export async function resolveOfficialVersion(version: string, signal?: AbortSignal): Promise<ReturnType<typeof checkedVersion>> {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('官方版本号格式无效')
  const metadata = await registryJson(`${PACKAGE_PATH}/${encodeURIComponent(version)}`, signal)
  return checkedVersion({ name: metadata.name, version: metadata.version, ...(metadata.dist ? { dist: metadata.dist } : {}) }, version)
}

export async function checkOfficialUpdate(
  channel: 'stable' | 'prerelease',
  installedVersions: Set<string>,
  defaultRuntimeVersion: string | undefined,
  signal?: AbortSignal,
): Promise<OfficialUpdateInfo> {
  const metadata = await registryJson(PACKAGE_PATH, signal)
  const tag = channel === 'stable' ? 'latest' : 'next'
  const tagged = metadata['dist-tags']?.[tag]
  if (typeof tagged !== 'string') {
    if (channel === 'prerelease' && typeof metadata['dist-tags']?.latest === 'string' && metadata['dist-tags'].latest.includes('-')) {
      return checkResolved(metadata, metadata['dist-tags'].latest, channel, installedVersions, defaultRuntimeVersion)
    }
    throw new Error(`官方 registry 未发布 ${tag} 通道`)
  }
  return checkResolved(metadata, tagged, channel, installedVersions, defaultRuntimeVersion)
}

function checkResolved(
  metadata: PackageMetadata,
  version: string,
  channel: 'stable' | 'prerelease',
  installedVersions: Set<string>,
  defaultRuntimeVersion: string | undefined,
): OfficialUpdateInfo {
  const selected = metadata.versions?.[version]
  if (!selected) throw new Error('官方 registry 的版本索引不完整')
  return {
    channel,
    ...checkedVersion(selected, version),
    installed: installedVersions.has(version),
    isDefault: defaultRuntimeVersion === version,
  }
}

export const OFFICIAL_REGISTRY_ORIGIN = REGISTRY_ORIGIN
