import { createHash } from 'node:crypto'
import { cp, mkdir, opendir, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

const OMIT = new Set(['files.sha256', 'install-receipt.json', 'READY'])

async function collect(root, current = root) {
  const entries = []
  for await (const entry of await opendir(current)) entries.push(entry)
  const groups = await Promise.all(entries.map(async entry => {
    const absolute = join(current, entry.name)
    const path = relative(root, absolute)
    if (OMIT.has(path)) return []
    if (entry.isDirectory()) return collect(root, absolute)
    if (entry.isFile()) return [{ path, type: 'file', absolute }]
    if (entry.isSymbolicLink()) {
      const target = await readlink(absolute)
      const canonical = await realpath(resolve(dirname(absolute), target))
      const fromRoot = relative(root, canonical)
      if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) throw new Error(`Packaged runtime symlink escapes root: ${path}`)
      return [{ path, type: 'symlink', sha256: createHash('sha256').update(target).digest('hex'), size: Buffer.byteLength(target) }]
    }
    throw new Error(`Unsupported packaged runtime file: ${path}`)
  }))
  return groups.flat()
}

async function materialize(entries) {
  const result = []
  for (let index = 0; index < entries.length; index += 256) {
    result.push(...await Promise.all(entries.slice(index, index + 256).map(async entry => {
      if (entry.type === 'symlink') return { path: entry.path, type: entry.type, size: entry.size, sha256: entry.sha256 }
      const content = await readFile(entry.absolute)
      return { path: entry.path, type: entry.type, size: content.length, sha256: createHash('sha256').update(content).digest('hex') }
    })))
  }
  return result
}

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appName = `${context.packager.appInfo.productFilename}.app`
  const root = join(context.appOutDir, appName, 'Contents', 'Resources', 'runtimes', 'official', 'bundled', 'current')
  const source = join(context.packager.projectDir, 'build', 'bundled-runtime')
  await rm(root, { recursive: true, force: true })
  await mkdir(dirname(root), { recursive: true, mode: 0o700 })
  await cp(source, root, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true })
  const receipt = JSON.parse(await readFile(join(root, 'install-receipt.json'), 'utf8'))
  const runtimePackage = JSON.parse(await readFile(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'))
  if (receipt.schema !== 1 || receipt.package !== '@deepseek-ai/dsh' || receipt.source !== 'bundled' || receipt.version !== runtimePackage.version || receipt.platform !== process.platform || receipt.arch !== process.arch) throw new Error('Packaged bundled runtime receipt identity is invalid')
  const files = (await materialize(await collect(root))).sort((left, right) => left.path.localeCompare(right.path))
  const manifest = `${JSON.stringify({ version: 1, files }, null, 2)}\n`
  const digest = createHash('sha256').update(manifest).digest('hex')
  await writeFile(join(root, 'files.sha256'), manifest, { mode: 0o600 })
  await writeFile(join(root, 'install-receipt.json'), `${JSON.stringify({ ...receipt, manifestDigest: digest, files: files.length }, null, 2)}\n`, { mode: 0o600 })
  await writeFile(join(root, 'READY'), `${digest}\n`, { mode: 0o600 })
  console.log(`Packaged bundled DSH ${receipt.version} with ${files.length} verified files`)
}
