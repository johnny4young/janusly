/**
 * Real-stack acceptance for the unified Runs workspace.
 *
 * Both scenarios create genuine worker runs in isolated organizations, then
 * prove that overview, chronology, and agent evidence stay inside the primary
 * Runs destination without browser errors or horizontal overflow.
 */

import { mkdir } from 'node:fs/promises'
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test'
import { openWorkspaceSection } from './_helpers/workspace-navigation'

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3001'
const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR

type Json = Record<string, unknown>
type Locale = 'en' | 'es'
type RunSnapshot = {
  run: { status: string }
  events: Array<{ id: string; type: string; payload?: Json }>
}

function authHeaders(orgId: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-org-id': orgId,
    'x-user-id': 'dev-user',
  }
}

async function startRun(
  request: APIRequestContext,
  orgId: string,
  workflow: Json,
): Promise<string> {
  const response = await request.post(`${API_URL}/start`, {
    headers: authHeaders(orgId),
    data: workflow,
  })
  if (!response.ok()) throw new Error(`POST /start failed: ${response.status()} ${await response.text()}`)
  return ((await response.json()) as { runId: string }).runId
}

async function getRun(
  request: APIRequestContext,
  orgId: string,
  runId: string,
): Promise<RunSnapshot> {
  const response = await request.get(`${API_URL}/run?runId=${encodeURIComponent(runId)}`, {
    headers: authHeaders(orgId),
  })
  if (!response.ok()) throw new Error(`GET /run failed: ${response.status()} ${await response.text()}`)
  return response.json() as Promise<RunSnapshot>
}

async function pollUntilTerminal(
  request: APIRequestContext,
  orgId: string,
  runId: string,
): Promise<RunSnapshot> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 30_000) {
    const snapshot = await getRun(request, orgId, runId)
    if (['succeeded', 'failed', 'cancelled'].includes(snapshot.run.status)) return snapshot
    await new Promise(resolve => setTimeout(resolve, 400))
  }
  throw new Error(`Run ${runId} did not reach a terminal state`)
}

function installBrowserErrorGuards(page: Page): string[] {
  const errors: string[] = []
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  page.on('pageerror', error => errors.push(`page: ${error.message}`))
  page.on('response', response => {
    const kind = response.request().resourceType()
    if (response.status() >= 400 && (kind === 'fetch' || kind === 'xhr')) {
      errors.push(`http ${response.status()}: ${response.request().method()} ${response.url()}`)
    }
  })
  return errors
}

async function setBrowserContext(page: Page, orgId: string, locale: Locale): Promise<void> {
  await page.addInitScript(({ activeOrg, initialLocale }) => {
    window.localStorage.setItem('janusly:activeOrg', activeOrg)
    window.localStorage.setItem('janusly:locale', initialLocale)
  }, { activeOrg: orgId, initialLocale: locale })
}

async function hideUnrelatedOverlays(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const selector of ['.toast-stack', '.we-onboarding-banner', '.we-budget-banner']) {
      for (const element of document.querySelectorAll<HTMLElement>(selector)) {
        element.style.display = 'none'
      }
    }
  })
}

async function openRun(page: Page, runId: string, locale: Locale): Promise<void> {
  await openWorkspaceSection(
    page,
    locale === 'en' ? 'Activity' : 'Actividad',
    locale === 'en' ? 'Runs' : 'Ejecuciones',
  )
  const history = page.getByTestId('runs-history-virtual-list')
  await expect(history).toBeVisible()
  const prefix = `${runId.slice(0, 8)}…`
  await expect.poll(() => history.getByRole('article').count()).toBeGreaterThan(0)
  const row = history.getByRole('article').filter({ hasText: prefix }).first()
  await expect(row).toBeVisible()
  await row.locator('button.list-card-row').click()
  await expect(page.getByTestId('run-overview')).toContainText(runId.slice(0, 12))
}

