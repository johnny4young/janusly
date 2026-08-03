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
import {
  openRecoveryAutomation,
  openWorkspaceSection,
} from './_helpers/workspace-navigation'

const execFileAsync = promisify(execFile)
const COMPOSE_FILE = fileURLToPath(new URL('../../docker-compose.yml', import.meta.url))
const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR

type LocaleContract = {
  locale: 'en' | 'es'
  homeName: RegExp
  recoverName: string
  applyName: string
  skippedSignature: string
  legacySignature: string
}

const LOCALES: LocaleContract[] = [
  {
    locale: 'en',
    homeName: /^Home\b/,
    recoverName: 'Recover',
    applyName: 'Apply',
    skippedSignature: 'HTTP write validation',
    legacySignature: 'Legacy validation',
  },
  {
    locale: 'es',
    homeName: /^Inicio\b/,
    recoverName: 'Recuperar',
    applyName: 'Aplicar',
    skippedSignature: 'Validación de escritura HTTP',
    legacySignature: 'Validación heredada',
  },
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
  const runValues = days.map((recoveredAt, index) => {
    const createdAt = new Date(recoveredAt.getTime() - (index + 1) * 5 * 60_000)
    return `(
      ${sqlLiteral(`history-run-${suffix}-${index}`)},
      ${sqlLiteral(orgId)},
      ${sqlLiteral(`history-version-${suffix}`)},
      'succeeded',
      ${sqlLiteral(createdAt.toISOString())}::timestamptz
    )`
  }).join(',')
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
    '-c', `INSERT INTO runs (
      id, org_id, workflow_version_id, status, created_at
    ) VALUES ${runValues};
    INSERT INTO dead_letters (
      id, org_id, run_id, node_id, attempt, workflow_json, node_json,
      error_json, status, replayed_at, created_at
    ) VALUES ${values};
    INSERT INTO recovery_impact_events (
      dead_letter_id, org_id, run_id, node_id, user_id, recovered_at, downtime_ended_ms
    ) VALUES ${impactValues};`,
  ])

  return { days: days.map((day) => day.toISOString().slice(0, 10)), ids }
}

async function seedAutoHealingEvidence(
  orgId: string,
  contract: LocaleContract,
): Promise<void> {
  const suffix = orgId.replaceAll(/[^a-zA-Z0-9]/g, '').slice(-24)
  const now = new Date().toISOString()
  await execFileAsync('docker', [
    'compose', '-f', COMPOSE_FILE,
    'exec', '-T', 'postgres',
    'psql', '-U', 'postgres', '-d', 'workflow', '-v', 'ON_ERROR_STOP=1',
    '-c', `INSERT INTO auto_healing_runs (
      id, org_id, dead_letter_id, signature, status, approach_label,
      confidence, validation_evidence_level, loop_attempt_count, created_at, updated_at
    ) VALUES (
      ${sqlLiteral(`healing-skipped-${suffix}`)},
      ${sqlLiteral(orgId)},
      ${sqlLiteral(`dlq-skipped-${suffix}`)},
      ${sqlLiteral(contract.skippedSignature)},
      'validated',
      'add_retry',
      84,
      'writes_skipped',
      1,
      ${sqlLiteral(now)}::timestamptz,
      ${sqlLiteral(now)}::timestamptz
    ), (
      ${sqlLiteral(`healing-legacy-${suffix}`)},
      ${sqlLiteral(orgId)},
      ${sqlLiteral(`dlq-legacy-${suffix}`)},
      ${sqlLiteral(contract.legacySignature)},
      'validated',
      'raise_timeout',
      72,
      NULL,
      1,
      ${sqlLiteral(now)}::timestamptz,
      ${sqlLiteral(now)}::timestamptz
    );`,
  ])
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
  await locator.screenshot({
    path: `${EVIDENCE_DIR}/${name}.png`,
    animations: 'disabled',
    caret: 'hide',
  })
}

test.describe.configure({ mode: 'serial' })

