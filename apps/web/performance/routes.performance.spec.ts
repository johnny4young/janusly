import { expect, test, type Locator, type Page } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const budgets = JSON.parse(
  await readFile(resolve(import.meta.dirname, '..', 'performance-budgets.json'), 'utf8'),
) as {
  routeBudgets: Record<string, { maxTransferredKiB: number; maxLongTaskMs: number }>
}

const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR
const PERF_REPORT = process.env.JANUSLY_PERF_REPORT

type RouteMeasurement = {
  route: string
  transferredBytes: number
  maxLongTaskMs: number
  resourceCount: number
  resources: string[]
}

async function captureElement(locator: Locator, name: string) {
  if (!EVIDENCE_DIR) return
  await mkdir(EVIDENCE_DIR, { recursive: true })
  await locator.screenshot({ path: `${EVIDENCE_DIR}/${name}.png` })
}

function installConsoleErrorGuards(page: Page) {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message))
  return errors
}

async function installLongTaskObserver(page: Page) {
  await page.addInitScript(() => {
    const target = window as typeof window & { __januslyLongTasks?: number[] }
    target.__januslyLongTasks = []
    if ('PerformanceObserver' in window) {
      new PerformanceObserver((list) => {
        target.__januslyLongTasks?.push(...list.getEntries().map((entry) => entry.duration))
      }).observe({ type: 'longtask', buffered: true })
    }
  })
}

async function resetRouteMeasurement(page: Page) {
  await page.evaluate(() => {
    performance.clearResourceTimings()
    ;(window as typeof window & { __januslyLongTasks?: number[] }).__januslyLongTasks = []
  })
}

async function measureRoute(page: Page, route: string): Promise<RouteMeasurement> {
  await page.waitForTimeout(100)
  return page.evaluate((routeName) => {
    const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
    // Include every HTTP(S) resource, not only `script`/`link`: browsers label
    // Vite's eager `modulepreload` vendor chunks as `other`. Filtering by
    // initiator type would therefore omit React/Supabase/icons and turn the
    // Home transfer budget into a false pass.
    const relevant = resources.filter((entry) => {
      const url = new URL(entry.name)
      return url.protocol === 'http:' || url.protocol === 'https:'
    })
    const longTasks = (window as typeof window & { __januslyLongTasks?: number[] }).__januslyLongTasks ?? []
    return {
      route: routeName,
      transferredBytes: relevant.reduce((sum, entry) => sum + entry.transferSize, 0),
      maxLongTaskMs: Math.max(0, ...longTasks),
      resourceCount: relevant.length,
      resources: relevant.map((entry) => new URL(entry.name).pathname),
    }
  }, route)
}

function expectWithinBudget(measurement: RouteMeasurement) {
  const budget = budgets.routeBudgets[measurement.route]
  expect(budget, `missing route budget for ${measurement.route}`).toBeTruthy()
  expect(measurement.transferredBytes).toBeLessThanOrEqual(budget.maxTransferredKiB * 1024)
  expect(measurement.maxLongTaskMs).toBeLessThanOrEqual(budget.maxLongTaskMs)
}

