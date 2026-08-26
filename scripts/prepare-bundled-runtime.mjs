import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, opendir, readFile, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const project = JSON.parse(await readFile(join(projectRoot, 'package.json'), 'utf8'))
const version = project.dshBundledVersion
if (typeof version !== 'string') throw new Error('package.json dshBundledVersion is required')
const target = join(projectRoot, 'build', 'bundled-runtime')
function isPackagingExcluded(path) {
  return path === 'node_modules/.package-lock.json' || path === 'node_modules/.bin' || path.startsWith('node_modules/.bin/')
}
function validateLock(lock) {
  const locked = lock.packages?.['node_modules/@deepseek-ai/dsh']
  if (locked?.version !== version || typeof locked.integrity !== 'string' || !locked.integrity.startsWith('sha512-')) throw new Error('Bundled runtime lock identity or integrity is invalid')
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!path) continue
    if (typeof entry.resolved !== 'string') throw new Error(`Bundled dependency has no fixed archive URL: ${path}`)
    const resolved = new URL(entry.resolved)
    if (resolved.protocol !== 'https:' || resolved.origin !== 'https://registry.npmjs.org') throw new Error(`Bundled dependency escaped the fixed registry: ${path}`)
    if (typeof entry.integrity !== 'string' || !entry.integrity.startsWith('sha512-')) throw new Error(`Bundled dependency has no sha512 integrity: ${path}`)
  }
  return locked
}
try {
  const receipt = JSON.parse(await readFile(join(target, 'install-receipt.json'), 'utf8'))
  const ready = (await readFile(join(target, 'READY'), 'utf8')).trim()
  const manifestText = await readFile(join(target, 'files.sha256'), 'utf8')
  validateLock(JSON.parse(await readFile(join(target, 'package-lock.json'), 'utf8')))
  const manifest = JSON.parse(manifestText)
  const manifestDigest = createHash('sha256').update(manifestText).digest('hex')
  console.log(`Verifying bundled DSH ${version} file tree...`)
  const pendingFiles = await collect(target)
  console.log(`Hashing ${pendingFiles.length} bundled files...`)
  const actualFull = (await digestEntries(pendingFiles)).sort((a, b) => a.path.localeCompare(b.path))
  const actualFiltered = actualFull.filter(file => !isPackagingExcluded(file.path))
  const canonicalManifestFiles = manifest.files.map(file => ({ path: file.path, type: file.type, size: file.size, sha256: file.sha256 }))
  const matchesFull = JSON.stringify(canonicalManifestFiles) === JSON.stringify(actualFull)
  const matchesFiltered = JSON.stringify(canonicalManifestFiles) === JSON.stringify(actualFiltered)
  if (receipt.version === version && receipt.platform === process.platform && receipt.arch === process.arch && receipt.manifestDigest === manifestDigest && ready === manifestDigest && receipt.files === manifest.files.length && (matchesFull || matchesFiltered)) {
    if (manifest.version !== 1 || !matchesFull || JSON.stringify(manifest.files) !== JSON.stringify(actualFull)) {
      const migratedText = `${JSON.stringify({ version: 1, files: actualFull }, null, 2)}\n`
      const migratedDigest = createHash('sha256').update(migratedText).digest('hex')
      await writeFile(join(target, 'files.sha256'), migratedText)
      await writeFile(join(target, 'install-receipt.json'), `${JSON.stringify({ ...receipt, manifestDigest: migratedDigest, files: actualFull.length }, null, 2)}\n`)
      await writeFile(join(target, 'READY'), `${migratedDigest}\n`)
    }
    console.log(`Bundled DSH ${version} is ready`)
    process.exit(0)
  }
} catch {}

