/**
 * Real-stack proof for durable Recovery impact. Historical rows are seeded
 * directly into the disposable E2E Postgres because product routes correctly
 * refuse caller-supplied timestamps and actor identities.
 */

import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'

const execFileAsync = promisify(execFile)
const COMPOSE_FILE = fileURLToPath(new URL('../../../docker-compose.yml', import.meta.url))
const API_URL = process.env.E2E_API_URL ?? 'http://127.0.0.1:3001'
const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

async function seedImpact(orgId: string): Promise<void> {
  const suffix = orgId.replaceAll(/[^a-zA-Z0-9]/g, '').slice(-24)
  const now = Date.now()
  const records = [
    { key: 'recent-a', org: orgId, user: 'dev-user', recoveredAt: now - 2 * 86_400_000, durationMs: 60 * 60_000 },
    { key: 'recent-b', org: orgId, user: 'dev-user', recoveredAt: now - 86_400_000, durationMs: 120 * 60_000 },
    { key: 'other-user', org: orgId, user: 'other-user', recoveredAt: now - 86_400_000, durationMs: 15 * 60_000 },
    { key: 'old', org: orgId, user: 'dev-user', recoveredAt: now - 45 * 86_400_000, durationMs: 5 * 60_000 },
    { key: 'other-org', org: `${orgId}-other`, user: 'dev-user', recoveredAt: now - 86_400_000, durationMs: 30 * 60_000 },
  ]
  const failed = {
    key: 'failed-attempt', org: orgId, user: 'dev-user',
    recoveredAt: now - 86_400_000, durationMs: 90 * 60_000,
  }
  const allRecords = [...records, failed]
  const deadLetterValues = allRecords.map((record) => `(
    ${sqlLiteral(`impact-dlq-${suffix}-${record.key}`)},
    ${sqlLiteral(record.org)},
    ${sqlLiteral(`impact-run-${suffix}-${record.key}`)},
    ${sqlLiteral(`impact-node-${record.key}`)},
    1,
    '{"name":"Recovery impact"}'::jsonb,
    '{"type":"http"}'::jsonb,
    '{"message":"Recovered fixture"}'::jsonb,
    'replayed',
    ${sqlLiteral(new Date(record.recoveredAt - 1_000).toISOString())}::timestamptz,
    ${sqlLiteral(new Date(record.recoveredAt - record.durationMs).toISOString())}::timestamptz
  )`).join(',')
  const runValues = allRecords.map((record) => `(
    ${sqlLiteral(`impact-run-${suffix}-${record.key}`)},
    ${sqlLiteral(record.org)},
    ${sqlLiteral(`impact-version-${suffix}-${record.key}`)},
    ${sqlLiteral(record === failed ? 'failed' : 'succeeded')},
    ${sqlLiteral(record.user)},
    ${sqlLiteral(new Date(record.recoveredAt - record.durationMs).toISOString())}::timestamptz
  )`).join(',')
  const nodeValues = allRecords.map((record) => `(
    ${sqlLiteral(`impact-run-node-${suffix}-${record.key}`)},
    ${sqlLiteral(`impact-run-${suffix}-${record.key}`)},
    ${sqlLiteral(`impact-node-${record.key}`)},
    ${sqlLiteral(record === failed ? 'failed' : 'succeeded')},
    1,
    ${sqlLiteral(new Date(record.recoveredAt).toISOString())}::timestamptz,
    ${sqlLiteral(`impact-dlq-${suffix}-${record.key}`)},
    ${sqlLiteral(record.user)}
  )`).join(',')
  const impactValues = records.map((record) => `(
    ${sqlLiteral(`impact-dlq-${suffix}-${record.key}`)},
    ${sqlLiteral(record.org)},
    ${sqlLiteral(`impact-run-${suffix}-${record.key}`)},
    ${sqlLiteral(`impact-node-${record.key}`)},
    ${sqlLiteral(record.user)},
    ${sqlLiteral(new Date(record.recoveredAt).toISOString())}::timestamptz,
    ${record.durationMs}
  )`).join(',')
  const firstRecoveredAt = new Date(Math.min(...records.filter((record) => record.org === orgId).map((record) => record.recoveredAt)))

  await execFileAsync('docker', [
    'compose', '-f', COMPOSE_FILE,
    'exec', '-T', 'postgres',
    'psql', '-U', 'postgres', '-d', 'workflow', '-v', 'ON_ERROR_STOP=1',
    '-c', `
      INSERT INTO runs (id, org_id, workflow_version_id, status, created_by, created_at)
      VALUES ${runValues};
      INSERT INTO run_nodes (
        id, run_id, node_id, status, attempts, finished_at,
        recovery_dead_letter_id, recovery_requested_by
      ) VALUES ${nodeValues};
      INSERT INTO dead_letters (
        id, org_id, run_id, node_id, attempt, workflow_json, node_json,
        error_json, status, replayed_at, created_at
      ) VALUES ${deadLetterValues};
      INSERT INTO recovery_impact_events (
        dead_letter_id, org_id, run_id, node_id, user_id, recovered_at, downtime_ended_ms
      ) VALUES ${impactValues};
      INSERT INTO recovery_impact_rollups (
        org_id, total_recovered, downtime_ended_ms, first_recovered_at, updated_at
      ) VALUES (
        ${sqlLiteral(orgId)}, 4, 12000000,
        ${sqlLiteral(firstRecoveredAt.toISOString())}::timestamptz,
        ${sqlLiteral(new Date(now).toISOString())}::timestamptz
      ), (
        ${sqlLiteral(`${orgId}-other`)}, 1, 1800000,
        ${sqlLiteral(new Date(now - 86_400_000).toISOString())}::timestamptz,
        ${sqlLiteral(new Date(now).toISOString())}::timestamptz
      );
    `,
  ])
}

