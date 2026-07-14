/**
 * Real-stack keyboard and persistence proof for Recovery Center exploration.
 * History rows are seeded directly into the disposable E2E Postgres because
 * the product API intentionally cannot forge historical recovery timestamps.
 */

import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, test, type Locator, type Page } from '@playwright/test'

const execFileAsync = promisify(execFile)
const COMPOSE_FILE = fileURLToPath(new URL('../../../docker-compose.yml', import.meta.url))
const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR

type LocaleContract = {
  locale: 'en' | 'es'
  homeName: RegExp
}

const LOCALES: LocaleContract[] = [
  { locale: 'en', homeName: /^Home\b/ },
  { locale: 'es', homeName: /^Inicio\b/ },
]

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function historicalMidday(daysAgo: number): Date {
  const now = new Date()
  return new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - daysAgo - 1,
    12,
  ))
}

async function seedRecoveryHistory(orgId: string): Promise<{ days: string[]; ids: string[] }> {
  const suffix = orgId.replaceAll(/[^a-zA-Z0-9]/g, '').slice(-24)
  const days = [2, 1, 0].map(historicalMidday)
  const ids = days.map((_, index) => `history-${suffix}-${index}`)
  const values = days.map((replayedAt, index) => {
    const createdAt = new Date(replayedAt.getTime() - (index + 1) * 5 * 60_000)
    return `(
      ${sqlLiteral(ids[index] ?? '')},
      ${sqlLiteral(orgId)},
      ${sqlLiteral(`history-run-${suffix}-${index}`)},
      ${sqlLiteral(`history-node-${index}`)},
      1,
      '{"name":"Recovery history"}'::jsonb,
      '{"type":"http"}'::jsonb,
      '{"message":"Recovered fixture"}'::jsonb,
      'replayed',
      ${sqlLiteral(replayedAt.toISOString())}::timestamptz,
      ${sqlLiteral(createdAt.toISOString())}::timestamptz
    )`
  }).join(',')
  const impactValues = days.map((recoveredAt, index) => `(
    ${sqlLiteral(ids[index] ?? '')},
    ${sqlLiteral(orgId)},
    ${sqlLiteral(`history-run-${suffix}-${index}`)},
    ${sqlLiteral(`history-node-${index}`)},
    'dev-user',
    ${sqlLiteral(recoveredAt.toISOString())}::timestamptz,
    ${(index + 1) * 5 * 60_000}
  )`).join(',')

  await execFileAsync('docker', [
    'compose', '-f', COMPOSE_FILE,
    'exec', '-T', 'postgres',
    'psql', '-U', 'postgres', '-d', 'workflow', '-v', 'ON_ERROR_STOP=1',
    '-c', `INSERT INTO dead_letters (
      id, org_id, run_id, node_id, attempt, workflow_json, node_json,
      error_json, status, replayed_at, created_at
    ) VALUES ${values};
    INSERT INTO recovery_impact_events (
      dead_letter_id, org_id, run_id, node_id, user_id, recovered_at, downtime_ended_ms
    ) VALUES ${impactValues};`,
  ])

  return { days: days.map((day) => day.toISOString().slice(0, 10)), ids }
}

