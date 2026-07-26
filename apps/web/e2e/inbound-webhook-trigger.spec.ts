import { mkdir } from 'node:fs/promises'
import { expect, test, type APIRequestContext } from '@playwright/test'

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3001'
const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR

type RunSnapshot = {
  run: { status: string }
  nodes: Array<{ nodeId: string; status: string; stateJson?: { output?: unknown } | null }>
}

function headers(orgId: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'x-org-id': orgId, 'x-user-id': 'dev-user' }
}

async function pollRun(request: APIRequestContext, orgId: string, runId: string): Promise<RunSnapshot> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const response = await request.get(`${API_URL}/run?runId=${encodeURIComponent(runId)}`, {
      headers: headers(orgId),
    })
    expect(response.ok(), await response.text()).toBe(true)
    const snapshot = await response.json() as RunSnapshot
    if (['succeeded', 'failed', 'cancelled'].includes(snapshot.run.status)) return snapshot
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  throw new Error(`Run ${runId} did not reach a terminal status`)
}

test('authors and executes one durable idempotent inbound JSON event', async ({ page, request }) => {
  const stamp = Date.now()
  const orgId = `webhook-e2e-${stamp}`
  const workflowId = `incident-ingest-${stamp}`
  const endpointKey = `incident-${stamp}`
  const workflow = {
    dslVersion: '1.0',
    id: workflowId,
    name: `Inbound incident ${stamp}`,
    nodes: [{
      id: 'incoming',
      type: 'webhook_received',
      config: { endpointKey },
    }],
    edges: [],
    outputs: {
      service: '{{context.incoming.output.event.payload.service}}',
      severity: '{{context.incoming.output.event.payload.severity}}',
    },
  }

  const saved = await request.post(`${API_URL}/workflows/save`, {
    headers: headers(orgId),
    data: workflow,
  })
  expect(saved.ok(), await saved.text()).toBe(true)

  await page.addInitScript(({ activeOrg }) => {
    window.localStorage.setItem('janusly:activeOrg', activeOrg)
    window.localStorage.setItem('janusly:locale', 'en')
  }, { activeOrg: orgId })
  await page.goto('/')
  await page.getByRole('button', { name: 'Flows', exact: true }).click()
  await page.getByTestId(`workflows-row-${workflowId}`).click()
  await page.getByRole('button', { name: 'Step setup', exact: true }).click()
  await page.locator('.react-flow__node[data-id="incoming"] .workflow-node').click()

  await expect(page.getByLabel('Endpoint key')).toHaveValue(endpointKey)
  await expect(page.getByText(/stable eventId/)).toBeVisible()
  if (EVIDENCE_DIR) {
    await mkdir(EVIDENCE_DIR, { recursive: true })
    const triggerConfig = page.locator('section.quick-config').filter({ has: page.getByLabel('Endpoint key') })
    await triggerConfig.screenshot({
      path: `${EVIDENCE_DIR}/inbound-webhook-authoring.png`,
      animations: 'disabled',
      caret: 'hide',
    })
  }

  const inbound = {
    endpointKey,
    eventId: `alert-${stamp}`,
    eventType: 'database.connection_exhausted',
    payload: { service: 'postgres', severity: 'critical', openConnections: 98 },
  }
  const first = await request.post(`${API_URL}/triggers/webhook/ingest`, {
    headers: headers(orgId),
    data: inbound,
  })
  expect(first.ok(), await first.text()).toBe(true)
  const accepted = await first.json() as { runId: string; triggerEventId: string; duplicate?: boolean }
  expect(accepted.duplicate).not.toBe(true)

  const duplicate = await request.post(`${API_URL}/triggers/webhook/ingest`, {
    headers: headers(orgId),
    data: inbound,
  })
  expect(duplicate.ok(), await duplicate.text()).toBe(true)
  await expect(duplicate.json()).resolves.toMatchObject({
    duplicate: true,
    runId: accepted.runId,
    triggerEventId: accepted.triggerEventId,
  })

  const snapshot = await pollRun(request, orgId, accepted.runId)
  expect(snapshot.run.status).toBe('succeeded')
  expect(snapshot.nodes).toHaveLength(1)
  expect(snapshot.nodes[0]).toMatchObject({
    nodeId: 'incoming',
    status: 'succeeded',
    stateJson: {
      output: {
        triggeredBy: 'webhook_received',
        event: {
          eventId: inbound.eventId,
          eventType: inbound.eventType,
          payload: inbound.payload,
        },
      },
    },
  })
})
