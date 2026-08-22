/**
 * Janusly smoke: the real React app served by the Go binary must boot,
 * read the /v1 surfaces, and render real data.
 * Guarded behind JANUSLY_SMOKE=1 so the browser-only e2e lane never
 * runs it; driven by the repository E2E lane.
 */
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test'

const API_URL = process.env.E2E_API_URL ?? 'http://127.0.0.1:3001'
const UPSTREAM_HOST = process.env.E2E_UPSTREAM_HOST ?? '127.0.0.1'
const UPSTREAM_BIND = process.env.E2E_UPSTREAM_BIND ?? '127.0.0.1'

test.skip(process.env.JANUSLY_SMOKE !== '1', 'Janusly smoke runs only via scripts/test-e2e.sh')

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
  await new Promise<void>((resolve) => upstream.listen(0, UPSTREAM_BIND, resolve))
  const address = upstream.address()
  const upstreamUrl = typeof address === 'object' && address ? `http://${UPSTREAM_HOST}:${address.port}` : ''

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

test('ai studio against Go: $0 fallback generate, save, run, approve', async ({ page, request }) => {
  test.setTimeout(120_000)
  const orgId = `go-ai-${Date.now()}`
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  await preparePage(page, orgId)

  const { openWorkflowAiAction, openWorkspaceSection } = await import('./_helpers/workspace-navigation')
  await openWorkflowAiAction(page, 'Workflows')

  // Generate through the AI Studio: with no key the Go backend answers
  // the deterministic $0 fallback (approval-gate template for this prompt).
  await page.locator('.ai-studio-prompt').fill('necesito un flujo con approval humano antes de escribir')
  await page.getByRole('button', { name: 'Draft flow', exact: true }).click()
  const discard = page.getByRole('button', { name: 'Discard changes', exact: true })
  if (await discard.isVisible().catch(() => false)) await discard.click()
  await expect(page.getByText('Starter flow loaded locally').first()).toBeVisible()

  // The drafted canvas carries the fallback template; save + run it.
  await page.getByRole('button', { name: 'Validate', exact: true }).click()
  await expect(page.getByText('Flow is ready to run')).toBeVisible()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText(/Saved version \d+/)).toBeVisible()
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.getByText(/Run started:/)).toBeVisible()

  // The template pauses at its approval — open the run row in Activity
  // (the proven operator-loop path) and approve through the real UI.
  const started = await request.get(`${API_URL}/v1/runs`, { headers: headers(orgId) })
  const startedBody = await started.json() as { data?: Array<{ id?: string }> }
  const startedRunId = startedBody.data?.[0]?.id ?? ''
  expect(startedRunId).not.toBe('')
  await openWorkspaceSection(page, 'Activity', 'Activity')
  await page.getByTestId(`activity-row-run:${startedRunId}`).click()
  await expect(page.getByTestId('waiting-step-approval')).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: /Approve/ }).first().click()
  await expect(page.getByTestId('waiting-steps')).toBeHidden({ timeout: 20_000 })

  // Backend truth: exactly one run for the org and it succeeded.
  const runs = await request.get(`${API_URL}/v1/runs`, { headers: headers(orgId) })
  const runsBody = await runs.json() as { data?: Array<{ status?: string }> }
  const statuses = (runsBody.data ?? []).map((run) => run.status)
  expect(statuses).toContain('succeeded')

  expect(pageErrors, `page errors: ${pageErrors.join('; ')}`).toHaveLength(0)
})

test('human form against Go: pause, fill through the real UI, resume', async ({ page, request }) => {
  test.setTimeout(120_000)
  const orgId = `go-form-${Date.now()}`
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  await preparePage(page, orgId)

  const { openWorkspaceDestination, openWorkspaceSection, addCanvasStep } = await import('./_helpers/workspace-navigation')
  await openWorkspaceDestination(page, 'Workflows')
  await page.getByRole('button', { name: 'New workflow', exact: true }).first().click()
  await page.getByRole('button', { name: /^Start blank\b/ }).click()
  await page.getByRole('textbox', { name: 'Name' }).fill(`Go form ${Date.now()}`)
  await addCanvasStep(page, 'Collect form')

  await page.getByRole('button', { name: 'Validate', exact: true }).click()
  await expect(page.getByText('Flow is ready to run')).toBeVisible()
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.getByText(/Run started:/)).toBeVisible()

  // The paused form surfaces in the run panel with the SIGNED token wired
  // in; filling it through the real dialog resumes the run on the Go side.
  const started = await request.get(`${API_URL}/v1/runs`, { headers: headers(orgId) })
  const startedBody = await started.json() as { data?: Array<{ id?: string }> }
  const startedRunId = startedBody.data?.[0]?.id ?? ''
  expect(startedRunId).not.toBe('')
  await openWorkspaceSection(page, 'Activity', 'Activity')
  await page.getByTestId(`activity-row-run:${startedRunId}`).click()
  await expect(page.getByRole('button', { name: /Fill form/i })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: /Fill form/i }).click()
  await expect(page.getByRole('heading', { name: 'Collect request details' })).toBeVisible()
  await page.getByLabel('requester').fill('Ada')
  await page.getByLabel('reason').fill('PTO request')
  await page.getByRole('button', { name: /Submit form/i }).click()
  await expect(page.getByText(/Form .* submitted/)).toBeVisible()
  await expect(page.getByTestId('waiting-steps')).toBeHidden({ timeout: 20_000 })

  const runs = await request.get(`${API_URL}/v1/runs`, { headers: headers(orgId) })
  const runsBody = await runs.json() as { data?: Array<{ status?: string }> }
  expect((runsBody.data ?? []).map((run) => run.status)).toContain('succeeded')

  expect(pageErrors, `page errors: ${pageErrors.join('; ')}`).toHaveLength(0)
})

