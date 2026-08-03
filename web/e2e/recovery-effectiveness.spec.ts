/** Real-stack and bilingual UI proof for recovery reaction time and fix durability. */

import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { normalizeErrorSignature } from '../src/lib/error-signature.ts'

const execFileAsync = promisify(execFile)
const COMPOSE_FILE = fileURLToPath(new URL('../../docker-compose.yml', import.meta.url))
const API_URL = process.env.E2E_API_URL ?? 'http://127.0.0.1:3001'
const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR
const DAY_MS = 24 * 60 * 60 * 1000

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

async function seedEffectiveness(orgId: string): Promise<{ recurrentSignature: string }> {
  const suffix = orgId.replaceAll(/[^a-zA-Z0-9]/g, '').slice(-24)
  const now = Date.now()
  const firstActionCreatedAt = new Date(now - 2 * 60 * 60_000)
  const recurringRecoveredAt = new Date(now - 5 * DAY_MS)
  const heldRecoveredAt = new Date(now - 4 * DAY_MS)
  const recurringOccurredAt = new Date(recurringRecoveredAt.getTime() + DAY_MS)
  const recurringError = { message: 'Connection refused by payments upstream' }
  const heldError = { message: 'Malformed JSON from invoices upstream' }
  const recurrentSignature = normalizeErrorSignature(recurringError, { nodeType: 'http' }).signature
  const heldSignature = normalizeErrorSignature(heldError, { nodeType: 'http' }).signature

  const records = [
    { key: 'first-action-item', createdAt: firstActionCreatedAt, status: 'replayed', error: { message: 'Reaction timer item fixture' } },
    { key: 'first-action-no-item', createdAt: firstActionCreatedAt, status: 'replayed', error: { message: 'Reaction timer replay fixture' } },
    { key: 'recurring-base', createdAt: new Date(recurringRecoveredAt.getTime() - 60_000), status: 'replayed', error: recurringError },
    { key: 'recurring-later', createdAt: recurringOccurredAt, status: 'open', error: recurringError },
    { key: 'held-base', createdAt: new Date(heldRecoveredAt.getTime() - 60_000), status: 'replayed', error: heldError },
  ]
  const runValues = records.map((record) => `(
    ${sqlLiteral(`effectiveness-run-${suffix}-${record.key}`)},
    ${sqlLiteral(orgId)},
    ${sqlLiteral(`effectiveness-version-${suffix}-${record.key}`)},
    ${sqlLiteral(record.status === 'open' ? 'failed' : 'succeeded')},
    'dev-user',
    ${sqlLiteral(record.createdAt.toISOString())}::timestamptz
  )`).join(',')
  const dlqValues = records.map((record) => {
    const replayClaimedAt = record.key === 'first-action-no-item'
      ? new Date(firstActionCreatedAt.getTime() + 180_000)
      : null
    const replayedAt = record.status === 'replayed'
      ? new Date(record.createdAt.getTime() + (record.key === 'first-action-no-item' ? 181_000 : 60_000))
      : null
    return `(
      ${sqlLiteral(`effectiveness-dlq-${suffix}-${record.key}`)},
      ${sqlLiteral(orgId)},
      ${sqlLiteral(`effectiveness-run-${suffix}-${record.key}`)},
      ${sqlLiteral(`effectiveness-node-${record.key}`)},
      1,
      '{"id":"effectiveness-workflow","name":"Effectiveness proof","nodes":[],"edges":[]}'::jsonb,
      '{"id":"step-1","type":"http","config":{}}'::jsonb,
      ${sqlLiteral(JSON.stringify(record.error))}::jsonb,
      ${sqlLiteral(record.status)},
      ${replayClaimedAt ? `${sqlLiteral(replayClaimedAt.toISOString())}::timestamptz` : 'NULL'},
      ${replayedAt ? `${sqlLiteral(replayedAt.toISOString())}::timestamptz` : 'NULL'},
      ${sqlLiteral(record.createdAt.toISOString())}::timestamptz
    )`
  }).join(',')

  await execFileAsync('docker', [
    'compose', '-f', COMPOSE_FILE,
    'exec', '-T', 'postgres',
    'psql', '-U', 'postgres', '-d', 'workflow', '-v', 'ON_ERROR_STOP=1',
    '-c', `
      INSERT INTO runs (id, org_id, workflow_version_id, status, created_by, created_at)
      VALUES ${runValues};
      INSERT INTO dead_letters (
        id, org_id, run_id, node_id, attempt, workflow_json, node_json,
        error_json, status, replay_claimed_at, replayed_at, created_at
      ) VALUES ${dlqValues};
      INSERT INTO recovery_items (
        id, org_id, dead_letter_id, workflow_id, status, sla_target_at,
        resolved_at, first_action_at, error_signature, first_occurred_at,
        last_occurred_at, created_at, updated_at
      ) VALUES (
        ${sqlLiteral(`effectiveness-item-${suffix}-first-action`)},
        ${sqlLiteral(orgId)},
        ${sqlLiteral(`effectiveness-dlq-${suffix}-first-action-item`)},
        'effectiveness-workflow', 'acknowledged',
        ${sqlLiteral(new Date(now + DAY_MS).toISOString())}::timestamptz,
        NULL,
        ${sqlLiteral(new Date(firstActionCreatedAt.getTime() + 60_000).toISOString())}::timestamptz,
        'reaction-timer-item',
        ${sqlLiteral(firstActionCreatedAt.toISOString())}::timestamptz,
        ${sqlLiteral(firstActionCreatedAt.toISOString())}::timestamptz,
        ${sqlLiteral(firstActionCreatedAt.toISOString())}::timestamptz,
        ${sqlLiteral(firstActionCreatedAt.toISOString())}::timestamptz
      ), (
        ${sqlLiteral(`effectiveness-item-${suffix}-recurring-base`)},
        ${sqlLiteral(orgId)},
        ${sqlLiteral(`effectiveness-dlq-${suffix}-recurring-base`)},
        'effectiveness-workflow', 'resolved',
        ${sqlLiteral(recurringRecoveredAt.toISOString())}::timestamptz,
        ${sqlLiteral(recurringRecoveredAt.toISOString())}::timestamptz,
        NULL, ${sqlLiteral(recurrentSignature)},
        ${sqlLiteral(new Date(recurringRecoveredAt.getTime() - 60_000).toISOString())}::timestamptz,
        ${sqlLiteral(new Date(recurringRecoveredAt.getTime() - 60_000).toISOString())}::timestamptz,
        ${sqlLiteral(new Date(recurringRecoveredAt.getTime() - 60_000).toISOString())}::timestamptz,
        ${sqlLiteral(recurringRecoveredAt.toISOString())}::timestamptz
      ), (
        ${sqlLiteral(`effectiveness-item-${suffix}-recurring-later`)},
        ${sqlLiteral(orgId)},
        ${sqlLiteral(`effectiveness-dlq-${suffix}-recurring-later`)},
        'effectiveness-workflow', 'open',
        ${sqlLiteral(new Date(recurringOccurredAt.getTime() + DAY_MS).toISOString())}::timestamptz,
        NULL, NULL, ${sqlLiteral(recurrentSignature)},
        ${sqlLiteral(recurringOccurredAt.toISOString())}::timestamptz,
        ${sqlLiteral(recurringOccurredAt.toISOString())}::timestamptz,
        ${sqlLiteral(recurringOccurredAt.toISOString())}::timestamptz,
        ${sqlLiteral(recurringOccurredAt.toISOString())}::timestamptz
      ), (
        ${sqlLiteral(`effectiveness-item-${suffix}-held-base`)},
        ${sqlLiteral(orgId)},
        ${sqlLiteral(`effectiveness-dlq-${suffix}-held-base`)},
        'effectiveness-workflow', 'resolved',
        ${sqlLiteral(heldRecoveredAt.toISOString())}::timestamptz,
        ${sqlLiteral(heldRecoveredAt.toISOString())}::timestamptz,
        NULL, ${sqlLiteral(heldSignature)},
        ${sqlLiteral(new Date(heldRecoveredAt.getTime() - 60_000).toISOString())}::timestamptz,
        ${sqlLiteral(new Date(heldRecoveredAt.getTime() - 60_000).toISOString())}::timestamptz,
        ${sqlLiteral(new Date(heldRecoveredAt.getTime() - 60_000).toISOString())}::timestamptz,
        ${sqlLiteral(heldRecoveredAt.toISOString())}::timestamptz
      );
      INSERT INTO recovery_impact_events (
        dead_letter_id, org_id, run_id, node_id, user_id, recovered_at, downtime_ended_ms
      ) VALUES (
        ${sqlLiteral(`effectiveness-dlq-${suffix}-recurring-base`)},
        ${sqlLiteral(orgId)},
        ${sqlLiteral(`effectiveness-run-${suffix}-recurring-base`)},
        'effectiveness-node-recurring-base', 'dev-user',
        ${sqlLiteral(recurringRecoveredAt.toISOString())}::timestamptz, 60000
      ), (
        ${sqlLiteral(`effectiveness-dlq-${suffix}-held-base`)},
        ${sqlLiteral(orgId)},
        ${sqlLiteral(`effectiveness-run-${suffix}-held-base`)},
        'effectiveness-node-held-base', 'dev-user',
        ${sqlLiteral(heldRecoveredAt.toISOString())}::timestamptz, 60000
      );
    `,
  ])

  return { recurrentSignature }
}

