/**
 * Go-pilot smoke: the REAL React app pointed at the Go backend
 * (VITE_API_URL) must boot, read the /v1 surfaces, and render real data.
 * Guarded behind JANUSLY_GO_SMOKE=1 so the ordinary Node e2e lane never
 * runs it; driven by go/conformance/run-web-smoke.mjs.
 */
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test'

const API_URL = process.env.E2E_API_URL ?? 'http://127.0.0.1:4600'

test.skip(process.env.JANUSLY_GO_SMOKE !== '1', 'go-pilot smoke runs only via run-web-smoke.mjs')

function headers(orgId: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-org-id': orgId,
    'x-user-id': 'dev-user',
  }
}

async function seed(request: APIRequestContext, orgId: string): Promise<void> {
  const linear = {
    id: `smoke-linear-${orgId}`,
    name: 'Go smoke linear',
    nodes: [
      { id: 'shape', type: 'transform', config: { mapping: { verdict: 'ok' } } },
      { id: 'done', type: 'noop', config: {} },
    ],
    edges: [{ from: 'shape', to: 'done' }],
  }
  const approval = {
    id: `smoke-gate-${orgId}`,
    name: 'Go smoke gate',
    nodes: [
      { id: 'gate', type: 'approval', config: { message: 'Smoke gate' } },
      { id: 'after', type: 'noop', config: {} },
    ],
    edges: [{ from: 'gate', to: 'after' }],
  }
  await request.post(`${API_URL}/workflows/save`, { headers: headers(orgId), data: linear })
  await request.post(`${API_URL}/workflows/save`, { headers: headers(orgId), data: approval })

  const started = await request.post(`${API_URL}/start`, {
    headers: headers(orgId), data: { workflow: linear },
  })
  const { runId } = await started.json() as { runId: string }
  const deadline = Date.now() + 20_000
  for (;;) {
    const res = await request.get(`${API_URL}/v1/status?runId=${runId}`, { headers: headers(orgId) })
    const body = await res.json() as { data?: { run?: { status?: string } } }
    if (body.data?.run?.status === 'succeeded') break
    if (Date.now() > deadline) throw new Error('seed run never succeeded')
    await new Promise((r) => setTimeout(r, 100))
  }
  // A waiting approval feeds the "needs action" surface.
  await request.post(`${API_URL}/start`, {
    headers: headers(orgId), data: { workflow: approval },
  })
}

async function preparePage(page: Page, orgId: string): Promise<void> {
  await page.addInitScript(({ activeOrg }) => {
    window.localStorage.setItem('janusly:activeOrg', activeOrg)
    window.localStorage.setItem('janusly:locale', 'en')
    window.localStorage.setItem('janusly:activeTab', 'runs')
  }, { activeOrg: orgId })
  await page.goto('/')
}

test('the real web boots against Go and renders live data', async ({ page, request }) => {
  test.setTimeout(90_000)
  const orgId = `go-smoke-${Date.now()}`
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))

  await seed(request, orgId)
  await preparePage(page, orgId)

  // The Activity workspace is the app's home: it must mount against Go.
  await expect(page.getByTestId('activity-workspace')).toBeVisible()

  // The feed reads /v1/runs from Go: both seeded runs render as articles.
  const feed = page.getByTestId('activity-feed-list')
  await expect(feed.getByRole('article').first()).toBeVisible()
  const articles = await feed.getByRole('article').count()
  expect(articles).toBeGreaterThanOrEqual(2)

  // The waiting approval surfaces as needs-action — reading nodes through
  // Go's run projection, not just the list.
  await expect(page.getByTestId('activity-filter-needs_action')).toContainText('1')

  // No uncaught page errors: out-of-scope panels must degrade, not throw.
  expect(pageErrors, `page errors: ${pageErrors.join('; ')}`).toHaveLength(0)
})

test('operator loop against Go: redrive and approve through the real UI', async ({ page, request }) => {
  test.setTimeout(120_000)
  const orgId = `go-loop-${Date.now()}`
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))

  // Healable upstream hosted by the spec itself; the Go backend (booted
  // with ALLOW_PRIVATE_HTTP_TARGETS=true by the runner) can reach it.
  const { createServer } = await import('node:http')
  let healed = false
  const upstream = createServer((_req, res) => {
    if (healed) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
      return
    }
    res.writeHead(500)
    res.end('down')
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  const upstreamUrl = typeof address === 'object' && address ? `http://127.0.0.1:${address.port}` : ''

  try {
    // Seed: a failing http run (lands in DLQ) and a waiting approval run.
    const failing = {
      id: `loop-fail-${orgId}`,
      name: 'Loop failing flow',
      nodes: [{ id: 'call', type: 'http', config: { url: upstreamUrl, timeoutMs: 500 } }],
      edges: [],
    }
    const approval = {
      id: `loop-gate-${orgId}`,
      name: 'Loop approval flow',
      nodes: [
        { id: 'gate', type: 'approval', config: { message: 'Loop gate' } },
        { id: 'after', type: 'noop', config: {} },
      ],
      edges: [{ from: 'gate', to: 'after' }],
    }
    for (const doc of [failing, approval]) {
      await request.post(`${API_URL}/workflows/save`, { headers: headers(orgId), data: doc })
    }
    const startedFail = await request.post(`${API_URL}/start`, {
      headers: headers(orgId), data: { workflow: failing },
    })
    const { runId: failedRunId } = await startedFail.json() as { runId: string }
    const startedGate = await request.post(`${API_URL}/start`, {
      headers: headers(orgId), data: { workflow: approval },
    })
    const { runId: gateRunId } = await startedGate.json() as { runId: string }

    const waitStatus = async (runId: string, want: string) => {
      const deadline = Date.now() + 30_000
      for (;;) {
        const res = await request.get(`${API_URL}/v1/status?runId=${runId}`, { headers: headers(orgId) })
        const body = await res.json() as { data?: { run?: { status?: string } } }
        if (body.data?.run?.status === want) return
        if (Date.now() > deadline) throw new Error(`run ${runId} never reached ${want}`)
        await new Promise((r) => setTimeout(r, 150))
      }
    }
    await waitStatus(failedRunId, 'failed')

    await preparePage(page, orgId)
    await expect(page.getByTestId('activity-workspace')).toBeVisible()

    // ── T-064: redrive from the run panel ─────────────────────────────
    await page.getByTestId(`activity-row-run:${failedRunId}`).click()
    await expect(page.getByTestId('run-overview')).toBeVisible()
    await expect(page.getByTestId('failed-node-call')).toBeVisible()

    healed = true
    await page.getByTestId('redrive-node-call').click()
    await waitStatus(failedRunId, 'succeeded')
    await expect(page.getByTestId('failed-node-call')).toBeHidden({ timeout: 15_000 })

    // ── T-065: approve and resume from the run panel ──────────────────
    await page.getByTestId(`activity-row-run:${gateRunId}`).click()
    await expect(page.getByTestId('waiting-step-gate')).toBeVisible()
    await page.getByRole('button', { name: 'Approve and resume' }).click()
    await waitStatus(gateRunId, 'succeeded')
    await expect(page.getByTestId('waiting-steps')).toBeHidden({ timeout: 15_000 })

    expect(pageErrors, `page errors: ${pageErrors.join('; ')}`).toHaveLength(0)
  } finally {
    upstream.close()
  }
})
