// Web e2e scenario: a cancelled Bash call can settle without terminal-card
// material. Borrow the real cancellation fixture and prove the keyed Bash row
// still exposes the recorded command and full error without any model call.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../examples/acp-agent/tests/snapshots/cancel-tool-calls/session.jsonl', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/bash-abort-row', import.meta.url))
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const TRAJECTORY_EXPECTED = join(SNAPSHOT_DIR, 'trajectory.expected.md')
const MODE = webSnapshotMode()
const SEED_ID = 'bash-abort-row-web-e2e'
const PROMPT = 'Run two shell commands: wait for cancellation, then write skipped.txt.'

describe.skipIf(MODE === 'record')('web e2e: cancelled Bash row disclosure', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    const fixture = await readFile(FIXTURE, 'utf8')
    expect(fixtureUserPrompts(fixture)).toEqual([PROMPT])
    scaffold = await launchWebScaffold({})
    await seedSession(scaffold, fixture, SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })

    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    await page.locator('[data-sample="bash"]').nth(1).waitFor({ timeout: 15_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('expands a stopped aborted row to its command and full stop text', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-bash-abort-row'))
    const row = page.locator('[data-sample="bash"]').first()
    const call = row.locator('xpath=..')
    // The aborted call settles `stopped` (not a failure): collapsed, the row
    // keeps its args-derived summary — the stop text is hidden until expanded.
    await expect.poll(() => row.getAttribute('data-state')).toBe('stopped')
    await expect.poll(() => row.getAttribute('aria-expanded')).toBe('false')
    // The stopped outcome is visible in the collapsed summary; the full
    // recorded command and output remain behind the disclosure.
    await expect.poll(() => call.getByText('Error: tool call aborted', { exact: true }).count()).toBe(1)
    await row.click()

    await expect.poll(() => row.getAttribute('aria-expanded')).toBe('true')
    await call.getByText('IN', { exact: true }).waitFor()
    await call.getByText('OUT', { exact: true }).waitFor()
    await call.getByText('Wait until cancellation', { exact: false }).last().waitFor()
    await call.getByText('setInterval(() => {}, 1000)', { exact: false }).waitFor()
    // Expanded, the stop text remains visible in the OUT section and the
    // stopped row carries no red marker.
    await expect.poll(() => call.getByText('Error: tool call aborted', { exact: true }).count()).toBe(2)
    await expect.poll(() => call.locator('[data-error="true"]').count()).toBe(0)

    const snapshot = (await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd))
      // The borrowed fixture's UTC date is still the previous day in PDT;
      // the disclosure golden must not depend on the runner timezone.
      .replace(/\b\d{1,2}\/\d{1,2}(?= \{\{clock\}\})/g, '{{date}}')
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it('marks both aborted bash records Stopped — never Failed — in the Trajectory ledger', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-bash-abort-row-trajectory'))
    await page.getByRole('tab', { name: 'Trajectory' }).click()

    // Both fixture AbortError codes are terminal stopped outcomes.
    const toolRows = page.locator('tr[data-kind="tool"]')
    await expect.poll(() => toolRows.count(), { timeout: 15_000 }).toBe(2)
    const rowAriaLabels = await toolRows.evaluateAll(rows => rows.map(row => row.getAttribute('aria-label') ?? ''))
    for (const label of rowAriaLabels) {
      expect(label).toMatch(/, Stopped$/)
      expect(label).not.toContain('Failed')
    }
    expect(rowAriaLabels.join('\n')).not.toContain('Failed')
    await expect.poll(() => page.locator('tr[data-kind="tool"][data-error="true"]').count(), { timeout: 5_000 }).toBe(0)
    await expect.poll(() => page.locator('tr[data-kind="tool"][data-running="true"]').count(), { timeout: 5_000 }).toBe(0)

    const snapshot = (await captureStableAria(page, '[class*="viewArea"]', scaffold.workspaceCwd))
      // Same timezone drift as the disclosure golden: the fixture's UTC date is still the previous day in PDT.
      .replace(/\b\d{1,2}\/\d{1,2}(?= \{\{clock\}\})/g, '{{date}}')
      .split(SEED_ID).join('{{seededId}}')
    await compareOrRefreshGolden(TRAJECTORY_EXPECTED, snapshot, MODE)
  }, 60_000)

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md', 'trajectory.expected.md'])
  })
})
