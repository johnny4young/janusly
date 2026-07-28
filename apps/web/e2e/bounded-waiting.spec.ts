import { mkdir } from 'node:fs/promises'
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3001'
const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR

type Json = Record<string, unknown>
type RunNode = {
  nodeId: string
  status: string
  stateJson?: { waiting?: Record<string, unknown> } | null
  errorJson?: Record<string, unknown> | null
}
type RunSnapshot = {
  run: { status: string }
  nodes: RunNode[]
  events: Array<{ type: string; nodeId?: string | null; payload?: unknown }>
}

const locales = {
  en: {
    flows: 'Workflows',
    stepSetup: 'Step setup',
    runs: 'Runs',
    recover: 'Recover',
    approvalDeadline: 'Decision deadline',
    timeoutPolicy: 'When the deadline passes',
    timeoutSeconds: 'Timeout (seconds)',
    waitMode: 'Wait mode',
    responsible: 'Responsible: tier-1',
    saved: /Saved version \d+/,
  },
  es: {
    flows: 'Flujos',
    stepSetup: 'Configuración de paso',
    runs: 'Ejecuciones',
    recover: 'Recuperar',
    approvalDeadline: 'Fecha límite para decidir',
    timeoutPolicy: 'Cuando venza el plazo',
    timeoutSeconds: 'Tiempo límite (segundos)',
    waitMode: 'Modo de espera',
    responsible: 'Responsable: tier-1',
    saved: /Versión \d+ guardada/,
  },
} as const

function headers(orgId: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'x-org-id': orgId, 'x-user-id': 'dev-user' }
}

async function postJson(request: APIRequestContext, orgId: string, path: string, data: Json): Promise<Json> {
  const response = await request.post(`${API_URL}${path}`, { headers: headers(orgId), data })
  if (!response.ok()) throw new Error(`POST ${path} failed: ${response.status()} ${await response.text()}`)
  return response.json()
}

async function getRun(request: APIRequestContext, orgId: string, runId: string): Promise<RunSnapshot> {
  const response = await request.get(`${API_URL}/run?runId=${encodeURIComponent(runId)}`, { headers: headers(orgId) })
  if (!response.ok()) throw new Error(`GET /run failed: ${response.status()} ${await response.text()}`)
  return response.json() as Promise<RunSnapshot>
}

async function startRun(request: APIRequestContext, orgId: string, workflow: Json): Promise<string> {
  const started = await postJson(request, orgId, '/start', workflow) as { runId?: unknown }
  if (typeof started.runId !== 'string') throw new Error('Start response did not contain runId')
  return started.runId
}

