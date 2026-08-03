/**
 * Real-stack proof for explainable run diagnostics. The router run is created
 * through the public API and executed by the worker; one content-free memory
 * recall event is inserted directly into disposable E2E Postgres because the
 * product intentionally has no endpoint that can forge historical run events.
 */

import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, test, type Locator, type Page } from '@playwright/test'

import { pollUntilTerminal, startRun } from './_helpers/demo-helpers'
import { openWorkspaceSection } from './_helpers/workspace-navigation'

const execFileAsync = promisify(execFile)
const COMPOSE_FILE = fileURLToPath(new URL('../../docker-compose.yml', import.meta.url))
const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR
const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3001'

function installConsoleErrorGuards(page: Page): string[] {
  const errors: string[] = []
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', error => errors.push(error.message))
  return errors
}

async function hideUnrelatedOverlays(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const selector of ['.toast-stack', '.toast', '.we-onboarding-banner', '.we-budget-banner', '[data-testid="command-palette"]']) {
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

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

async function seedMemoryRecallEvent(runId: string, nodeId: string, stamp: string): Promise<void> {
  await execFileAsync('docker', [
    'compose', '-f', COMPOSE_FILE,
    'exec', '-T', 'postgres',
    'psql', '-U', 'postgres', '-d', 'workflow', '-v', 'ON_ERROR_STOP=1',
    '-c', `INSERT INTO run_events (id, run_id, node_id, type, payload, created_at)
      VALUES (
        ${sqlLiteral(`e2e-memory-recall-${stamp}`)},
        ${sqlLiteral(runId)},
        ${sqlLiteral(nodeId)},
        'agent.memory.recalled',
        '{"count":2,"fingerprints":["a1b2c3d4e5f6","0f1e2d3c4b5a"]}'::jsonb,
        now()
      );`,
  ])
}

async function openRunFromHistory(page: Page, runId: string, locale: 'en' | 'es'): Promise<void> {
  await openWorkspaceSection(
    page,
    locale === 'en' ? 'Activity' : 'Actividad',
    locale === 'en' ? 'Runs' : 'Ejecuciones',
  )
  const overviewTab = page.getByTestId('run-workspace-tab-overview')
  if (await overviewTab.isVisible().catch(() => false)) await overviewTab.click()
  const history = page.getByTestId('runs-history-virtual-list')
  await expect(history).toBeVisible()
  const prefix = `${runId.slice(0, 8)}…`
  await expect.poll(() => history.getByRole('article').count()).toBeGreaterThan(0)
  await history.evaluate(element => element.scrollTo({ top: 0 }))
  for (let offset = 0; offset < 100; offset += 4) {
    const card = history.getByRole('article').filter({ hasText: prefix }).first()
    if (await card.isVisible().catch(() => false)) {
      await card.locator('button.list-card-row').click()
      await expect(page.getByTestId('run-overview')).toContainText(runId.slice(0, 12))
      await page.getByTestId('run-overview').getByRole('button', {
        name: locale === 'en' ? 'View timeline' : 'Ver cronología',
        exact: true,
      }).click()
      return
    }
    const reachedEnd = await history.evaluate((element, rowOffset) => {
      element.scrollTo({ top: rowOffset * 156 })
      return element.scrollTop + element.clientHeight >= element.scrollHeight
    }, offset + 4)
    await page.waitForTimeout(50)
    if (reachedEnd) break
  }
  throw new Error(`Run ${runId} was not present in the bounded history page`)
}

async function proveLocale(
  page: Page,
  locale: 'en' | 'es',
  expectedWinner: string,
): Promise<void> {
  const timeline = page.getByTestId('run-event-timeline')
  const diagnostics = page.getByTestId('run-diagnostics')
  await expect(timeline).toBeVisible()
  await expect(diagnostics).toContainText(locale === 'en' ? 'Run diagnostics' : 'Diagnósticos de la ejecución')
  await expect(diagnostics).toContainText(locale === 'en' ? 'Episodes recalled' : 'Episodios recordados')
  await expect(diagnostics).toContainText('2')
  await capture(diagnostics, `web-${locale}-run-diagnostics-default`)

  const filter = timeline.getByTestId('run-event-filter')
  await filter.fill('agent.memory.recalled')
  await expect(timeline.getByRole('listitem')).toHaveCount(1)
  await expect(timeline.getByRole('listitem')).toContainText(locale === 'en'
    ? 'Prior agent episodes influenced this plan: 2'
    : 'Episodios previos influyeron en este plan: 2')
  await capture(timeline.getByRole('listitem'), `web-${locale}-agent-memory-recall-event`)
  await filter.fill('')

  let delayed = true
  await page.route('**/causal?**', async route => {
    if (!delayed) return route.continue()
    delayed = false
    const response = await route.fetch()
    await page.waitForTimeout(650)
    await route.fulfill({ response })
  })
  await timeline.getByRole('button', { name: locale === 'en' ? 'What if?' : '¿Y si…?' }).click()
  const causal = page.getByTestId('causal-analysis')
  await expect(causal).toHaveAttribute('data-state', 'loading')
  await capture(causal, `web-${locale}-causal-loading`)
  await expect(causal).toHaveAttribute('data-state', 'ready')
  await expect(causal).toContainText(expectedWinner)
  await expect(causal.getByRole('list')).toContainText(`1. ${expectedWinner}`)
  await capture(causal, `web-${locale}-causal-result`)
  await page.unroute('**/causal?**')

  await page.route('**/causal?**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ranking: [] }),
  }), { times: 1 })
  await timeline.getByRole('button', { name: locale === 'en' ? 'What if?' : '¿Y si…?' }).click()
  await expect(causal).toHaveAttribute('data-state', 'error')
  await expect(causal).toContainText(locale === 'en' ? 'incomplete result' : 'resultado incompleto')
  await capture(causal, `web-${locale}-causal-error`)
  await page.unroute('**/causal?**')
}

