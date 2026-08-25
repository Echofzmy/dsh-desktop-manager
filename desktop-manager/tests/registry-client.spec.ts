import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkOfficialUpdate, resolveOfficialVersion } from '../src/main/runtime/registry-client.js'

afterEach(() => vi.unstubAllGlobals())

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
}

describe('official registry client', () => {
  it('resolves the fixed latest channel with strict integrity metadata', async () => {
    const fetchMock = vi.fn(async () => response({
      'dist-tags': { latest: '1.2.3' },
      versions: {
        '1.2.3': {
          name: '@deepseek-ai/dsh', version: '1.2.3',
          dist: { integrity: `sha512-${Buffer.alloc(64).toString('base64')}`, tarball: 'https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-1.2.3.tgz', unpackedSize: 1000 },
        },
      },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const update = await checkOfficialUpdate('stable', new Set(), undefined)
    expect(update).toMatchObject({ version: '1.2.3', installed: false, isDefault: false, unpackedSize: 1000 })
    expect(fetchMock).toHaveBeenCalledWith('https://registry.npmjs.org/@deepseek-ai%2Fdsh', expect.objectContaining({ redirect: 'error' }))
  })

  it('rejects exact metadata whose tarball escapes the fixed registry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({
      name: '@deepseek-ai/dsh', version: '1.2.3',
      dist: { integrity: `sha512-${Buffer.alloc(64).toString('base64')}`, tarball: 'https://example.invalid/dsh.tgz' },
    })))
    await expect(resolveOfficialVersion('1.2.3')).rejects.toThrow('固定 npm registry')
  })

  it('rejects malformed versions before network access', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(resolveOfficialVersion('../latest')).rejects.toThrow('版本号格式')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