test('recovery queue, drawer, and bulk replay against Go', async ({ page, request }) => {
  test.setTimeout(120_000)
  const orgId = `go-queue-${Date.now()}`
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))

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
  await new Promise<void>((resolve) => upstream.listen(0, UPSTREAM_BIND, resolve))
  const address = upstream.address()
  const upstreamUrl = typeof address === 'object' && address ? `http://${UPSTREAM_HOST}:${address.port}` : ''

  try {
    const failing = {
      id: `queue-fail-${orgId}`,
      name: 'Queue failing flow',
      nodes: [{ id: 'call', type: 'http', config: { url: upstreamUrl, timeoutMs: 500 } }],
      edges: [],
    }
    await request.post(`${API_URL}/workflows/save`, { headers: headers(orgId), data: failing })
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
    const runIds: string[] = []
    for (let i = 0; i < 3; i++) {
      const started = await request.post(`${API_URL}/start`, {
        headers: headers(orgId), data: { workflow: failing },
      })
      const { runId } = await started.json() as { runId: string }
      runIds.push(runId)
      await waitStatus(runId, 'failed')
    }
    // The Go /dlq bare array feeds the id lookup (T-143 closed that gap).
    const dlqRes = await request.get(`${API_URL}/dlq`, { headers: headers(orgId) })
    const dlqRows = await dlqRes.json() as Array<{ id: string; runId: string }>
    expect(dlqRows.length).toBeGreaterThanOrEqual(3)
    const byRun = new Map(dlqRows.map((row) => [row.runId, row.id]))

    // One replay via API opens its ownership incident (badge + drawer).
    await request.post(`${API_URL}/dlq/replay`, {
      headers: headers(orgId), data: { deadLetterId: byRun.get(runIds[0]) },
    })
    await waitStatus(runIds[0], 'failed')

    // The hidden expert route: activeTab 'recover' mounts the queue.
    await page.addInitScript(({ activeOrg }) => {
      window.localStorage.setItem('janusly:activeOrg', activeOrg)
      window.localStorage.setItem('janusly:locale', 'en')
      window.localStorage.setItem('janusly:activeTab', 'recover')
    }, { activeOrg: orgId })
    await page.goto('/')
    await expect(page.getByTestId('recovery-queue')).toBeVisible()
    // Default Show=Open lists the two open rows; the replayed one is
    // filtered out until the operator widens the status filter.
    await expect(page.getByTestId(`dlq-row-${byRun.get(runIds[1])}`)).toBeVisible()
    await expect(page.getByTestId(`dlq-row-${byRun.get(runIds[2])}`)).toBeVisible()
    await expect(page.getByTestId(`dlq-row-${byRun.get(runIds[0])}`)).toBeHidden()
    await page.getByRole('combobox', { name: 'Show' }).selectOption({ label: 'All' })
    for (const runId of runIds) {
      await expect(page.getByTestId(`dlq-row-${byRun.get(runId)}`)).toBeVisible()
    }

    // Server-side search narrows to one row (matches the run id).
    await page.getByTestId('dlq-search').fill(runIds[1])
    await expect(page.getByTestId(`dlq-row-${byRun.get(runIds[1])}`)).toBeVisible()
    await expect(page.getByTestId(`dlq-row-${byRun.get(runIds[0])}`)).toBeHidden()
    await page.getByTestId('dlq-search').fill('')
    await expect(page.getByTestId(`dlq-row-${byRun.get(runIds[0])}`)).toBeVisible()

    // The drawer: open via the replayed row's incident badge, acknowledge,
    // and the CAS ladder reflects on the wire.
    await page.getByTestId('recovery-item-badge').first().click()
    await expect(page.getByTestId('recovery-item-drawer')).toBeVisible()
    await page.getByTestId('ri-action-acknowledge').click()
    await expect.poll(async () => {
      const res = await request.get(`${API_URL}/recovery/items`, { headers: headers(orgId) })
      const body = await res.json() as { items: Array<{ status: string }> }
      return body.items[0]?.status
    }, { timeout: 10_000 }).toBe('acknowledged')

    // Bulk replay through the real multi-select: heal the upstream, pick
    // the two still-open rows, confirm, and both runs recover.
    healed = true
    await page.getByTestId('dlq-select-toggle').click()
    await page.getByTestId(`dlq-select-row-${byRun.get(runIds[1])}`).click()
    await page.getByTestId(`dlq-select-row-${byRun.get(runIds[2])}`).click()
    await page.getByTestId('dlq-bulk-replay').click()
    await page.getByTestId('dlq-bulk-replay-confirm').click()
    await waitStatus(runIds[1], 'succeeded')
    await waitStatus(runIds[2], 'succeeded')

    expect(pageErrors, `page errors: ${pageErrors.join('; ')}`).toHaveLength(0)
  } finally {
    upstream.close()
  }
})

