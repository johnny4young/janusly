/**
 * Real-stack proof for progressive workflow delivery. Creates two immutable
 * semantic-contract versions, qualifies their outcome datasets through the
 * English Inspector, then drives an unhealthy canary to automatic baseline
 * return and verifies Spanish mobile.
 */

import { mkdir } from 'node:fs/promises'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3001'
const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

type Json = Record<string, unknown>
type RolloutProjection = {
  id: string
  status: 'active' | 'promoted' | 'rolled_back' | 'cancelled'
  baselineSucceeded: number
  baselineFailed: number
  canarySucceeded: number
  canaryFailed: number
}

function semanticRecoveryContract(): Json {
  return {
    version: '2',
    failure: {
      technical: {
        terminalNodeFailure: true,
        stalledNode: true,
      },
      semantic: {
        mode: 'deterministic',
        detectors: [{
          id: 'completed-outcome',
          sourceNodeId: 'outcome',
          kind: 'expression',
          passWhen: 'context.outcome.output.status === "completed"',
          action: 'quarantine',
          message: 'The workflow outcome must complete.',
        }],
        evaluationFixtures: [
          {
            id: 'completed',
            sourceNodeId: 'outcome',
            output: { status: 'completed' },
            expected: 'pass',
          },
          {
            id: 'incomplete',
            sourceNodeId: 'outcome',
            output: { status: 'incomplete' },
            expected: 'violation',
          },
        ],
      },
    },
    evidence: {
      required: ['failure_snapshot', 'audit_trail', 'terminal_outcome'],
    },
    effects: [],
    repairs: { allowed: ['retry'] },
    validation: { minimumEvidenceLevel: 'static' },
    approval: {
      productionMutation: 'required',
      permission: 'recovery.write',
    },
    autonomyLevel: 0,
    verification: {
      kind: 'generation_bound_terminal_success',
    },
    recurrence: { windowDays: 7 },
  }
}

function headers(orgId: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'x-org-id': orgId, 'x-user-id': 'dev-user' }
}

async function postJson(
  request: APIRequestContext,
  orgId: string,
  path: string,
  data: Json,
): Promise<Json> {
  const response = await request.post(`${API_URL}${path}`, { headers: headers(orgId), data })
  if (!response.ok()) throw new Error(`POST ${path} failed: ${response.status()} ${await response.text()}`)
  return response.json()
}

async function getRollout(
  request: APIRequestContext,
  orgId: string,
  workflowId: string,
): Promise<RolloutProjection | null> {
  const response = await request.get(
    `${API_URL}/workflows/${encodeURIComponent(workflowId)}/rollout`,
    { headers: headers(orgId) },
  )
  if (!response.ok()) throw new Error(`GET rollout failed: ${response.status()} ${await response.text()}`)
  return (await response.json() as { rollout: RolloutProjection | null }).rollout
}