type BackgroundImpactFixture = {
  deadLetterId: string
  runId: string
  nodeId: string
  recoveredAtIso: string
  durationMs: number
}

async function seedPendingBackgroundRecovery(orgId: string): Promise<BackgroundImpactFixture> {
  const suffix = `${orgId.replaceAll(/[^a-zA-Z0-9]/g, '').slice(-18)}-${Date.now()}`
  const deadLetterId = `impact-dlq-${suffix}-background`
  const runId = `impact-run-${suffix}-background`
  const nodeId = `impact-node-${suffix}-background`
  const recoveredAt = new Date()
  const durationMs = 10 * 60_000

  await execFileAsync('docker', [
    'compose', '-f', COMPOSE_FILE,
    'exec', '-T', 'postgres',
    'psql', '-U', 'postgres', '-d', 'workflow', '-v', 'ON_ERROR_STOP=1',
    '-c', `
      INSERT INTO runs (id, org_id, workflow_version_id, status, created_by, created_at)
      VALUES (
        ${sqlLiteral(runId)}, ${sqlLiteral(orgId)}, ${sqlLiteral(`${runId}-version`)},
        'failed', 'dev-user',
        ${sqlLiteral(new Date(recoveredAt.getTime() - durationMs).toISOString())}::timestamptz
      );
      INSERT INTO run_nodes (
        id, run_id, node_id, status, attempts, finished_at
      ) VALUES (
        ${sqlLiteral(`${runId}-node`)}, ${sqlLiteral(runId)}, ${sqlLiteral(nodeId)},
        'failed', 1, ${sqlLiteral(new Date(recoveredAt.getTime() - durationMs + 1_000).toISOString())}::timestamptz
      );
      INSERT INTO dead_letters (
        id, org_id, run_id, node_id, attempt, workflow_json, node_json,
        error_json, status, replayed_at, created_at
      ) VALUES (
        ${sqlLiteral(deadLetterId)}, ${sqlLiteral(orgId)}, ${sqlLiteral(runId)},
        ${sqlLiteral(nodeId)}, 1, '{"name":"Background recovery"}'::jsonb,
        '{"type":"noop"}'::jsonb, '{"message":"Recovered fixture"}'::jsonb,
        'open', NULL,
        ${sqlLiteral(new Date(recoveredAt.getTime() - durationMs).toISOString())}::timestamptz
      );
    `,
  ])

  return { deadLetterId, runId, nodeId, recoveredAtIso: recoveredAt.toISOString(), durationMs }
}

