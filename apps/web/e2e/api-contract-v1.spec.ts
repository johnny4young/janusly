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

function expectValidSchedulePreview(body: Record<string, unknown>, requestedAt: number) {
  expect(body.valid).toBe(true)
  expect(body.nextFires).toHaveLength(3)
  const nextFires = (body.nextFires as string[]).map(value => Date.parse(value))
  expect(nextFires.every(Number.isFinite)).toBe(true)
  expect(nextFires.every(value => value > requestedAt)).toBe(true)
  expect(nextFires[1]).toBeGreaterThan(nextFires[0])
  expect(nextFires[2]).toBeGreaterThan(nextFires[1])
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
  expect(Object.keys(openapiBody.paths)).toEqual(expect.arrayContaining([
    '/memory/consent-status',
    '/recovery/metrics',
    '/recovery/ledger',
    '/recovery/my-wins',
    '/workflows',
    '/workflows/versions',
    '/workflows/latest',
    '/workflows/schedule-preview',
    '/runs',
    '/run',
    '/run/usage',
    '/status',
  ]))

  const stablePaths = [
    '/memory/consent-status',
    '/recovery/metrics?windowDays=30',
    '/recovery/ledger',
    '/recovery/my-wins?days=30',
    `/workflows?q=${encodeURIComponent(workflowId)}&limit=20`,
    `/workflows/versions?workflowId=${encodeURIComponent(workflowId)}`,
    `/workflows/latest?workflowId=${encodeURIComponent(workflowId)}`,
    `/workflows/schedule-preview?cron=${encodeURIComponent('0 9 * * *')}`,
    `/runs?workflowId=${encodeURIComponent(workflowId)}&limit=20`,
    `/run?runId=${encodeURIComponent(runId)}`,
    `/run/usage?runId=${encodeURIComponent(runId)}`,
    `/status?runId=${encodeURIComponent(runId)}`,
  ]

  for (const path of stablePaths) {
    const requestedAt = Date.now()
    const legacy = await json(request, path)
    const versioned = await json(request, `/v1${path}`)
    expect(legacy.response.ok(), `legacy ${path}: ${JSON.stringify(legacy.body)}`).toBe(true)
    expect(versioned.response.ok(), `v1 ${path}: ${JSON.stringify(versioned.body)}`).toBe(true)
    expect(versioned.response.headers()['x-request-id']).toBeTruthy()
    if (path.startsWith('/workflows/schedule-preview?')) {
      expectValidSchedulePreview(legacy.body, requestedAt)
      expect(versioned.body).toMatchObject({ apiVersion: 'v1' })
      expectValidSchedulePreview(versioned.body.data as Record<string, unknown>, requestedAt)
    } else {
      expect(versioned.body).toMatchObject({ apiVersion: 'v1', data: legacy.body })
    }
  }

  const publicRunNodeKeys = [
    'attempts',
    'errorJson',
    'finishedAt',
    'id',
    'nodeId',
    'runId',
    'startedAt',
    'stateJson',
    'status',
  ]
  for (const path of [
    `/run?runId=${encodeURIComponent(runId)}`,
    `/status?runId=${encodeURIComponent(runId)}`,
  ]) {
    const legacy = await json(request, path)
    const versioned = await json(request, `/v1${path}`)
    const legacyNode = (legacy.body.nodes as Array<Record<string, unknown>>)[0]
    const versionedNode = ((versioned.body.data as { nodes: Array<Record<string, unknown>> }).nodes)[0]
    expect(Object.keys(legacyNode ?? {}).sort()).toEqual(publicRunNodeKeys)
    expect(Object.keys(versionedNode ?? {}).sort()).toEqual(publicRunNodeKeys)
    expect(legacyNode).not.toHaveProperty('recoveryClaimToken')
    expect(legacyNode).not.toHaveProperty('recoveryDeadLetterId')
    expect(legacyNode).not.toHaveProperty('recoveryRequestedBy')
  }

  const denied = await request.get(`${API_URL}/v1/run?runId=missing-${stamp}`, { headers: AUTH_HEADERS })
  expect(denied.status()).toBe(403)
  expect(await denied.json()).toMatchObject({
    apiVersion: 'v1',
    error: { code: 'runs_forbidden', message: 'Forbidden' },
  })

  const observedReadPaths = new Set<string>()
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname
    observedReadPaths.add(path)
  })

  await page.goto('/')
  const metricStrip = page.getByTestId('recovery-center-metric-strip')
  await expect(metricStrip).toBeVisible()
  await captureElement(metricStrip, 'web-en-v1-recovery-metrics')

  await page.getByRole('button', { name: 'Workflows', exact: true }).click()
  const workflowRow = page.getByTestId(`workflows-row-${workflowId}`)
  await expect(workflowRow).toBeVisible()
  await captureElement(workflowRow, 'web-en-v1-workflow-row')

  await page.getByRole('button', { name: 'Runs', exact: true }).click()
  const runHistory = page.getByTestId('runs-history-virtual-list')
  await expect(runHistory).toContainText(`${runId.slice(0, 8)}…`)
  await captureElement(runHistory, 'web-en-v1-run-history')

  expect(observedReadPaths.has('/recovery/home')).toBe(true)
  expect(observedReadPaths.has('/v1/workflows')).toBe(true)
  expect(observedReadPaths.has('/v1/runs')).toBe(true)
  expect(browserErrors).toEqual([])
})