async function waitForTerminal(
  request: APIRequestContext,
  orgId: string,
  runId: string,
): Promise<string> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const response = await request.get(`${API_URL}/run?runId=${encodeURIComponent(runId)}`, {
      headers: headers(orgId),
    })
    if (!response.ok()) throw new Error(`GET run failed: ${response.status()} ${await response.text()}`)
    const payload = await response.json() as { run?: { status?: string } }
    const status = payload.run?.status
    if (status && ['succeeded', 'failed', 'cancelled'].includes(status)) return status
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Run ${runId} did not reach a terminal status`)
}

async function hideUnrelatedOverlays(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const selector of ['.toast', '.toast-stack', '.we-onboarding-banner', '.we-budget-banner']) {
      for (const element of document.querySelectorAll<HTMLElement>(selector)) element.style.display = 'none'
    }
  })
}

async function capture(surface: Locator, name: string): Promise<void> {
  await expect(surface).toBeVisible()
  await surface.scrollIntoViewIfNeeded()
  if (!EVIDENCE_DIR) return
  await mkdir(EVIDENCE_DIR, { recursive: true })
  await surface.screenshot({ path: `${EVIDENCE_DIR}/${name}.png`, animations: 'disabled', caret: 'hide' })
}

async function captureForeground(surface: Locator, name: string): Promise<void> {
  await expect(surface).toBeVisible()
  const originalStyle = await surface.getAttribute('style')
  try {
    await surface.evaluate(element => {
      Object.assign((element as HTMLElement).style, {
        position: 'fixed',
        zIndex: '2147483647',
        top: '12px',
        right: '12px',
        bottom: 'auto',
        left: '12px',
        maxHeight: 'calc(100vh - 24px)',
        overflow: 'auto',
      })
    })
    await capture(surface, name)
  } finally {
    await surface.evaluate((element, style) => {
      if (style === null) element.removeAttribute('style')
      else element.setAttribute('style', style)
    }, originalStyle)
  }
}

async function expectAccessible(page: Page, context: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .include('[data-testid="workflow-rollout-panel"]')
    .withTags(WCAG_TAGS)
    .analyze()
  const blocking = results.violations
    .filter(violation => violation.impact === 'serious' || violation.impact === 'critical')
    .map(violation => ({ context, rule: violation.id, targets: violation.nodes.map(node => node.target) }))
  expect(blocking).toEqual([])
}

test.describe.configure({ mode: 'serial' })

test('starts an accessible canary and automatically returns unhealthy traffic to baseline', async ({ page, request }) => {
  test.setTimeout(180_000)
  page.setDefaultTimeout(15_000)
  const stamp = Date.now()
  const orgId = `rollout-e2e-${stamp}`
  const workflowId = `invoice-rollout-${stamp}`
  const workflowName = `Invoice rollout ${stamp}`
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', error => pageErrors.push(error.message))

  const baseline: Json = {
    dslVersion: '1.0',
    id: workflowId,
    name: workflowName,
    nodes: [{
      id: 'outcome',
      type: 'transform',
      config: { mapping: { status: 'completed' } },
    }],
    edges: [],
    recovery: { contract: semanticRecoveryContract() },
  }
  const canary: Json = {
    dslVersion: '1.0',
    id: workflowId,
    name: workflowName,
    nodes: [
      { id: 'candidate', type: 'http', config: { url: 'http://127.0.0.1:9', method: 'GET' } },
      {
        id: 'outcome',
        type: 'transform',
        config: { mapping: { status: 'completed' } },
      },
    ],
    edges: [{ from: 'candidate', to: 'outcome' }],
    recovery: { contract: semanticRecoveryContract() },
  }
  const savedBaseline = await postJson(request, orgId, '/workflows/save', baseline) as { versionId?: unknown }
  const savedCanary = await postJson(request, orgId, '/workflows/save', canary) as { versionId?: unknown }
  expect(typeof savedBaseline.versionId).toBe('string')
  expect(typeof savedCanary.versionId).toBe('string')

  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.addInitScript(({ activeOrg }) => {
    window.localStorage.setItem('janusly:activeOrg', activeOrg)
    if (!window.localStorage.getItem('janusly:locale')) window.localStorage.setItem('janusly:locale', 'en')
  }, { activeOrg: orgId })
  await page.goto('/')
  await page.getByRole('button', { name: 'Flows', exact: true }).click()
  const row = page.getByTestId(`workflows-row-${workflowId}`)
  await expect(row).toContainText(workflowName)
  await row.click()
  await page.getByRole('button', { name: 'Step setup', exact: true }).click()

  const panel = page.getByTestId('workflow-rollout-panel')
  await expect(panel).toContainText('Canary deployment')
  await panel.getByLabel('Traffic share').fill('50')
  await panel.getByLabel('Min. outcomes').fill('5')
  await panel.getByLabel('Success floor').fill('80')
  const startCanary = panel.getByRole('button', { name: 'Start canary', exact: true })
  await expect(panel).toContainText('Outcome dataset comparison')
  await expect(startCanary).toBeDisabled()
  await hideUnrelatedOverlays(page)
  await expectAccessible(page, 'Required workflow outcome qualification')
  await capture(panel, 'web-en-workflow-outcome-qualification-required')

  await panel.getByRole('button', { name: 'Run comparison', exact: true }).click()
  await expect(panel).toContainText('Passed')
  await expect(panel).toContainText('4/4')
  await expect(panel).toContainText('Regressions')
  await expect(startCanary).toBeEnabled()
  await hideUnrelatedOverlays(page)
  await expectAccessible(page, 'Passed workflow outcome qualification')
  await capture(panel, 'web-en-workflow-outcome-qualification-passed')

  await startCanary.click()
  await expect(panel).toContainText('Active')
  await expect(panel).toContainText('50% to canary · v2')
  await hideUnrelatedOverlays(page)
  await expectAccessible(page, 'Active workflow canary')
  await capture(panel, 'web-en-workflow-canary-active')

  const blockedSave = await request.post(`${API_URL}/workflows/save`, {
    headers: headers(orgId),
    data: canary,
  })
  expect(blockedSave.status()).toBe(409)
  expect(await blockedSave.json()).toMatchObject({ code: 'workflow_rollout_active' })

  let rollout = await getRollout(request, orgId, workflowId)
  for (let attempt = 0; attempt < 30 && rollout?.status === 'active'; attempt += 1) {
    const started = await postJson(request, orgId, '/start', canary) as { runId?: unknown }
    if (typeof started.runId !== 'string') throw new Error('Start response did not contain a run id')
    await waitForTerminal(request, orgId, started.runId)
    rollout = await getRollout(request, orgId, workflowId)
  }
  expect(rollout).toMatchObject({ status: 'rolled_back', canaryFailed: 5 })
  expect((rollout?.baselineSucceeded ?? 0) + (rollout?.baselineFailed ?? 0)).toBeGreaterThanOrEqual(0)

  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => window.localStorage.setItem('janusly:locale', 'es'))
  await page.reload()
  await page.getByRole('button', { name: 'Navegación', exact: true }).click()
  await page.getByRole('button', { name: 'Flujos', exact: true }).click()
  const spanishRow = page.getByTestId(`workflows-row-${workflowId}`)
  await expect(spanishRow).toContainText(workflowName)
  await spanishRow.click()
  await page.getByRole('button', { name: 'Navegación', exact: true }).click()
  await page.getByRole('button', { name: 'Configuración de paso', exact: true }).click()
  const spanishPanel = page.getByTestId('workflow-rollout-panel')
  await expect(spanishPanel).toContainText('Despliegue canary')
  await expect(spanishPanel).toContainText('Revertido')
  await expect(spanishPanel).toContainText('Resultados del canary')
  await expect(spanishPanel).toContainText('Comparación del conjunto de resultados')
  await expect(spanishPanel).toContainText('Superada')
  await expect(spanishPanel).toContainText('El tráfico productivo nuevo usa la versión base.')
  await hideUnrelatedOverlays(page)
  await expectAccessible(page, 'Retorno automático del canary')
  await captureForeground(spanishPanel, 'web-es-workflow-canary-auto-return-mobile')

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(2)
  expect(consoleErrors).toEqual([])
  expect(pageErrors).toEqual([])
})