async function capture(page: Page, name: string): Promise<void> {
  if (!EVIDENCE_DIR) return
  await mkdir(EVIDENCE_DIR, { recursive: true })
  await page.screenshot({ path: `${EVIDENCE_DIR}/${name}.png` })
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => (
    document.documentElement.scrollWidth - document.documentElement.clientWidth
  ))
  expect(overflow).toBeLessThanOrEqual(2)
}

test('English desktop keeps failed-run chronology inside Runs', async ({ page, request }) => {
  const stamp = Date.now()
  const orgId = `run-workspace-en-${stamp}`
  const browserErrors = installBrowserErrorGuards(page)
  const runId = await startRun(request, orgId, {
    id: `run-workspace-failure-${stamp}`,
    name: 'Run workspace failure evidence',
    nodes: [{
      id: 'resolve_secret',
      type: 'transform',
      config: { mapping: { token: '{{secret.RUN_WORKSPACE_E2E_MISSING}}' } },
    }],
    edges: [],
  })
  const terminal = await pollUntilTerminal(request, orgId, runId)
  expect(terminal.run.status).toBe('failed')

  await setBrowserContext(page, orgId, 'en')
  await page.goto('/')
  await hideUnrelatedOverlays(page)
  await openRun(page, runId, 'en')
  await page.getByTestId('run-workspace-tab-timeline').click()

  const workspace = page.getByTestId('run-workspace')
  const timeline = page.getByTestId('run-event-timeline')
  await expect(workspace).toBeVisible()
  await expect(page.getByTestId('run-workspace-tab-timeline')).toHaveAttribute('aria-selected', 'true')
  await expect(timeline).toBeVisible()
  await expect(timeline.locator('article.we-run-event')).not.toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Open full timeline' })).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await workspace.scrollIntoViewIfNeeded()
  await capture(page, 'web-en-run-workspace-timeline')
  expect(browserErrors).toEqual([])
})

test('Spanish mobile shows deterministic multi-agent evidence inside Runs', async ({ page, request }) => {
  const stamp = Date.now()
  const orgId = `run-workspace-es-${stamp}`
  const browserErrors = installBrowserErrorGuards(page)
  const runId = await startRun(request, orgId, {
    id: `run-workspace-agents-${stamp}`,
    name: 'Evidencia multiagente',
    nodes: [{
      id: 'review_team',
      type: 'multi_agent',
      config: {
        mode: 'sequential',
        aggregation: 'all',
        planner: 'rules',
        maxSteps: 1,
        reflection: true,
        agents: [
          { name: 'Analista', goal: 'Uppercase the invoice state', value: 'pending' },
          { name: 'Revisor', goal: 'Uppercase the review decision', value: 'approved' },
        ],
      },
    }],
    edges: [],
  })
  const terminal = await pollUntilTerminal(request, orgId, runId)
  expect(terminal.run.status).toBe('succeeded')
  expect(terminal.events.some(event => event.type === 'multi_agent.completed')).toBe(true)

  await page.setViewportSize({ width: 390, height: 1000 })
  await setBrowserContext(page, orgId, 'es')
  await page.goto('/')
  await hideUnrelatedOverlays(page)
  await openRun(page, runId, 'es')
  await page.getByTestId('run-workspace-tab-agents').click()

  const workspace = page.getByTestId('run-workspace')
  const agentsPanel = page.getByTestId('run-workspace-panel-agents')
  const agentsHeading = agentsPanel.getByRole('heading', { name: 'Cronología multiagente', exact: true })
  await expect(workspace).toBeVisible()
  await expect(page.getByTestId('run-workspace-tab-agents')).toHaveAttribute('aria-selected', 'true')
  await expect(agentsHeading).toHaveCount(1)
  await expect(agentsHeading).toBeVisible()
  await expect(agentsPanel).toContainText('Analista')
  await expect(agentsPanel).toContainText('Revisor')
  await expect(page.getByRole('button', { name: 'Abrir vista completa de agentes' })).toBeVisible()
  await expectNoHorizontalOverflow(page)
  await workspace.scrollIntoViewIfNeeded()
  await capture(page, 'web-es-run-workspace-agents-mobile')
  expect(browserErrors).toEqual([])
})
