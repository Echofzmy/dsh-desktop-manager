import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { launchWebScaffold, seedSession } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const FIXTURE = fileURLToPath(new URL('../../../examples/acp-agent/tests/snapshots/cancel-tool-calls/session.jsonl', import.meta.url))
const SEED_ID = 'bash-abort-row-web-e2e'

const scaffold = await launchWebScaffold({})
await seedSession(scaffold, await readFile(FIXTURE, 'utf8'), SEED_ID)
const browser = await chromium.launch()
const page = await newEnglishPage(browser)
await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
const groupRow = page.locator('[role="treeitem"]').first()
await groupRow.waitFor({ timeout: 15_000 })
await groupRow.click()
const sessionRow = page.locator('[role="treeitem"]').nth(1)
await sessionRow.waitFor({ timeout: 10_000 })
await sessionRow.click()
await page.locator('[data-sample="bash"]').nth(1).waitFor({ timeout: 15_000 })

const bashRows = page.locator('[data-sample="bash"]')
const n = await bashRows.count()
console.log('BASH_ROWS', n)
for (let i = 0; i < n; i++) {
  const r = bashRows.nth(i)
  console.log(JSON.stringify({
    i,
    'data-state': await r.getAttribute('data-state'),
    'data-expandable': await r.getAttribute('data-expandable'),
    'aria-expanded': await r.getAttribute('aria-expanded'),
    role: await r.getAttribute('role'),
    title: (await r.textContent() || '').slice(0, 80),
  }))
}
await page.getByRole('tab', { name: 'Trajectory' }).click()
const toolRows = page.locator('tr[data-kind="tool"]')
await toolRows.first().waitFor({ timeout: 10_000 })
const rows = await toolRows.evaluateAll(rs => rs.map(r => ({
  aria: r.getAttribute('aria-label'),
  'data-error': r.getAttribute('data-error'),
  'data-running': r.getAttribute('data-running'),
})))
console.log('LEDGER_ROWS', rows.length)
console.log(JSON.stringify(rows, null, 1))
await browser.close()
await scaffold.close()
