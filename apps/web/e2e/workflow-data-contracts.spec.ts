import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3001'
const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR

type Json = Record<string, unknown>
type RunNode = {
  nodeId: string
  status: string
  stateJson?: { output?: unknown } | null
  errorJson?: unknown
}
type RunEvent = { type?: string; nodeId?: string; payload?: unknown }
type RunSnapshot = {
  run: { status: string }
  nodes: RunNode[]
  events: RunEvent[]
}

type LocaleContract = {
  locale: 'en' | 'es'
  flows: string
  stepSetup: string
  runs: string
  viewTimeline: string
  strictLabel: string
  lenientStatus: string
  strictStatus: string
  unresolvedLenient: string
  unresolvedStrict: string
  save: string
}

const LOCALES: LocaleContract[] = [
  {
    locale: 'en',
    flows: 'Workflows',
    stepSetup: 'Step setup',
    runs: 'Runs',
    viewTimeline: 'View timeline',
    strictLabel: 'Fail on a missing value',
    lenientStatus: 'Continue with an empty value and record a warning in Reasoning.',
    strictStatus: 'Stop before using a missing value and record its path in Reasoning.',
    unresolvedLenient: 'Step shape_missing found 2 unresolved template references',
    unresolvedStrict: 'Step blocked_post found 1 unresolved template reference',
    save: 'Save',
  },
  {
    locale: 'es',
    flows: 'Flujos',
    stepSetup: 'Configuración de paso',
    runs: 'Ejecuciones',
    viewTimeline: 'Ver cronología',
    strictLabel: 'Fallar ante un valor ausente',
    lenientStatus: 'Continúa con un valor vacío y registra una advertencia en Razonamiento.',
    strictStatus: 'Se detiene antes de usar un valor ausente y registra su ruta en Razonamiento.',
    unresolvedLenient: 'El paso shape_missing encontró 2 referencias de plantilla sin resolver',
    unresolvedStrict: 'El paso blocked_post encontró 1 referencia de plantilla sin resolver',
    save: 'Guardar',
  },
]

function devHeaders(orgId: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-org-id': orgId,
    'x-user-id': 'dev-user',
  }
}

async function postJson(request: APIRequestContext, orgId: string, path: string, data: Json): Promise<Json> {
  const response = await request.post(`${API_URL}${path}`, { headers: devHeaders(orgId), data })
  if (!response.ok()) throw new Error(`POST ${path} failed: ${response.status()} ${await response.text()}`)
  return response.json()
}

async function getJson(request: APIRequestContext, orgId: string, path: string): Promise<Json> {
  const response = await request.get(`${API_URL}${path}`, { headers: devHeaders(orgId) })
  if (!response.ok()) throw new Error(`GET ${path} failed: ${response.status()} ${await response.text()}`)
  return response.json()
}

async function saveWorkflow(request: APIRequestContext, orgId: string, workflow: Json): Promise<void> {
  await postJson(request, orgId, '/workflows/save', workflow)
}

async function startWorkflow(request: APIRequestContext, orgId: string, workflow: Json): Promise<string> {
  const response = await postJson(request, orgId, '/start', workflow) as { runId?: unknown }
  if (typeof response.runId !== 'string') throw new Error('Start response did not contain a run id')
  return response.runId
}

async function pollUntilTerminal(
  request: APIRequestContext,
  orgId: string,
  runId: string,
  maxMs = 30_000,
): Promise<RunSnapshot> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < maxMs) {
    const snapshot = await getJson(request, orgId, `/run?runId=${encodeURIComponent(runId)}`) as unknown as RunSnapshot
    if (['succeeded', 'failed', 'cancelled'].includes(snapshot.run.status)) return snapshot
    await new Promise(resolve => setTimeout(resolve, 400))
  }
  throw new Error(`Run ${runId} did not reach a terminal status`)
}

