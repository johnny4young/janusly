import { mkdir } from 'node:fs/promises'
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3001'
const AUTH_HEADERS = { 'Content-Type': 'application/json', 'x-org-id': 'default', 'x-user-id': 'dev-user' }
const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR

function installConsoleErrorGuards(page: Page) {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

async function captureElement(locator: Locator, name: string) {
  if (!EVIDENCE_DIR) return
  await mkdir(EVIDENCE_DIR, { recursive: true })
  await locator.screenshot({ path: `${EVIDENCE_DIR}/${name}.png` })
}

async function json(request: APIRequestContext, path: string) {
  const response = await request.get(`${API_URL}${path}`, { headers: AUTH_HEADERS })
  return { response, body: await response.json() as Record<string, unknown> }
}

test('v1 contracts stay legacy-compatible and power the real web reads', async ({ page, request }) => {
  const browserErrors = installConsoleErrorGuards(page)
  const stamp = Date.now()
  const workflowId = `e2e-contract-${stamp}`
  const workflow = {
    id: workflowId,
    name: `E2E Contract ${stamp}`,
    nodes: [{ id: 'complete', type: 'noop', config: {} }],
    edges: [],
  }

  const save = await request.post(`${API_URL}/workflows/save`, {
    headers: AUTH_HEADERS,
    data: workflow,
  })
  if (!save.ok()) throw new Error(`save failed: ${save.status()} ${await save.text()}`)

  const start = await request.post(`${API_URL}/start`, {
    headers: AUTH_HEADERS,
    data: workflow,
  })
  if (!start.ok()) throw new Error(`start failed: ${start.status()} ${await start.text()}`)
  const { runId } = await start.json() as { runId: string }

  let terminalStatus = ''
  await expect.poll(async () => {
    const status = await request.get(`${API_URL}/v1/status?runId=${encodeURIComponent(runId)}`, { headers: AUTH_HEADERS })
    if (!status.ok()) return `http-${status.status()}`
    const envelope = await status.json() as { apiVersion: string; data: { run: { status: string } } }
    expect(envelope.apiVersion).toBe('v1')
    terminalStatus = envelope.data.run.status
    return terminalStatus
  }, { timeout: 30_000 }).toBe('succeeded')

  const openapi = await request.get(`${API_URL}/v1/openapi.json`)
  expect(openapi.ok()).toBe(true)
  const openapiBody = await openapi.json() as { openapi: string; paths: Record<string, unknown> }
  expect(openapiBody.openapi).toBe('3.1.0')
  expect(Object.keys(openapiBody.paths)).toHaveLength(7)

  const stablePaths = [
    '/recovery/metrics?windowDays=30',
    `/workflows?q=${encodeURIComponent(workflowId)}&limit=20`,
    `/workflows/versions?workflowId=${encodeURIComponent(workflowId)}`,
    `/workflows/latest?workflowId=${encodeURIComponent(workflowId)}`,
    `/runs?workflowId=${encodeURIComponent(workflowId)}&limit=20`,
    `/run?runId=${encodeURIComponent(runId)}`,
    `/status?runId=${encodeURIComponent(runId)}`,
  ]

  for (const path of stablePaths) {
    const legacy = await json(request, path)
    const versioned = await json(request, `/v1${path}`)
    expect(legacy.response.ok(), `legacy ${path}: ${JSON.stringify(legacy.body)}`).toBe(true)
    expect(versioned.response.ok(), `v1 ${path}: ${JSON.stringify(versioned.body)}`).toBe(true)
    expect(versioned.response.headers()['x-request-id']).toBeTruthy()
    expect(versioned.body).toMatchObject({ apiVersion: 'v1', data: legacy.body })
  }

  const denied = await request.get(`${API_URL}/v1/run?runId=missing-${stamp}`, { headers: AUTH_HEADERS })
  expect(denied.status()).toBe(403)
  expect(await denied.json()).toMatchObject({
    apiVersion: 'v1',
    error: { code: 'runs_forbidden', message: 'Forbidden' },
  })

  const observedV1Paths = new Set<string>()
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname
    if (path.startsWith('/v1/')) observedV1Paths.add(path)
  })

  await page.goto('/')
  const metricStrip = page.getByTestId('recovery-center-metric-strip')
  await expect(metricStrip).toBeVisible()
  await captureElement(metricStrip, 'web-en-v1-recovery-metrics')

  await page.getByRole('button', { name: 'Flows', exact: true }).click()
  const workflowRow = page.getByTestId(`workflows-row-${workflowId}`)
  await expect(workflowRow).toBeVisible()
  await captureElement(workflowRow, 'web-en-v1-workflow-row')

  await page.getByRole('button', { name: 'Runs', exact: true }).click()
  const runHistory = page.getByTestId('runs-history-virtual-list')
  await expect(runHistory).toContainText(`${runId.slice(0, 8)}…`)
  await captureElement(runHistory, 'web-en-v1-run-history')

  expect(observedV1Paths.has('/v1/recovery/metrics')).toBe(true)
  expect(observedV1Paths.has('/v1/workflows')).toBe(true)
  expect(observedV1Paths.has('/v1/runs')).toBe(true)
  expect(browserErrors).toEqual([])
})