const staging = `${target}.staging-${process.pid}`
await rm(staging, { recursive: true, force: true })
await mkdir(staging, { recursive: true, mode: 0o700 })
await writeFile(join(staging, 'package.json'), `${JSON.stringify({ private: true, name: 'dsh-bundled-runtime', version: '1.0.0' }, null, 2)}\n`)
const installHome = join(staging, '.installer-home')
const cache = join(staging, '.npm-cache')
const userConfig = join(installHome, '.npmrc')
await mkdir(installHome, { recursive: true, mode: 0o700 })
await mkdir(cache, { recursive: true, mode: 0o700 })
await writeFile(userConfig, 'registry=https://registry.npmjs.org\naudit=false\nfund=false\nignore-scripts=true\n', { mode: 0o600 })
const require = createRequire(import.meta.url)
const npmCli = join(dirname(require.resolve('npm')), 'bin', 'npm-cli.js')
const env = {
  PATH: process.env.PATH,
  TMPDIR: process.env.TMPDIR,
  HOME: installHome,
  npm_config_cache: cache,
  npm_config_userconfig: userConfig,
  npm_config_globalconfig: join(installHome, 'empty-global-npmrc'),
  npm_config_registry: 'https://registry.npmjs.org',
  npm_config_audit: 'false',
  npm_config_fund: 'false',
  npm_config_ignore_scripts: 'true',
}
await writeFile(env.npm_config_globalconfig, '', { mode: 0o600 })
await new Promise((resolvePromise, reject) => {
  const child = spawn(process.execPath, [npmCli, 'install', '--save-exact', '--package-lock=true', '--ignore-scripts=true', '--audit=false', '--fund=false', '--registry=https://registry.npmjs.org', `--userconfig=${userConfig}`, `@deepseek-ai/dsh@${version}`], { cwd: staging, env, stdio: 'inherit' })
  child.once('error', reject)
  child.once('exit', code => code === 0 ? resolvePromise() : reject(new Error(`npm install exited with ${code}`)))
})
const runtimePackage = JSON.parse(await readFile(join(staging, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'))
const lock = JSON.parse(await readFile(join(staging, 'package-lock.json'), 'utf8'))
const locked = validateLock(lock)
if (runtimePackage.name !== '@deepseek-ai/dsh' || runtimePackage.version !== version || locked.version !== version) throw new Error('Bundled runtime identity is invalid')
await rm(installHome, { recursive: true, force: true })
await rm(cache, { recursive: true, force: true })

async function digestEntries(files) {
  const result = []
  for (let index = 0; index < files.length; index += 256) {
    const batch = files.slice(index, index + 256)
    result.push(...await Promise.all(batch.map(async file => {
      if (file.type !== 'file') return { path: file.path, type: file.type, size: file.size, sha256: file.sha256 }
      const content = await readFile(file.absolute)
      return { path: file.path, type: file.type, size: content.length, sha256: createHash('sha256').update(content).digest('hex') }
    })))
  }
  return result
}

async function collect(root, current = root) {
  const directoryEntries = []
  for await (const entry of await opendir(current)) directoryEntries.push(entry)
  const groups = await Promise.all(directoryEntries.map(async entry => {
    const absolute = join(current, entry.name)
    const path = relative(root, absolute)
    if (['files.sha256', 'install-receipt.json', 'READY'].includes(path)) return []
    if (entry.isDirectory()) return collect(root, absolute)
    if (entry.isFile()) return [{ path, type: 'file', absolute }]
    if (entry.isSymbolicLink()) {
      const targetPath = await readlink(absolute)
      const resolvedTarget = await realpath(resolve(dirname(absolute), targetPath))
      const fromRoot = relative(root, resolvedTarget)
      if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) throw new Error(`Bundled runtime symlink escapes root: ${path}`)
      return [{ path, type: 'symlink', sha256: createHash('sha256').update(targetPath).digest('hex'), size: Buffer.byteLength(targetPath) }]
    }
    throw new Error(`Unsupported bundled runtime file: ${path}`)
  }))
  return groups.flat()
}
const files = (await digestEntries(await collect(staging))).sort((a, b) => a.path.localeCompare(b.path))
const manifest = `${JSON.stringify({ version: 1, files }, null, 2)}\n`
const manifestDigest = createHash('sha256').update(manifest).digest('hex')
await writeFile(join(staging, 'files.sha256'), manifest)
await writeFile(join(staging, 'install-receipt.json'), `${JSON.stringify({ schema: 1, package: '@deepseek-ai/dsh', version, source: 'bundled', registry: 'https://registry.npmjs.org', rootIntegrity: locked.integrity, manifestDigest, files: files.length, nodeVersion: process.versions.node, platform: process.platform, arch: process.arch, installedAt: new Date().toISOString() }, null, 2)}\n`)
await writeFile(join(staging, 'READY'), `${manifestDigest}\n`)
await rm(target, { recursive: true, force: true })
await rename(staging, target)
console.log(`Prepared bundled DSH ${version} with ${files.length} files`)