function installBrowserErrorGuards(page: Page): {
  consoleErrors: string[]
  responseErrors: string[]
} {
  const consoleErrors: string[] = []
  const responseErrors: string[] = []
  page.on('console', message => {
    if (message.type() !== 'error') return
    const location = message.location().url
    consoleErrors.push(location ? `${message.text()} @ ${location}` : message.text())
  })
  page.on('pageerror', error => consoleErrors.push(error.message))
  page.on('response', response => {
    if (response.status() < 400) return
    responseErrors.push(`${response.status()} ${new URL(response.url()).pathname}`)
  })
  return { consoleErrors, responseErrors }
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
  await surface.evaluate((element) => {
    for (const selector of ['.toast', '.toast-stack', '.we-onboarding-banner', '.we-budget-banner', '[data-testid="command-palette"]']) {
      for (const overlay of element.ownerDocument.querySelectorAll<HTMLElement>(selector)) overlay.style.display = 'none'
    }
  })
  if (!EVIDENCE_DIR) return
  await mkdir(EVIDENCE_DIR, { recursive: true })
  await surface.screenshot({ path: `${EVIDENCE_DIR}/${name}.png` })
}

async function openWorkflow(
  page: Page,
  contract: LocaleContract,
  workflowId: string,
  workflowName: string,
): Promise<void> {
  await page.getByRole('button', { name: contract.flows, exact: true }).click()
  const row = page.getByTestId(`workflows-row-${workflowId}`)
  await expect(row).toContainText(workflowName)
  await row.click()
  await page.getByRole('button', { name: contract.stepSetup, exact: true }).click()
}

async function openRunFromHistory(page: Page, contract: LocaleContract, runId: string): Promise<void> {
  await page.getByRole('button', { name: contract.runs, exact: true }).click()
  const overview = page.getByTestId('run-workspace-tab-overview')
  if (await overview.isVisible().catch(() => false)) await overview.click()
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

async function captureUnresolvedEvent(
  page: Page,
  contract: LocaleContract,
  runId: string,
  expectedText: string,
  name: string,
): Promise<void> {
  await openRunFromHistory(page, contract, runId)
  await page.getByTestId('run-overview').getByRole('button', { name: contract.viewTimeline, exact: true }).click()
  const timeline = page.getByTestId('run-event-timeline')
  await timeline.getByTestId('run-event-filter').fill('template.unresolved_path')
  const event = timeline.getByRole('listitem').filter({ hasText: expectedText }).first()
  await expect(event).toHaveAttribute('data-tone', 'warning')
  await expect(event).toContainText('policy')
  await capture(event, name)
}

async function createHttpFixture(): Promise<{
  baseUrl: string
  hits: Map<string, number>
  close: () => Promise<void>
}> {
  const hits = new Map<string, number>()
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://fixture').pathname
    hits.set(path, (hits.get(path) ?? 0) + 1)
    if (path === '/customer') {
      response.writeHead(200, { 'content-type': 'application/problem+json; charset=utf-8' })
      response.end(JSON.stringify({ customer: { id: 42, email: 'operator@example.com' } }))
      return
    }
    if (path === '/invalid') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{not-json')
      return
    }
    if (path === '/large') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify('a'.repeat(64 * 1024)))
      return
    }
    response.writeHead(204)
    response.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits,
    close: async () => {
      server.close()
      await once(server, 'close')
    },
  }
}