async function prepareSession(page: Page, locale: 'en' | 'es'): Promise<string> {
  const orgId = `recovery-exploration-${locale}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await page.addInitScript(({ activeOrg, selectedLocale }) => {
    const preparedKey = 'janusly:e2e:recovery-exploration-prepared'
    if (!window.localStorage.getItem('janusly:activeOrg')) {
      window.localStorage.setItem('janusly:activeOrg', activeOrg)
    }
    window.localStorage.setItem('janusly:locale', selectedLocale)
    if (window.sessionStorage.getItem(preparedKey) !== 'true') {
      window.localStorage.removeItem('janusly:recovery:hideIntro')
      window.sessionStorage.setItem(preparedKey, 'true')
    }
  }, { activeOrg: orgId, selectedLocale: locale })
  return orgId
}

async function hideUnrelatedOverlays(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const selector of ['.toast', '.we-onboarding-banner', '.we-budget-banner', '[data-testid="command-palette"]']) {
      for (const element of document.querySelectorAll<HTMLElement>(selector)) element.style.display = 'none'
    }
  })
}

async function capture(locator: Locator, name: string): Promise<void> {
  await expect(locator).toBeVisible()
  if (!EVIDENCE_DIR) return
  await mkdir(EVIDENCE_DIR, { recursive: true })
  await locator.screenshot({ path: `${EVIDENCE_DIR}/${name}.png` })
}

test.describe.configure({ mode: 'serial' })

for (const contract of LOCALES) {
  test(`${contract.locale} restores the fresh demo and drills through real recovery history by keyboard`, async ({ page }) => {
    test.setTimeout(90_000)
    const consoleErrors: string[] = []
    const pageErrors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('pageerror', (error) => pageErrors.push(error.message))

    await prepareSession(page, contract.locale)
    await page.goto('/')

    const demo = page.getByTestId('recovery-flow-demo')
    await expect(demo).toBeVisible()
    await demo.getByTestId('recovery-flow-demo-dismiss').click()
    await expect(demo).toBeHidden()
    expect(await page.evaluate(() => localStorage.getItem('janusly:recovery:hideIntro'))).toBeNull()

    await page.reload()
    await expect(demo).toBeVisible()
    await hideUnrelatedOverlays(page)
    await capture(demo, `web-${contract.locale}-recovery-demo-restored`)

    const historyOrgId = `recovery-history-${contract.locale}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const { days, ids } = await seedRecoveryHistory(historyOrgId)
    await page.evaluate((activeOrg) => {
      localStorage.setItem('janusly:activeOrg', activeOrg)
      localStorage.removeItem('janusly:recovery:hideIntro')
    }, historyOrgId)
    await page.reload()
    await expect(demo).toBeVisible()
    await demo.getByTestId('recovery-flow-demo-dismiss').click()
    expect(await page.evaluate(() => localStorage.getItem('janusly:recovery:hideIntro'))).toBeNull()

    const metricAction = page.getByTestId('recovery-center-metric-mttr')
    const metricCard = metricAction.locator('..')
    const lastPoint = page.getByTestId('vitals-sparkline-point-2')
    await expect(lastPoint).toHaveAccessibleName(`${days[2]}: 15m`)
    await lastPoint.focus()
    await page.keyboard.press('Home')
    const oldestPoint = page.getByTestId('vitals-sparkline-point-0')
    await expect(oldestPoint).toBeFocused()
    await hideUnrelatedOverlays(page)
    await capture(metricCard, `web-${contract.locale}-recovery-sparkline-keyboard`)
    await oldestPoint.press('Enter')

    const queue = page.getByTestId('recovery-queue')
    const dayChip = page.getByTestId('dlq-day-filter-chip')
    await expect(queue).toBeVisible()
    await expect(dayChip).toContainText(days[0] ?? '')
    await page.locator('#dlq-filter').selectOption('all')
    await expect(page.getByTestId(`dlq-row-${ids[0]}`)).toBeVisible()
    await capture(queue, `web-${contract.locale}-recovery-sparkline-drill-in`)

    await page.getByRole('button', { name: contract.homeName }).click()
    const heatmap = page.getByTestId('recovery-heatmap')
    const latestCell = page.getByTestId(`recovery-heatmap-cell-${days[2]}`)
    await latestCell.focus()
    await page.keyboard.press('ArrowUp')
    const previousDayCell = page.getByTestId(`recovery-heatmap-cell-${days[1]}`)
    await expect(previousDayCell).toBeFocused()
    await hideUnrelatedOverlays(page)
    await capture(heatmap, `web-${contract.locale}-recovery-heatmap-keyboard`)
    await previousDayCell.press('Enter')
    await expect(queue).toBeVisible()
    await expect(dayChip).toContainText(days[1] ?? '')
    await expect(page.getByTestId(`dlq-row-${ids[1]}`)).toBeVisible()
    await hideUnrelatedOverlays(page)
    await capture(queue, `web-${contract.locale}-recovery-heatmap-drill-in`)

    expect(consoleErrors).toEqual([])
    expect(pageErrors).toEqual([])
  })
}