test('run diagnostics expose decisions and content-free memory influence in both locales', async ({ page, request }) => {
  const browserErrors = installConsoleErrorGuards(page)
  const stamp = String(Date.now())
  const routeNodeId = `route_${stamp}`
  const fastNodeId = `fast_${stamp}`
  const safeNodeId = `safe_${stamp}`

  const started = await startRun(request, {
    id: `e2e-explainable-run-${stamp}`,
    name: `E2E Explainable run ${stamp}`,
    nodes: [
      {
        id: routeNodeId,
        type: 'router',
        config: {
          strategy: 'balanced',
          candidates: [
            { nodeId: fastNodeId, avgCost: 0.01, avgLatencyMs: 20, successRate: 0.98 },
            { nodeId: safeNodeId, avgCost: 0.03, avgLatencyMs: 80, successRate: 0.99 },
          ],
        },
      },
      { id: fastNodeId, type: 'noop', config: {} },
      { id: safeNodeId, type: 'noop', config: {} },
    ],
    edges: [
      { from: routeNodeId, to: fastNodeId },
      { from: routeNodeId, to: safeNodeId },
    ],
  }, { source: 'explainability-smoke' })
  const terminal = await pollUntilTerminal(request, started.runId)
  expect(terminal.status).toBe('succeeded')
  const decisionEvent = terminal.events.find(event => event.type === 'decision.made' && event.nodeId === routeNodeId)
  const decisionEventId = typeof decisionEvent?.id === 'string' ? decisionEvent.id : null
  expect(decisionEventId).not.toBeNull()
  await seedMemoryRecallEvent(started.runId, routeNodeId, stamp)

  const causalResponse = await request.get(`${API_URL}/causal?runId=${encodeURIComponent(started.runId)}&eventId=${encodeURIComponent(decisionEventId!)}&nodeId=${encodeURIComponent(routeNodeId)}`, {
    headers: { 'x-org-id': 'default', 'x-user-id': 'dev-user' },
  })
  expect(causalResponse.ok()).toBe(true)
  const causalPayload = await causalResponse.json() as { chosen?: { nodeId?: string }; best?: { nodeId?: string } }
  expect(causalPayload.chosen?.nodeId).toBe(fastNodeId)
  expect(causalPayload.best?.nodeId).toBe(fastNodeId)

  await page.goto('/')
  await hideUnrelatedOverlays(page)
  await openRunFromHistory(page, started.runId, 'en')
  await proveLocale(page, 'en', fastNodeId)

  await page.evaluate(() => window.localStorage.setItem('janusly:locale', 'es'))
  await page.reload()
  await hideUnrelatedOverlays(page)
  await openRunFromHistory(page, started.runId, 'es')
  await proveLocale(page, 'es', fastNodeId)

  expect(browserErrors).toEqual([])
})