async function prepareSession(page: Page, orgId: string): Promise<void> {
  await page.addInitScript((activeOrg) => {
    window.localStorage.setItem('janusly:activeOrg', activeOrg)
    if (!window.localStorage.getItem('janusly:locale')) {
      window.localStorage.setItem('janusly:locale', 'en')
    }
    window.localStorage.setItem('janusly:recovery:hideIntro', 'true')
  }, orgId)
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

async function getMetrics(request: APIRequestContext, orgId: string): Promise<Record<string, unknown>> {
  const response = await request.get(`${API_URL}/v1/recovery/metrics?windowDays=30`, {
    headers: { 'x-org-id': orgId, 'x-user-id': 'dev-user' },
  })
  if (!response.ok()) throw new Error(`metrics failed: ${response.status()} ${await response.text()}`)
  return response.json() as Promise<Record<string, unknown>>
}

test('Recovery effectiveness is measured and shown in English and Spanish', async ({ page, request }) => {
  test.setTimeout(90_000)
  const orgId = `recovery-effectiveness-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))

  const { recurrentSignature } = await seedEffectiveness(orgId)
  expect(await getMetrics(request, orgId)).toMatchObject({
    apiVersion: 'v1',
    data: {
      timeToFirstAction: { value: 120, display: '2m', severity: 'healthy' },
      recurrenceRate: { value: 50, display: '50.0%', severity: 'unhealthy' },
    },
  })

  await prepareSession(page, orgId)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await page.getByTestId('home-insights-toggle').click()
  const metricStrip = page.getByTestId('recovery-center-metric-strip')
  const clusterTile = page.getByTestId('recovery-center-tile-clusters')
  await expect(page.getByTestId('recovery-center-metric-first-action')).toContainText('Time to first action')
  await expect(page.getByTestId('recovery-center-metric-first-action')).toContainText('2m')
  await expect(page.getByTestId('recovery-center-metric-durability')).toContainText('Fixes that held')
  await expect(page.getByTestId('recovery-center-metric-durability')).toContainText('50.0%')
  await expect(clusterTile).toContainText(recurrentSignature)
  await expect(clusterTile).toContainText('Re-failed after fix')
  await hideUnrelatedOverlays(page)
  await capture(metricStrip, 'web-en-recovery-effectiveness-metrics-default')
  await capture(clusterTile, 'web-en-recovery-recurrence-cluster-warning')

  await page.evaluate(() => window.localStorage.setItem('janusly:locale', 'es'))
  await page.reload()
  await page.getByTestId('home-insights-toggle').click()
  await expect(page.getByTestId('recovery-center-metric-first-action')).toContainText('Tiempo hasta la primera acción')
  await expect(page.getByTestId('recovery-center-metric-durability')).toContainText('Correcciones que se mantienen')
  await expect(clusterTile).toContainText('Falló tras corregirse')
  await hideUnrelatedOverlays(page)
  await capture(metricStrip, 'web-es-recovery-effectiveness-metrics-default')
  await capture(clusterTile, 'web-es-recovery-recurrence-cluster-warning')

  expect(consoleErrors).toEqual([])
  expect(pageErrors).toEqual([])
})