async function stubApi(page: Page) {
  const createdAt = new Date(Date.now() - 60_000).toISOString()
  const rows = [
    {
      id: 'perf-a', runId: 'run-perf-a', nodeId: 'fetch_orders', attempt: 1, status: 'open',
      errorJson: { message: 'Upstream timed out' }, nodeType: 'http', workflowName: 'Order recovery', createdAt,
      recovery: null,
    },
    {
      id: 'perf-b', runId: 'run-perf-b', nodeId: 'notify_owner', attempt: 1, status: 'open',
      errorJson: { message: 'Delivery failed' }, nodeType: 'email', workflowName: 'Incident handoff', createdAt,
      recovery: null,
    },
  ]

  await page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({ status: 204, body: '' }))
  await page.route('https://fonts.gstatic.com/**', (route) => route.fulfill({ status: 204, body: '' }))
  await page.route('http://localhost:3001/**', async (route) => {
    const url = new URL(route.request().url())
    // The API helper transparently promotes contract-backed GETs to `/v1`.
    // Normalize those aliases so this production-build harness exercises the
    // same fixture envelope as the unversioned compatibility route.
    const pathname = url.pathname.startsWith('/v1/') ? url.pathname.slice(3) : url.pathname
    let body: unknown
    if (pathname === '/dlq/queue') body = { items: rows, nextCursor: null, hasMore: false }
    else if (pathname === '/dlq/counts') body = { total: 2, open: 2, replayed: 0, resolved: 0 }
    else if (pathname === '/dlq' && url.searchParams.has('id')) {
      const id = url.searchParams.get('id') ?? 'perf-a'
      const row = rows.find((candidate) => candidate.id === id) ?? rows[0]
      body = {
        ...row,
        workflowJson: { id: 'workflow-perf', name: row.workflowName, nodes: [{ id: row.nodeId, type: 'noop', config: {} }], edges: [] },
        nodeJson: { id: row.nodeId, type: 'noop', config: {} },
      }
    } else if (pathname === '/recovery/metrics') {
      body = {
        successRate: { value: 0, display: '—', severity: 'neutral', rationale: 'No terminal runs.' },
        mttr: { value: 0, display: '—', severity: 'neutral', rationale: 'No recovered runs.' },
        p95Latency: { value: 0, display: '—', severity: 'neutral', rationale: 'No latency samples.' },
        approvalsPending: { value: 0, display: '0', severity: 'healthy', rationale: 'No approvals waiting.' },
        replayRate: { value: 0, display: '—', severity: 'neutral', rationale: 'No replay samples.' },
        costThisWindow: { value: 0, display: '$0.00', severity: 'neutral', rationale: 'No AI usage.', providers: [] },
        windowDays: 30,
        terminalRuns: 0,
      }
    } else if (pathname === '/dlq/clusters') body = { clusters: [], totalSamples: 0, windowDays: 30 }
    else if (pathname === '/billing/budget') {
      body = { allowed: true, monthlyUsdSpent: 0, monthlyUsdLimit: null, policy: 'warn', warningPercent: 80, warningThresholdCrossed: false, exceededAt: null, resolvedScope: 'org' }
    } else if (['/tools', '/templates', '/solution-packs', '/credentials', '/runs', '/dlq', '/workflows'].includes(pathname)) {
      body = []
    } else if (pathname === '/recovery/heatmap') body = { days: [], totalFailures: 0, totalRecovered: 0 }
    else if (pathname === '/workflows/readiness') body = { status: 'ready', issues: [] }
    else if (pathname === '/recovery/calibration-status') body = { status: 'collecting', sampleCount: 0 }
    else if (pathname === '/ai/health') body = { configured: false, provider: 'anthropic' }
    else if (pathname === '/billing/usage') body = { totalCostUsd: 0, totalTokens: 0, byProvider: [] }
    else if (pathname === '/onboarding') body = { steps: [] }
    else {
      body = {}
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Timing-Allow-Origin': '*' },
      body: JSON.stringify(body),
    })
  })
}

test('production routes stay inside resource and long-task budgets', async ({ page }) => {
  const browserErrors = installConsoleErrorGuards(page)
  await installLongTaskObserver(page)
  await stubApi(page)

  await page.goto('/')
  const home = page.locator('.we-recovery-center-hero')
  await expect(home).toBeVisible()
  const homeMeasurement = await measureRoute(page, 'home')
  expect(homeMeasurement.resourceCount).toBeGreaterThan(0)
  expect(homeMeasurement.resources.some((path) => /CanvasWorkspace-.*\.(js|css)$/.test(path))).toBe(false)
  expectWithinBudget(homeMeasurement)
  await captureElement(home, 'web-en-performance-home')

  await resetRouteMeasurement(page)
  await page.getByRole('button', { name: /^AI Studio\b/ }).click()
  const canvas = page.locator('.workspace-main .react-flow').first()
  await expect(canvas).toBeVisible()
  const aiStudioMeasurement = await measureRoute(page, 'aiStudio')
  expect(aiStudioMeasurement.resources.some((path) => /CanvasWorkspace-.*\.js$/.test(path))).toBe(true)
  expectWithinBudget(aiStudioMeasurement)
  await captureElement(canvas, 'web-en-performance-ai-studio')

  await page.getByRole('button', { name: /^Home\b/ }).click()
  await page.getByTestId('recovery-center-queue-open-all').click()
  const secondRow = page.getByTestId('dlq-row-perf-b')
  await expect(secondRow).toBeVisible()
  await resetRouteMeasurement(page)
  await secondRow.click()
  const detail = page.locator('.detail-box').filter({ hasText: 'notify_owner' })
  await expect(detail).toContainText('Delivery failed')
  const recoveryMeasurement = await measureRoute(page, 'selectedRecovery')
  expect(recoveryMeasurement.resources.some((path) => path === '/dlq')).toBe(true)
  expect(recoveryMeasurement.transferredBytes).toBeGreaterThan(0)
  expectWithinBudget(recoveryMeasurement)
  await captureElement(detail, 'web-en-performance-selected-recovery')

  const measurements = [homeMeasurement, aiStudioMeasurement, recoveryMeasurement]
  if (PERF_REPORT) {
    const path = resolve(PERF_REPORT)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify({ generatedAt: new Date().toISOString(), measurements }, null, 2)}\n`)
  }
  expect(browserErrors).toEqual([])
})