test('HTTP JSON and unresolved templates stay explicit from runtime through the bilingual UI', async ({ page, request }) => {
  test.setTimeout(120_000)
  const stamp = Date.now()
  const orgId = `data-contracts-${stamp}`
  const validWorkflowId = `data-contract-valid-${stamp}`
  const validWorkflowName = `Data contract ${stamp}`
  const httpFixture = await createHttpFixture()
  const browserErrors = installBrowserErrorGuards(page)

  const validWorkflow: Json = {
    id: validWorkflowId,
    name: validWorkflowName,
    nodes: [
      {
        id: 'fetch_customer',
        type: 'http',
        config: { url: `${httpFixture.baseUrl}/customer`, maxResponseBytes: 200_000 },
      },
      {
        id: 'shape_customer',
        type: 'transform',
        config: { mapping: { customerId: '{{context.fetch_customer.output.json.customer.id}}' } },
      },
      {
        id: 'invalid_json',
        type: 'http',
        config: { url: `${httpFixture.baseUrl}/invalid`, maxResponseBytes: 200_000 },
      },
      {
        id: 'large_json',
        type: 'http',
        config: { url: `${httpFixture.baseUrl}/large`, maxResponseBytes: 200_000 },
      },
    ],
    edges: [{ from: 'fetch_customer', to: 'shape_customer' }],
  }
  const lenientWorkflow: Json = {
    id: `data-contract-lenient-${stamp}`,
    name: `Lenient template contract ${stamp}`,
    nodes: [{
      id: 'shape_missing',
      type: 'transform',
      config: {
        mapping: {
          email: '{{context.never.output.email}}',
          subject: '{{inputs.subject}}',
        },
      },
    }],
    edges: [],
  }
  const strictWorkflow: Json = {
    id: `data-contract-strict-${stamp}`,
    name: `Strict template contract ${stamp}`,
    templatePolicy: 'strict',
    nodes: [{
      id: 'blocked_post',
      type: 'http',
      config: {
        url: `${httpFixture.baseUrl}/write`,
        method: 'POST',
        body: { customerId: '{{context.never.output.id}}' },
      },
    }],
    edges: [],
  }

  try {
    await saveWorkflow(request, orgId, validWorkflow)

    const validRunId = await startWorkflow(request, orgId, validWorkflow)
    const valid = await pollUntilTerminal(request, orgId, validRunId)
    expect(valid.run.status).toBe('succeeded')
    const fetchOutput = valid.nodes.find(node => node.nodeId === 'fetch_customer')?.stateJson?.output as Json
    expect(fetchOutput).toMatchObject({
      statusCode: 200,
      json: { customer: { id: 42, email: 'operator@example.com' } },
    })
    expect(fetchOutput.body).toBe(JSON.stringify({ customer: { id: 42, email: 'operator@example.com' } }))
    expect(valid.nodes.find(node => node.nodeId === 'shape_customer')?.stateJson?.output).toEqual({ customerId: 42 })
    expect(valid.nodes.find(node => node.nodeId === 'invalid_json')?.stateJson?.output).toMatchObject({ jsonParseError: true })
    expect(valid.nodes.find(node => node.nodeId === 'large_json')?.stateJson?.output).toMatchObject({
      jsonParseSkipped: 'body_too_large',
    })

    const lenientRunId = await startWorkflow(request, orgId, lenientWorkflow)
    const lenient = await pollUntilTerminal(request, orgId, lenientRunId)
    expect(lenient.run.status).toBe('succeeded')
    expect(lenient.nodes.find(node => node.nodeId === 'shape_missing')?.stateJson?.output).toEqual({ email: '', subject: '' })
    const lenientEvents = lenient.events.filter(event => event.type === 'template.unresolved_path')
    expect(lenientEvents).toEqual([expect.objectContaining({
      nodeId: 'shape_missing',
      payload: {
        count: 2,
        paths: ['context.never.output.email', 'inputs.subject'],
        truncated: false,
        policy: 'lenient',
      },
    })])

    const strictRunId = await startWorkflow(request, orgId, strictWorkflow)
    const strict = await pollUntilTerminal(request, orgId, strictRunId)
    expect(strict.run.status).toBe('failed')
    expect(strict.nodes.find(node => node.nodeId === 'blocked_post')).toMatchObject({
      status: 'failed',
      errorJson: expect.objectContaining({ code: 'UNRESOLVED_TEMPLATE_PATH' }),
    })
    expect(strict.events).toContainEqual(expect.objectContaining({
      type: 'template.unresolved_path',
      nodeId: 'blocked_post',
      payload: {
        count: 1,
        paths: ['context.never.output.id'],
        truncated: false,
        policy: 'strict',
      },
    }))
    expect(httpFixture.hits.get('/write') ?? 0).toBe(0)
    expect(httpFixture.hits.get('/customer')).toBe(1)
    expect(httpFixture.hits.get('/invalid')).toBe(1)
    expect(httpFixture.hits.get('/large')).toBe(1)

    await page.addInitScript(({ activeOrg, locale }) => {
      window.localStorage.setItem('janusly:activeOrg', activeOrg)
      if (!window.localStorage.getItem('janusly:locale')) window.localStorage.setItem('janusly:locale', locale)
    }, { activeOrg: orgId, locale: 'en' })
    await page.goto('/')
    await hideUnrelatedOverlays(page)

    const english = LOCALES[0]
    await openWorkflow(page, english, validWorkflowId, validWorkflowName)
    const englishPolicy = page.getByTestId('workflow-template-policy')
    const englishStrict = englishPolicy.getByRole('checkbox', { name: english.strictLabel })
    await expect(englishStrict).not.toBeChecked()
    await expect(englishPolicy.getByRole('status')).toHaveText(english.lenientStatus)
    await capture(englishPolicy, 'web-en-template-policy-lenient-default')
    await englishStrict.check()
    await expect(englishPolicy.getByRole('status')).toHaveText(english.strictStatus)
    await capture(englishPolicy, 'web-en-template-policy-strict-selected')

    const englishSave = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/workflows/save')
    await page.locator(`button.sb-workflow__ghost[aria-label="${english.save}"]`).click()
    expect((await englishSave).ok()).toBe(true)
    const latestStrict = await getJson(request, orgId, `/workflows/latest?workflowId=${encodeURIComponent(validWorkflowId)}`) as {
      dagJson?: { templatePolicy?: string }
    }
    expect(latestStrict.dagJson?.templatePolicy).toBe('strict')

    await page.locator('.react-flow__node[data-id="fetch_customer"] .workflow-node').click()
    const englishHttp = page.getByTestId('inspector-node-fetch_customer').getByTestId('http-json-contract-helper')
    await expect(englishHttp).toContainText('Declared JSON responses up to 64 KiB')
    await expect(englishHttp).toContainText('output.jsonParseSkipped')
    await capture(englishHttp, 'web-en-http-json-contract-default')
    await captureUnresolvedEvent(page, english, lenientRunId, english.unresolvedLenient, 'web-en-template-unresolved-lenient-warning')
    await captureUnresolvedEvent(page, english, strictRunId, english.unresolvedStrict, 'web-en-template-unresolved-strict-warning')

    await page.evaluate(() => window.localStorage.setItem('janusly:locale', 'es'))
    await page.reload()
    await hideUnrelatedOverlays(page)

    const spanish = LOCALES[1]
    await openWorkflow(page, spanish, validWorkflowId, validWorkflowName)
    const spanishPolicy = page.getByTestId('workflow-template-policy')
    const spanishStrict = spanishPolicy.getByRole('checkbox', { name: spanish.strictLabel })
    await expect(spanishStrict).toBeChecked()
    await expect(spanishPolicy.getByRole('status')).toHaveText(spanish.strictStatus)
    await capture(spanishPolicy, 'web-es-template-policy-strict-persisted')
    await spanishStrict.uncheck()
    await expect(spanishPolicy.getByRole('status')).toHaveText(spanish.lenientStatus)
    await capture(spanishPolicy, 'web-es-template-policy-lenient-selected')

    const spanishSave = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/workflows/save')
    await page.locator(`button.sb-workflow__ghost[aria-label="${spanish.save}"]`).click()
    expect((await spanishSave).ok()).toBe(true)
    const latestLenient = await getJson(request, orgId, `/workflows/latest?workflowId=${encodeURIComponent(validWorkflowId)}`) as {
      dagJson?: { templatePolicy?: string }
    }
    expect(latestLenient.dagJson).not.toHaveProperty('templatePolicy')

    await page.locator('.react-flow__node[data-id="fetch_customer"] .workflow-node').click()
    const spanishHttp = page.getByTestId('inspector-node-fetch_customer').getByTestId('http-json-contract-helper')
    await expect(spanishHttp).toContainText('Las respuestas declaradas como JSON de hasta 64 KiB')
    await expect(spanishHttp).toContainText('output.jsonParseSkipped')
    await capture(spanishHttp, 'web-es-http-json-contract-default')
    await captureUnresolvedEvent(page, spanish, lenientRunId, spanish.unresolvedLenient, 'web-es-template-unresolved-lenient-warning')
    await captureUnresolvedEvent(page, spanish, strictRunId, spanish.unresolvedStrict, 'web-es-template-unresolved-strict-warning')

    expect(browserErrors).toEqual({ consoleErrors: [], responseErrors: [] })
  } finally {
    await httpFixture.close()
  }
})