async function pollRun(
  request: APIRequestContext,
  orgId: string,
  runId: string,
  predicate: (snapshot: RunSnapshot) => boolean,
  maxMs = 30_000,
): Promise<RunSnapshot> {
  const deadline = Date.now() + maxMs
  let latest: RunSnapshot | null = null
  while (Date.now() < deadline) {
    latest = await getRun(request, orgId, runId)
    if (predicate(latest)) return latest
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Run ${runId} did not reach the expected state: ${JSON.stringify(latest)}`)
}

function captureBrowserErrors(page: Page): string[] {
  const errors: string[] = []
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', error => errors.push(error.message))
  return errors
}

async function hideUnrelatedOverlays(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const selector of ['.toast', '.toast-stack', '.we-onboarding-banner', '.we-budget-banner', '[data-testid="command-palette"]']) {
      for (const element of document.querySelectorAll<HTMLElement>(selector)) element.style.display = 'none'
    }
  })
}

async function capture(surface: Locator, name: string): Promise<void> {
  await expect(surface).toBeVisible()
  await surface.scrollIntoViewIfNeeded()
  const box = await surface.boundingBox()
  const viewport = surface.page().viewportSize()
  if (!box || !viewport || box.x < 0 || box.y < 0 || box.x + box.width > viewport.width || box.y + box.height > viewport.height) {
    throw new Error(`Evidence surface ${name} is clipped by the viewport`)
  }
  if (!EVIDENCE_DIR) return
  await mkdir(EVIDENCE_DIR, { recursive: true })
  await surface.screenshot({ path: `${EVIDENCE_DIR}/${name}.png`, animations: 'disabled', caret: 'hide' })
}

async function openWorkflow(page: Page, locale: keyof typeof locales, workflowId: string, workflowName: string): Promise<void> {
  const copy = locales[locale]
  await page.getByRole('button', { name: copy.flows, exact: true }).click()
  const row = page.getByTestId(`workflows-row-${workflowId}`)
  await expect(row).toContainText(workflowName)
  await row.click()
  await page.getByRole('button', { name: copy.stepSetup, exact: true }).click()
}

async function openRunFromHistory(page: Page, locale: keyof typeof locales, runId: string): Promise<void> {
  // Runs created through APIRequestContext do not emit a browser-local
  // platform-version bump. Reload before re-entering the view so boot fetches
  // observe the new run even when the in-memory history cache is already warm.
  await page.reload()
  await hideUnrelatedOverlays(page)
  await page.getByRole('button', { name: locales[locale].flows, exact: true }).click()
  await page.getByRole('button', { name: locales[locale].runs, exact: true }).click()
  const history = page.getByTestId('runs-history-virtual-list')
  await expect(history).toBeVisible()
  const prefix = `${runId.slice(0, 8)}…`
  await expect.poll(async () => history.getByRole('article').filter({ hasText: prefix }).count()).toBeGreaterThan(0)
  await history.getByRole('article').filter({ hasText: prefix }).first().locator('button.list-card-row').click()
  await expect(page.getByTestId('run-overview')).toContainText(runId.slice(0, 12))
  await expect(page.locator('.we-run-stream-chip--live')).toBeVisible()
  await page.getByRole('button', { name: locales[locale].recover, exact: true }).click()
}

test('approval deadlines and absolute waits are safe, observable, and authorable in both locales', async ({ page, request }) => {
  test.setTimeout(150_000)
  await page.setViewportSize({ width: 1440, height: 1100 })
  const stamp = Date.now()
  const orgId = `bounded-waiting-${stamp}`
  const workflowId = `bounded-waiting-${stamp}`
  const workflowName = `Bounded waiting ${stamp}`
  const browserErrors = captureBrowserErrors(page)
  const authoredUntil = new Date(Date.now() + 24 * 60 * 60_000).toISOString()
  const authoredWorkflow: Json = {
    id: workflowId,
    name: workflowName,
    nodes: [
      {
        id: 'approval_gate',
        type: 'approval',
        config: {
          message: 'Approve production change',
          assignee: 'tier-1',
          decisionTimeoutMs: 600_000,
          onTimeout: 'escalate',
          escalateTo: 'tier-2',
        },
      },
      { id: 'absolute_wait', type: 'wait_until', config: { until: authoredUntil } },
      { id: 'done', type: 'noop', config: {} },
    ],
    edges: [
      { from: 'approval_gate', to: 'absolute_wait' },
      { from: 'absolute_wait', to: 'done' },
    ],
  }

  await postJson(request, orgId, '/workflows/save', authoredWorkflow)
  const waitingRunId = await startRun(request, orgId, authoredWorkflow)
  await pollRun(request, orgId, waitingRunId, snapshot => snapshot.nodes.some(node => node.nodeId === 'approval_gate' && node.status === 'waiting'))

  await page.addInitScript(({ activeOrg }) => {
    window.localStorage.setItem('janusly:activeOrg', activeOrg)
    if (!window.localStorage.getItem('janusly:locale')) window.localStorage.setItem('janusly:locale', 'en')
  }, { activeOrg: orgId })
  await page.goto('/')
  await hideUnrelatedOverlays(page)

  for (const locale of ['en', 'es'] as const) {
    if (locale === 'es') {
      await page.evaluate(() => window.localStorage.setItem('janusly:locale', 'es'))
      await page.reload()
      await hideUnrelatedOverlays(page)
    }

    await openWorkflow(page, locale, workflowId, workflowName)
    await page.locator('.react-flow__node[data-id="approval_gate"] .workflow-node').click()
    const approvalConfig = page.getByTestId('approval-config')
    await expect(approvalConfig.getByLabel(locales[locale].approvalDeadline)).toHaveValue('timeout')
    await expect(approvalConfig.getByLabel(locales[locale].timeoutPolicy)).toHaveValue('escalate')
    if (locale === 'en') {
      await approvalConfig.getByLabel('Responsible user ID').fill('tier-1-ui')
      await approvalConfig.getByLabel(locales.en.timeoutSeconds).fill('90.5')
      await approvalConfig.getByLabel(locales.en.timeoutSeconds).blur()
      await approvalConfig.getByLabel('Escalate to user ID').fill('tier-2-ui')
    }
    await capture(approvalConfig, `web-${locale}-approval-deadline-configured`)

    await page.locator('.react-flow__node[data-id="absolute_wait"] .workflow-node').click()
    const waitConfig = page.getByTestId('wait-until-config')
    await expect(waitConfig.getByLabel(locales[locale].waitMode)).toHaveValue('until')
    if (locale === 'en') {
      await waitConfig.getByLabel(locales.en.waitMode).selectOption('duration')
      await waitConfig.getByLabel(locales.en.waitMode).selectOption('until')
      const localUntil = await page.evaluate(() => {
        const instant = new Date(Date.now() + 24 * 60 * 60_000)
        return new Date(instant.getTime() - instant.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
      })
      await waitConfig.getByLabel('Resume at').fill(localUntil)
      await waitConfig.getByLabel('Resume at').blur()
    }
    await capture(waitConfig, `web-${locale}-absolute-wait-configured`)

    if (locale === 'en') {
      await page.locator('button.sb-workflow__ghost[aria-label="Save"]').click()
      await expect(page.getByText(locales.en.saved)).toBeVisible()
      await hideUnrelatedOverlays(page)
      const latest = await request.get(`${API_URL}/workflows/latest?workflowId=${encodeURIComponent(workflowId)}`, {
        headers: headers(orgId),
      })
      expect(latest.ok()).toBe(true)
      const latestBody = await latest.json() as { dagJson?: { nodes?: Array<{ id?: string; config?: Json }> } }
      expect(latestBody.dagJson?.nodes?.find(node => node.id === 'approval_gate')?.config).toMatchObject({
        assignee: 'tier-1-ui',
        decisionTimeoutMs: 90_500,
        onTimeout: 'escalate',
        escalateTo: 'tier-2-ui',
      })
      expect(latestBody.dagJson?.nodes?.find(node => node.id === 'absolute_wait')?.config?.until).toEqual(expect.stringMatching(/Z$/))
    }

    await openRunFromHistory(page, locale, waitingRunId)
    const waitCard = page.getByTestId('waiting-step-approval_gate')
    await expect(waitCard).toContainText(locales[locale].responsible)
    await expect(waitCard).toContainText('tier-2')
    await capture(waitCard, `web-${locale}-approval-waiting-owned`)
  }

  await postJson(request, orgId, '/run/cancel', { runId: waitingRunId, reason: 'e2e cleanup' })

  for (const policy of ['fail', 'auto_reject'] as const) {
    const workflow: Json = {
      id: `${policy}-${stamp}`,
      nodes: [
        { id: 'gate', type: 'approval', config: { decisionTimeoutMs: 200, onTimeout: policy } },
        { id: 'must_not_run', type: 'noop', config: {} },
      ],
      edges: [{ from: 'gate', to: 'must_not_run' }],
    }
    const runId = await startRun(request, orgId, workflow)
    const terminal = await pollRun(request, orgId, runId, snapshot => snapshot.run.status === 'failed')
    expect(terminal.nodes.find(node => node.nodeId === 'must_not_run')?.status).toBe('pending')
    expect(terminal.nodes.find(node => node.nodeId === 'gate')?.errorJson?.code).toBe(
      policy === 'fail' ? 'approval_timed_out' : 'approval_auto_rejected',
    )
    expect(terminal.events.some(event => event.type === (policy === 'fail' ? 'approval.timed_out' : 'approval.auto_rejected'))).toBe(true)
  }

  const escalationWorkflow: Json = {
    id: `escalate-${stamp}`,
    nodes: [
      {
        id: 'gate',
        type: 'approval',
        config: { assignee: 'tier-1', decisionTimeoutMs: 10_000, onTimeout: 'escalate', escalateTo: 'tier-2' },
      },
      { id: 'after', type: 'noop', config: {} },
    ],
    edges: [{ from: 'gate', to: 'after' }],
  }
  const escalationRunId = await startRun(request, orgId, escalationWorkflow)
  await openRunFromHistory(page, 'es', escalationRunId)
  const liveEscalationCard = page.getByTestId('waiting-step-gate')
  await expect(liveEscalationCard).toContainText('Responsable: tier-1')
  await expect(liveEscalationCard).toContainText('Responsabilidad escalada de tier-1 a tier-2', { timeout: 15_000 })
  await capture(liveEscalationCard, 'web-es-approval-live-escalated')
  const escalated = await pollRun(request, orgId, escalationRunId, snapshot => {
    const waiting = snapshot.nodes.find(node => node.nodeId === 'gate')?.stateJson?.waiting
    return waiting?.timeoutState === 'escalated'
  })
  expect(escalated.run.status).not.toBe('failed')
  expect(escalated.nodes.find(node => node.nodeId === 'gate')?.stateJson?.waiting).toMatchObject({
    assignee: 'tier-2',
    escalatedFrom: 'tier-1',
    timeoutState: 'escalated',
  })
  await page.evaluate(() => window.localStorage.setItem('janusly:locale', 'en'))
  await page.reload()
  await hideUnrelatedOverlays(page)
  await openRunFromHistory(page, 'en', escalationRunId)
  await expect(page.getByTestId('waiting-step-gate')).toContainText('Escalated from tier-1 to tier-2')
  await capture(page.getByTestId('waiting-step-gate'), 'web-en-approval-live-escalated')
  await postJson(request, orgId, '/resume', { runId: escalationRunId, nodeId: 'gate' })
  await pollRun(request, orgId, escalationRunId, snapshot => snapshot.run.status === 'succeeded')

  const absoluteWorkflow: Json = {
    id: `absolute-${stamp}`,
    nodes: [
      { id: 'wait', type: 'wait_until', config: { until: new Date(Date.now() + 500).toISOString() } },
      { id: 'after', type: 'noop', config: {} },
    ],
    edges: [{ from: 'wait', to: 'after' }],
  }
  const absoluteRunId = await startRun(request, orgId, absoluteWorkflow)
  const absoluteTerminal = await pollRun(request, orgId, absoluteRunId, snapshot => snapshot.run.status === 'succeeded')
  expect(absoluteTerminal.nodes.find(node => node.nodeId === 'after')?.status).toBe('succeeded')

  expect(browserErrors).toEqual([])
})