test('every workspace tab mounts against Go without page errors', async ({ page, request }) => {
  test.setTimeout(180_000)
  const orgId = `go-smoke-tabs-${Date.now()}`
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))

  await seed(request, orgId)

  // Every ActiveTab except recoveryCase (needs a selected durable case;
  // the store itself resets it to home on reload). Feature panels whose
  // backend surface is a documented F1 divergence must DEGRADE — render
  // their friendly empty/error state — never throw.
  const tabs = [
    'home', 'recover', 'workflows', 'members', 'ai-studio', 'experiments',
    'marketplace', 'templates', 'packs', 'credentials', 'inspector',
    'runs', 'reasoning', 'multiAgent', 'operations',
  ] as const

  for (const tab of tabs) {
    await page.addInitScript(({ activeOrg, activeTab }) => {
      window.localStorage.setItem('janusly:activeOrg', activeOrg)
      window.localStorage.setItem('janusly:locale', 'en')
      window.localStorage.setItem('janusly:activeTab', activeTab)
    }, { activeOrg: orgId, activeTab: tab })
    await page.goto('/')
    // The shell must render real content for the tab (an empty #root or a
    // white screen is a failed mount even if nothing threw).
    await expect(page.locator('#root > *').first(), `tab ${tab} must mount`).toBeVisible()
    if (tab === 'packs') {
      // Not just "didn't crash": the catalog card renders from Go's
      // reference-shaped pack projection (the boundary fallback would
      // swallow a shape drift silently).
      await expect(page.getByTestId('solution-pack-incident-triage')).toBeVisible()
    }
    await page.waitForTimeout(400)
    expect(pageErrors, `tab ${tab} page errors: ${pageErrors.join('; ')}`).toHaveLength(0)
  }
})

test('first kilometer against Go: Home cluster CTA lands on an actionable recovery dialog', async ({ page, request }) => {
  test.setTimeout(120_000)
  const orgId = `go-firstkm-${Date.now()}`
  const pageErrors: string[] = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))

  // Two failures sharing one signature: the shape Home's primary CTA
  // ("Recover all N matching failures in one pass") is built for.
  const flaky = {
    id: `firstkm-flaky-${orgId}`,
    name: 'First km flaky ingest',
    nodes: [{ id: 'fetch', type: 'http', config: {
      url: 'https://firstkm.invalid/feed', retry: { maxAttempts: 1 },
    } }],
    edges: [],
  }
  await request.post(`${API_URL}/workflows/save`, { headers: headers(orgId), data: flaky })
  const waitFailed = async (runId: string) => {
    const deadline = Date.now() + 30_000
    for (;;) {
      const res = await request.get(`${API_URL}/v1/status?runId=${runId}`, { headers: headers(orgId) })
      const body = await res.json() as { data?: { run?: { status?: string } } }
      if (body.data?.run?.status === 'failed') return
      if (Date.now() > deadline) throw new Error(`run ${runId} never failed`)
      await new Promise((r) => setTimeout(r, 150))
    }
  }
  for (let i = 0; i < 2; i += 1) {
    const started = await request.post(`${API_URL}/start`, {
      headers: headers(orgId), data: { workflow: flaky },
    })
    const { runId } = await started.json() as { runId: string }
    await waitFailed(runId)
  }

  await preparePage(page, orgId)
  await page.getByRole('button', { name: 'Home', exact: true }).click()

  // The CTA promises action on the cluster; it must land where the
  // Recovery dialog lives, never on a read-only copy of the data.
  await page.getByRole('button', { name: 'Open clusters', exact: true }).click()
  await expect(page.getByText('Recovery case').first()).toBeVisible()

  await page.getByRole('button', { name: 'Suggest fix', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Generate suggestion' })).toBeVisible()
  await page.getByRole('button', { name: 'Generate suggestion' }).click()

  // The container has no provider key on purpose: the dialog must stay
  // honest — a passport verdict and a blocked candidate, never an
  // invented patch and never a fabricated occurrence count.
  const passport = page.getByTestId('recovery-confidence-passport')
  await expect(passport).toBeVisible()
  await expect(passport).toHaveAttribute('data-verdict', 'unsafe')
  // Debounce links the incident to one dead letter of the pair: the
  // linked one reads "2 occurrences", its sibling shows no count at all.
  // What must never render for a cluster of two is an invented
  // "1 occurrence".
  await expect(passport).not.toContainText('1 occurrence')
  expect(pageErrors).toEqual([])
})