async function completeBackgroundRecovery(orgId: string, fixture: BackgroundImpactFixture): Promise<void> {
  await execFileAsync('docker', [
    'compose', '-f', COMPOSE_FILE,
    'exec', '-T', 'postgres',
    'psql', '-U', 'postgres', '-d', 'workflow', '-v', 'ON_ERROR_STOP=1',
    '-c', `
      UPDATE runs SET status = 'succeeded' WHERE id = ${sqlLiteral(fixture.runId)};
      UPDATE run_nodes
      SET status = 'succeeded',
          finished_at = ${sqlLiteral(fixture.recoveredAtIso)}::timestamptz,
          recovery_dead_letter_id = ${sqlLiteral(fixture.deadLetterId)},
          recovery_requested_by = 'dev-user'
      WHERE run_id = ${sqlLiteral(fixture.runId)} AND node_id = ${sqlLiteral(fixture.nodeId)};
      UPDATE dead_letters
      SET status = 'replayed', replayed_at = ${sqlLiteral(fixture.recoveredAtIso)}::timestamptz
      WHERE id = ${sqlLiteral(fixture.deadLetterId)} AND org_id = ${sqlLiteral(orgId)};
      INSERT INTO recovery_impact_events (
        dead_letter_id, org_id, run_id, node_id, user_id, recovered_at, downtime_ended_ms
      ) VALUES (
        ${sqlLiteral(fixture.deadLetterId)}, ${sqlLiteral(orgId)}, ${sqlLiteral(fixture.runId)},
        ${sqlLiteral(fixture.nodeId)}, 'dev-user',
        ${sqlLiteral(fixture.recoveredAtIso)}::timestamptz, ${fixture.durationMs}
      );
      UPDATE recovery_impact_rollups
      SET total_recovered = total_recovered + 1,
          downtime_ended_ms = downtime_ended_ms + ${fixture.durationMs},
          updated_at = ${sqlLiteral(fixture.recoveredAtIso)}::timestamptz
      WHERE org_id = ${sqlLiteral(orgId)};
    `,
  ])
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

async function waitForHealthRingToSettle(hero: Locator): Promise<void> {
  const ring = hero.locator('.we-recovery-center-ring')
  await expect(ring).toBeVisible()
  const score = (await ring.getAttribute('aria-label'))?.match(/\d+/)?.[0]
  if (score) await expect(ring.locator('.we-recovery-center-ring__value')).toHaveText(score)
}

async function getV1(
  request: APIRequestContext,
  orgId: string,
  path: string,
): Promise<Record<string, unknown>> {
  const response = await request.get(`${API_URL}/v1${path}`, {
    headers: { 'x-org-id': orgId, 'x-user-id': 'dev-user' },
  })
  if (!response.ok()) throw new Error(`${path} failed: ${response.status()} ${await response.text()}`)
  return response.json() as Promise<Record<string, unknown>>
}

test('Recovery impact is tenant-safe, personal, localized, and visible in focused UI evidence', async ({ page, request }) => {
  test.setTimeout(90_000)
  const orgId = `recovery-impact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  const recoveryReadResponses: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))
  page.on('response', (response) => {
    const url = new URL(response.url())
    if (url.pathname === '/recovery/home' && url.searchParams.get('scope') === 'impact') {
      recoveryReadResponses.push(response.url())
    }
  })

  await seedImpact(orgId)

  expect(await getV1(request, orgId, '/recovery/ledger')).toMatchObject({
    apiVersion: 'v1',
    data: { totalRecovered: 4, downtimeEndedMs: 12_000_000 },
  })
  expect(await getV1(request, orgId, '/recovery/my-wins?days=30')).toMatchObject({
    apiVersion: 'v1',
    data: { recovered: 2, windowDays: 30 },
  })

  await prepareSession(page, orgId)
  await page.goto('/')
  const hero = page.locator('.we-recovery-center-hero')
  const valueDashboard = page.locator('.we-recovery-center-value')
  await expect(hero.getByTestId('recovery-center-personal-wins')).toHaveText(
    'You recovered 2 failures in the last 30 days',
  )
  await expect(valueDashboard.getByTestId('recovery-lifetime-ledger')).toHaveText(
    'Since day one: 4 failures recovered · 3h 20m of downtime ended',
  )
  await waitForHealthRingToSettle(hero)
  await hideUnrelatedOverlays(page)
  await capture(hero, 'web-en-recovery-personal-wins-default')
  await capture(valueDashboard, 'web-en-recovery-lifetime-ledger-default')

  await page.evaluate(() => window.localStorage.setItem('janusly:locale', 'es'))
  await page.reload()
  await expect(hero.getByTestId('recovery-center-personal-wins')).toHaveText(
    'Recuperaste 2 fallos en los últimos 30 días',
  )
  await expect(valueDashboard.getByTestId('recovery-lifetime-ledger')).toHaveText(
    'Desde el primer día: 4 fallos recuperados · 3h 20m de inactividad terminada',
  )
  await waitForHealthRingToSettle(hero)
  await hideUnrelatedOverlays(page)
  await capture(hero, 'web-es-recovery-personal-wins-default')
  await capture(valueDashboard, 'web-es-recovery-lifetime-ledger-default')

  // Load one still-open failure into the bootstrap page, then complete it
  // without navigation, reload, or platformVersion mutation. The later
  // authoritative count must retire that stale local row while the impact
  // poll surfaces the worker-owned terminal fact.
  const backgroundImpact = await seedPendingBackgroundRecovery(orgId)
  await page.reload()
  await expect(page.getByTestId('recovery-center-metric-failures')).toContainText('1')
  const readsBeforeCompletion = recoveryReadResponses.length
  await completeBackgroundRecovery(orgId, backgroundImpact)
  expect(await getV1(request, orgId, '/recovery/ledger')).toMatchObject({
    data: { totalRecovered: 5, downtimeEndedMs: 12_600_000 },
  })
  expect(await getV1(request, orgId, '/recovery/my-wins?days=30')).toMatchObject({
    data: { recovered: 3, windowDays: 30 },
  })
  await expect.poll(
    () => recoveryReadResponses.length,
    { timeout: 15_000 },
  ).toBeGreaterThan(readsBeforeCompletion)
  await expect(hero.getByTestId('recovery-center-greeting')).toHaveText(
    'Todo en orden',
    { timeout: 15_000 },
  )
  await expect(valueDashboard.getByTestId('recovery-lifetime-ledger')).toHaveText(
    'Desde el primer día: 5 fallos recuperados · 3h 30m de inactividad terminada',
  )
  await hideUnrelatedOverlays(page)
  await capture(hero, 'web-es-recovery-background-impact-all-clear')
  await capture(valueDashboard, 'web-es-recovery-background-impact-polled')

  expect(consoleErrors).toEqual([])
  expect(pageErrors).toEqual([])
})
