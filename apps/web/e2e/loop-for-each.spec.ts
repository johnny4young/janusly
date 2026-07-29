import { mkdir } from 'node:fs/promises'
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { openWorkspaceSection } from './_helpers/workspace-navigation'

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3001'
const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR

type Json = Record<string, unknown>
type RunSnapshot = {
  run: { status: string; outputJson?: Json | null }
  nodes: Array<{ nodeId: string; status: string; stateJson?: { output?: unknown } | null; errorJson?: unknown }>
  events: Array<{ type?: string; nodeId?: string; payload?: unknown }>
}

const locales = {
  en: {
    flows: 'Workflows',
    runs: 'Runs',
    viewTimeline: 'View timeline',
    processingMode: 'Processing mode',
    forEachMode: 'Run a tool for each item',
    tool: 'Tool',
    toolInput: 'Per-item tool input',
    concurrency: 'Concurrency',
    failureCount: 'Failed items allowed',
    workflowOutput: 'Workflow output',
  },
  es: {
    flows: 'Flujos',
    runs: 'Ejecuciones',
    viewTimeline: 'Ver cronología',
    processingMode: 'Modo de procesamiento',
    forEachMode: 'Ejecutar una herramienta por elemento',
    tool: 'Herramienta',
    toolInput: 'Entrada de la herramienta por elemento',
    concurrency: 'Concurrencia',
    failureCount: 'Elementos fallidos permitidos',
    workflowOutput: 'Salida del flujo',
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

async function getJson(request: APIRequestContext, orgId: string, path: string): Promise<Json> {
  const response = await request.get(`${API_URL}${path}`, { headers: headers(orgId) })
  if (!response.ok()) throw new Error(`GET ${path} failed: ${response.status()} ${await response.text()}`)
  return response.json()
}

async function saveWorkflow(request: APIRequestContext, orgId: string, workflow: Json): Promise<void> {
  await postJson(request, orgId, '/workflows/save', workflow)
}

async function latestWorkflow(request: APIRequestContext, orgId: string, workflowId: string): Promise<Json> {
  const latest = await getJson(request, orgId, `/workflows/latest?workflowId=${encodeURIComponent(workflowId)}`)
  if (!latest.dagJson || typeof latest.dagJson !== 'object' || Array.isArray(latest.dagJson)) {
    throw new Error('Latest workflow has no DAG')
  }
  return latest.dagJson as Json
}

async function runWorkflow(request: APIRequestContext, orgId: string, workflow: Json): Promise<{ runId: string; snapshot: RunSnapshot }> {
  const started = await postJson(request, orgId, '/start', workflow) as { runId?: unknown }
  if (typeof started.runId !== 'string') throw new Error('Start response has no run id')
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const snapshot = await getJson(request, orgId, `/run?runId=${encodeURIComponent(started.runId)}`) as unknown as RunSnapshot
    if (['succeeded', 'failed', 'cancelled'].includes(snapshot.run.status)) {
      return { runId: started.runId, snapshot }
    }
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  throw new Error(`Run ${started.runId} did not reach a terminal status`)
}

function installBrowserErrorGuards(page: Page): string[] {
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

async function capture(surface: Locator, filename: string): Promise<void> {
  await expect(surface).toBeVisible()
  await surface.scrollIntoViewIfNeeded()
  if (!EVIDENCE_DIR) return
  await mkdir(EVIDENCE_DIR, { recursive: true })
  await surface.screenshot({ path: `${EVIDENCE_DIR}/${filename}.png`, animations: 'disabled', caret: 'hide' })
}

async function openLoopConfig(
  page: Page,
  locale: keyof typeof locales,
  workflowId: string,
  workflowName: string,
): Promise<Locator> {
  const contract = locales[locale]
  await page.getByRole('button', { name: contract.flows, exact: true }).click()
  const row = page.getByTestId(`workflows-row-${workflowId}`)
  await expect(row).toContainText(workflowName)
  await row.click()
  await openWorkspaceSection(page, contract.flows, locale === 'en' ? 'Build' : 'Crear')
  await page.locator('.react-flow__node[data-id="batch"] .workflow-node').click()
  return page.getByTestId('inspector-node-batch').getByTestId('loop-config')
}

async function openRunFromHistory(
  page: Page,
  locale: keyof typeof locales,
  runId: string,
): Promise<void> {
  await openWorkspaceSection(
    page,
    locale === 'en' ? 'Activity' : 'Actividad',
    locales[locale].runs,
  )
  const history = page.getByTestId('runs-history-virtual-list')
  await expect(history).toBeVisible()
  await expect.poll(() => history.getByRole('article').count()).toBeGreaterThan(0)
  const prefix = `${runId.slice(0, 8)}…`
  await history.evaluate(element => element.scrollTo({ top: 0 }))
  for (let offset = 0; offset < 100; offset += 4) {
    const card = history.getByRole('article').filter({ hasText: prefix }).first()
    if (await card.isVisible().catch(() => false)) {
      await card.locator('button.list-card-row').click()
      await expect(page.getByTestId('run-overview')).toContainText(runId.slice(0, 12))
      return
    }
    const reachedEnd = await history.evaluate((element, rowOffset) => {
      element.scrollTo({ top: rowOffset * 156 })
      return element.scrollTop + element.clientHeight >= element.scrollHeight
    }, offset + 4)
    await page.waitForTimeout(50)
    if (reachedEnd) break
  }
  throw new Error(`Run ${runId} was not present in history`)
}

test('bounded for-each authoring, runtime budgets, and diagnostics work in English and Spanish', async ({ page, request }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1440, height: 1200 })
  const stamp = Date.now()
  const orgId = `loop-for-each-${stamp}`
  const workflowId = `loop-for-each-workflow-${stamp}`
  const workflowName = `Bounded batch ${stamp}`
  const browserErrors = installBrowserErrorGuards(page)
  const initialWorkflow: Json = {
    id: workflowId,
    name: workflowName,
    outputs: {
      mode: '{{context.batch.output.mode}}',
      processed: '{{context.batch.output.count}}',
      succeeded: '{{context.batch.output.succeededCount}}',
      failed: '{{context.batch.output.failedCount}}',
      failedIndices: '{{context.batch.output.failedIndices}}',
    },
    nodes: [{
      id: 'batch',
      type: 'loop',
      position: { x: 220, y: 160 },
      config: {
        items: '1,invalid,2',
        mapping: { value: '{{item}}', index: '{{index}}' },
        retry: { maxAttempts: 1 },
      },
    }],
    edges: [],
  }
  await saveWorkflow(request, orgId, initialWorkflow)

  await page.addInitScript(({ activeOrg }) => {
    window.localStorage.setItem('janusly:activeOrg', activeOrg)
    if (!window.localStorage.getItem('janusly:locale')) window.localStorage.setItem('janusly:locale', 'en')
  }, { activeOrg: orgId })
  await page.goto('/')
  await hideUnrelatedOverlays(page)

  const englishConfig = await openLoopConfig(page, 'en', workflowId, workflowName)
  const mode = englishConfig.getByLabel(locales.en.processingMode)
  await mode.selectOption('for_each')
  await expect(mode).toHaveValue('for_each')
  const tool = englishConfig.getByLabel(locales.en.tool, { exact: true })
  await expect(tool.locator('option[value="json.parse"]')).toHaveCount(1)
  await tool.selectOption('json.parse')
  const toolInput = englishConfig.getByLabel(locales.en.toolInput)
  await toolInput.fill('{"value":"{{item}}"}')
  await toolInput.blur()
  const concurrency = englishConfig.getByLabel(locales.en.concurrency)
  await concurrency.fill('2')
  await concurrency.blur()
  const failureCount = englishConfig.getByLabel(locales.en.failureCount)
  await failureCount.fill('1')
  await failureCount.blur()
  await expect(englishConfig).toContainText(locales.en.forEachMode)
  await capture(englishConfig, 'web-en-loop-for-each-authoring')

  const saveResponse = page.waitForResponse(response =>
    response.request().method() === 'POST' && new URL(response.url()).pathname === '/workflows/save',
  )
  await page.keyboard.press('ControlOrMeta+s')
  expect((await saveResponse).ok()).toBe(true)

  const authoredWorkflow = await latestWorkflow(request, orgId, workflowId) as {
    nodes?: Array<{ id?: string; config?: Json }>
  }
  expect(authoredWorkflow.nodes?.find(node => node.id === 'batch')?.config).toMatchObject({
    mode: 'for_each',
    tool: 'json.parse',
    input: { value: '{{item}}' },
    concurrency: 2,
    toleratedFailureCount: 1,
  })

  const tolerated = await runWorkflow(request, orgId, authoredWorkflow as unknown as Json)
  expect(tolerated.snapshot.run.status).toBe('succeeded')
  expect(tolerated.snapshot.run.outputJson).toEqual({
    mode: 'for_each',
    processed: 3,
    succeeded: 2,
    failed: 1,
    failedIndices: [1],
  })
  expect(tolerated.snapshot.nodes.find(node => node.nodeId === 'batch')?.stateJson?.output).toMatchObject({
    count: 3,
    succeededCount: 2,
    failedCount: 1,
    failedIndices: [1],
  })
  expect(tolerated.snapshot.events.map(event => event.type)).toEqual(expect.arrayContaining([
    'loop.for_each.started',
    'loop.completed',
  ]))

  // The run was started through Playwright's API client, outside the mounted
  // web store. Reload so the history panel fetches the new server state rather
  // than asserting against its intentionally cached pre-run snapshot.
  await page.reload()
  await hideUnrelatedOverlays(page)
  await openRunFromHistory(page, 'en', tolerated.runId)
  const englishOutput = page.getByTestId('workflow-output')
  await englishOutput.getByText(locales.en.workflowOutput, { exact: true }).click()
  await expect(englishOutput).toContainText('"failed": 1')
  await capture(englishOutput, 'web-en-loop-for-each-success-output')

  const strictWorkflow = structuredClone(authoredWorkflow as unknown as Json) as {
    nodes: Array<{ id: string; config: Json }>
  } & Json
  const strictLoop = strictWorkflow.nodes.find(node => node.id === 'batch')
  if (!strictLoop) throw new Error('Authored workflow lost the batch node')
  strictLoop.config = { ...strictLoop.config, toleratedFailureCount: 0 }
  await saveWorkflow(request, orgId, strictWorkflow)
  const exceeded = await runWorkflow(request, orgId, await latestWorkflow(request, orgId, workflowId))
  expect(exceeded.snapshot.run.status).toBe('failed')
  expect(exceeded.snapshot.nodes.find(node => node.nodeId === 'batch')?.errorJson).toMatchObject({
    code: 'LOOP_FAILURE_BUDGET_EXCEEDED',
    details: {
      count: 3,
      failedCount: 1,
      failedIndices: [1],
      failures: [{ index: 1, error: { message: 'json.parse received invalid JSON' } }],
    },
  })
  expect(exceeded.snapshot.events.map(event => event.type)).toContain('loop.failure_budget.exceeded')

  await page.evaluate(() => window.localStorage.setItem('janusly:locale', 'es'))
  await page.reload()
  await hideUnrelatedOverlays(page)
  const spanishConfig = await openLoopConfig(page, 'es', workflowId, workflowName)
  await expect(spanishConfig.getByLabel(locales.es.processingMode)).toHaveValue('for_each')
  await expect(spanishConfig.getByLabel(locales.es.failureCount)).toHaveValue('0')
  await expect(spanishConfig).toContainText(locales.es.forEachMode)
  await capture(spanishConfig, 'web-es-loop-for-each-authoring')

  await openRunFromHistory(page, 'es', exceeded.runId)
  await page.getByTestId('run-overview').getByRole('button', { name: locales.es.viewTimeline, exact: true }).click()
  const timeline = page.getByTestId('run-event-timeline')
  await timeline.getByTestId('run-event-filter').fill('loop.failure_budget.exceeded')
  const failureEvent = timeline.getByRole('listitem').filter({ hasText: 'Se superó el presupuesto de fallos del bucle' }).first()
  await expect(failureEvent).toContainText('batch')
  await capture(failureEvent, 'web-es-loop-for-each-failure-budget')
  expect(browserErrors).toEqual([])
})
