// Web e2e scenario: the sidebar Files mode over the real workspace.browse
// wire — switching from Sessions to Files, the lazy directory expansion, the
// hidden-file default and reveal, and the file row dispatching host.openPath
// (observed host-side by wrapping the apiProxy's openPath, so no native
// opener ever runs). Zero model calls: browsing and opening are host RPCs
// with no model involvement; the one Workspace comes from the in-app add flow
// over a staged directory.
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type {} from '@deepseek-ai/dsh-host-apiproxy'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/workspace-files', import.meta.url))
const FILES_TREE_EXPECTED = join(SNAPSHOT_DIR, 'files-tree.expected.md')
const MODE = webSnapshotMode()

describe('web e2e: workspace Files mode (browse tree over the real wire)', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  /** Absolute paths the browser handed to host.openPath, in click order. */
  let openedPaths: string[]
  /** Workspace-rooted relativePaths the host browsed, in request order ('' = root). */
  let browsePaths: string[]

  /**
   * Raise the region header's directory dialog and drive it to a directory via
   * the path-edit affordance (same flow as workspace-management).
   */
  async function browseTo(path: string): Promise<Locator> {
    await page.getByRole('button', { name: 'Add workspace' }).click()
    const dialog = page.getByRole('dialog', { name: 'Select Workspace Directory' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: 'Edit path' }).click()
    const pathInput = dialog.locator('input[aria-label="Edit path"]')
    await pathInput.fill(path)
    await pathInput.press('Enter')
    return dialog
  }

  /** Adopt an existing directory, waiting for the registration to settle host-side. */
  async function adoptDirectory(path: string): Promise<void> {
    const dialog = await browseTo(path)
    await dialog.getByRole('button', { name: 'Open', exact: true }).click()
    await dialog.waitFor({ state: 'hidden', timeout: 10_000 })
    // `expect.poll` is test-scoped, so this hook polls by hand.
    const deadline = Date.now() + 10_000
    for (;;) {
      if (scaffold.ctx.workspaceRegistry.resolveByPath(path) !== undefined) break
      if (Date.now() > deadline) throw new Error(`workspace at "${path}" never registered`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    // Stage the Workspace directory before adoption so the tree has
    // directories, files, and one hidden entry to assert against.
    const project = join(scaffold.workspaceCwd, 'project-files')
    await mkdir(join(project, 'src', 'lib'), { recursive: true })
    await writeFile(join(project, 'src', 'index.ts'), 'export const x = 1\n')
    await writeFile(join(project, 'src', 'lib', 'helper.ts'), 'export const y = 2\n')
    await writeFile(join(project, 'README.md'), '# Project\n')
    await writeFile(join(project, '.env'), 'SECRET=1\n')

    // Observe host.openPath without ever handing a path to a native opener:
    // the RPC dispatch reads apiProxy.host.openPath at call time, so a
    // recording wrapper replaces the platform opener for this scenario. The
    // browse face is wrapped to record the exact level scans, so the lazy
    // cache contract is asserted over the real wire.
    openedPaths = []
    browsePaths = []
    const apiProxy = scaffold.ctx.apiProxy
    apiProxy.host.openPath = (request, _signal) => {
      openedPaths.push(request.payload.path)
      return Promise.resolve({ rpcId: request.rpcId, result: { ok: true, value: { opened: true } } })
    }
    const realBrowse = apiProxy.workspace.browse
    apiProxy.workspace.browse = (request, signal) => {
      browsePaths.push(request.payload.relativePath ?? '')
      return realBrowse(request, signal)
    }

    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    // Adopt the staged directory through the in-app flow; the New Session it
    // starts makes the project the current Session's Workspace.
    await adoptDirectory(project)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('switches to Files, expands a directory lazily, and opens a file through host.openPath', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-ws-files'))
    // The mode switch replaces the old section label; Sessions is the default.
    await expect.poll(
      () => page.getByRole('button', { name: 'Sessions', pressed: true }).count(),
      { timeout: 10_000 },
    ).toBe(1)
    await page.getByRole('button', { name: 'Files' }).click()
    await expect.poll(
      () => page.getByRole('button', { name: 'Files', pressed: true }).count(),
      { timeout: 10_000 },
    ).toBe(1)
    // The file tree resolves the adopted Workspace and persists the mode.
    expect(await page.evaluate(() => localStorage.getItem('dsh.workspace.view.v6')))
      .toContain('"mode":"files"')

    // Root loads when Files is selected: directories first (src before the
    // README file), and the hidden dotfile stays hidden by default.
    const tree = page.getByRole('tree', { name: 'Files tree' })
    await expect.poll(async () => tree.locator('[role="treeitem"]').count(), { timeout: 10_000 }).toBe(2)
    expect(await tree.locator('[role="treeitem"]').nth(0).textContent()).toBe('src')
    expect(await tree.locator('[role="treeitem"]').nth(1).textContent()).toBe('README.md')
    expect(await page.getByText('.env', { exact: true }).count()).toBe(0)

    // First expansion loads the child level; a second collapse/reopen must
    // reuse the cache — the host saw exactly root + one src scan.
    const srcRow = tree.locator('[role="treeitem"]').nth(0)
    await srcRow.click()
    await expect.poll(async () => tree.locator('[role="treeitem"]').count(), { timeout: 10_000 }).toBe(4)
    expect(await srcRow.getAttribute('aria-expanded')).toBe('true')
    expect(await tree.locator('[role="treeitem"]').nth(1).textContent()).toBe('lib')
    expect(await tree.locator('[role="treeitem"]').nth(2).textContent()).toBe('index.ts')
    await srcRow.click()
    await expect.poll(async () => tree.locator('[role="treeitem"]').count(), { timeout: 10_000 }).toBe(2)
    await srcRow.click()
    await expect.poll(async () => tree.locator('[role="treeitem"]').count(), { timeout: 10_000 }).toBe(4)
    expect(browsePaths).toEqual(['', 'src'])

    // A file row click dispatches host.openPath with the absolute path.
    await tree.locator('[role="treeitem"]').filter({ hasText: 'index.ts' }).click()
    await expect.poll(() => openedPaths, { timeout: 10_000 }).toEqual([join(scaffold.workspaceCwd, 'project-files', 'src', 'index.ts')])

    // The hidden toggle reveals the dotfile.
    await page.getByRole('button', { name: 'Show hidden files' }).click()
    await expect.poll(() => page.getByText('.env', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('matches the files-tree aria golden at the expanded tree', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-ws-files-golden'))
    const snapshot = await captureStableAria(page, '[role="tree"][aria-label="Files tree"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(FILES_TREE_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('issued zero model calls and stayed clean', async () => {
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['.gitkeep', 'files-tree.expected.md'])
  })
})