for (const contract of LOCALES) {
  test(`${contract.locale} restores the Recovery Lab entry and drills through real recovery history by keyboard`, async ({ page }) => {
    test.setTimeout(90_000)
    const consoleErrors: string[] = []
    const pageErrors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('pageerror', (error) => pageErrors.push(error.message))

    const sessionOrgId = await prepareSession(page, contract.locale)
    await page.goto('/')
    await page.getByTestId('home-insights-toggle').click()

    const labEntry = page.getByTestId('recovery-lab-entry')
    await expect(labEntry).toBeVisible()
    await labEntry.getByTestId('recovery-lab-entry-dismiss').click()
    await expect(labEntry).toBeHidden()
    expect(await page.evaluate(() => localStorage.getItem('janusly:recovery:hideIntro'))).toBeNull()

    await page.reload()
    await page.getByTestId('home-insights-toggle').click()
    await expect(labEntry).toBeVisible()
    await hideUnrelatedOverlays(page)
    await capture(labEntry, `web-${contract.locale}-recovery-lab-restored`)

    await seedAutoHealingEvidence(sessionOrgId, contract)
    await openWorkspaceSection(
      page,
      contract.locale === 'en' ? 'Activity' : 'Actividad',
      contract.recoverName,
    )
    await openRecoveryAutomation(page)
    const evidenceCard = page.getByTestId('auto-healing-pending-card')
    const skippedCandidate = evidenceCard.locator('li').filter({ hasText: contract.skippedSignature })
    const legacyCandidate = evidenceCard.locator('li').filter({ hasText: contract.legacySignature })
    await expect(skippedCandidate.getByRole('button', { name: contract.applyName })).toBeDisabled()
    await expect(legacyCandidate.getByRole('button', { name: contract.applyName })).toBeDisabled()
    await skippedCandidate.getByRole('checkbox').click()
    await expect(skippedCandidate.getByRole('button', { name: contract.applyName })).toBeEnabled()
    await expect(legacyCandidate.getByRole('button', { name: contract.applyName })).toBeDisabled()
    await hideUnrelatedOverlays(page)
    await capture(evidenceCard, `web-${contract.locale}-auto-healing-evidence-gates`)
    await page.getByRole('button', { name: contract.homeName }).click()

    const historyOrgId = `recovery-history-${contract.locale}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const { days, ids } = await seedRecoveryHistory(historyOrgId)
    await page.evaluate((activeOrg) => {
      localStorage.setItem('janusly:activeOrg', activeOrg)
      localStorage.removeItem('janusly:recovery:hideIntro')
    }, historyOrgId)
    await page.reload()
    await page.getByTestId('home-insights-toggle').click()
    await expect(labEntry).toBeHidden()
    expect(await page.evaluate(() => localStorage.getItem('janusly:recovery:hideIntro'))).toBeNull()

    const metricAction = page.getByTestId('recovery-center-metric-verified-recovery')
    const metricCard = metricAction.locator('..')
    const lastPoint = page.getByTestId('vitals-sparkline-point-2')
    await expect(lastPoint).toHaveAccessibleName(`${days[2]}: 15m`)
    await lastPoint.focus()
    await page.keyboard.press('Home')
    const oldestPoint = page.getByTestId('vitals-sparkline-point-0')
    await expect(oldestPoint).toBeFocused()
    await expect(metricCard.locator('.we-ops-metric-card__value')).toHaveText('10m')
    await hideUnrelatedOverlays(page)
    await capture(metricCard, `web-${contract.locale}-recovery-sparkline-keyboard`)
    await oldestPoint.press('Enter')
    await openWorkspaceSection(
      page,
      contract.locale === 'en' ? 'Activity' : 'Actividad',
      contract.recoverName,
    )

    const queue = page.getByTestId('recovery-queue')
    const dayChip = page.getByTestId('dlq-day-filter-chip')
    await expect(queue).toBeVisible()
    await expect(dayChip).toContainText(days[0] ?? '')
    await page.locator('#dlq-filter').selectOption('all')
    await expect(page.getByTestId(`dlq-row-${ids[0]}`)).toBeVisible()
    await capture(queue, `web-${contract.locale}-recovery-sparkline-drill-in`)

    await page.getByRole('button', { name: contract.homeName }).click()
    await page.getByTestId('home-insights-toggle').click()
    const heatmap = page.getByTestId('recovery-heatmap')
    const latestCell = page.getByTestId(`recovery-heatmap-cell-${days[2]}`)
    const previousDayCell = page.getByTestId(`recovery-heatmap-cell-${days[1]}`)
    // The densified grid renders empty cells before the remounted Home panel's
    // history request settles. Wait for the seeded days to become actionable
    // so Enter proves keyboard drill-in instead of racing the transient shell.
    await expect(latestCell).toHaveAttribute('aria-disabled', 'false')
    await expect(previousDayCell).toHaveAttribute('aria-disabled', 'false')
    await latestCell.focus()
    await page.keyboard.press('ArrowUp')
    await expect(previousDayCell).toBeFocused()
    await hideUnrelatedOverlays(page)
    await capture(heatmap, `web-${contract.locale}-recovery-heatmap-keyboard`)
    await previousDayCell.press('Enter')
    await openWorkspaceSection(
      page,
      contract.locale === 'en' ? 'Activity' : 'Actividad',
      contract.recoverName,
    )
    await expect(queue).toBeVisible()
    await expect(dayChip).toContainText(days[1] ?? '')
    await expect(page.getByTestId(`dlq-row-${ids[1]}`)).toBeVisible()
    await hideUnrelatedOverlays(page)
    await capture(queue, `web-${contract.locale}-recovery-heatmap-drill-in`)

    expect(consoleErrors).toEqual([])
    expect(pageErrors).toEqual([])
  })
}
