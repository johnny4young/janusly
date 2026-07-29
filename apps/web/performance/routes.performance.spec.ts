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

// Bounded session envelope matching `SessionContext` in
// `src/identity-context.ts`: one usable membership, already selected, so the
// app skips both the workspace picker and the needs-organization state.
// The permission list is the admin catalog because this harness walks every
// route (`tab-permissions.ts` hides a tab whose permission is absent, which
// would fail navigation rather than report a budget regression).
const ADMIN_PERMISSIONS = [
  'ai.write', 'alerts.read', 'alerts.write', 'autohealing.decide', 'autohealing.read',
  'credentials.read', 'credentials.write', 'dlq.read', 'dlq.replay', 'evals.read', 'evals.write',
  'members.read', 'members.role_set', 'members.write', 'onboarding.read', 'onboarding.write',
  'packs.install', 'packs.read', 'prompts.read', 'prompts.write', 'recovery.read', 'recovery.write',
  'reports.deliver', 'reports.read', 'runs.cancel', 'runs.read', 'runs.start', 'snippets.read',
  'snippets.write', 'triggers.ingest', 'triggers.read', 'upstream.read', 'upstream.write',
  'workflows.read', 'workflows.write',
]

const sessionContext = {
  identity: { userId: 'dev-user', email: 'dev-user@janusly.local', mode: 'dev-headers', source: 'dev' },
  profile: { name: 'Dev User', email: 'dev-user@janusly.local' },
  organizations: [{
    id: 'default',
    name: 'Default',
    plan: null,
    role: 'admin',
    roleBase: 'admin',
    permissions: ADMIN_PERMISSIONS,
    usable: true,
    developmentFallback: false,
  }],
  invitations: [],
  currentOrganizationId: 'default',
  selectionRequired: false,
  needsOrganization: false,
  truncated: false,
  invitationsTruncated: false,
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
    // Tenant bootstrap. The app resolves the active organization from this
    // envelope before the Recovery Center home renders, so an empty default
    // would leave every route stuck on the identity-pending shell.
    if (pathname === '/auth/context') body = sessionContext
    else if (pathname === '/dlq/queue') body = { items: rows, nextCursor: null, hasMore: false }
    else if (pathname === '/dlq/counts') body = { total: 2, open: 2, replayed: 0, resolved: 0 }
    else if (pathname === '/dlq' && url.searchParams.has('id')) {
      const id = url.searchParams.get('id') ?? 'perf-a'
      const row = rows.find((candidate) => candidate.id === id) ?? rows[0]
      body = {
        ...row,
        workflowJson: { id: 'workflow-perf', name: row.workflowName, nodes: [{ id: row.nodeId, type: 'noop', config: {} }], edges: [] },
        nodeJson: { id: row.nodeId, type: 'noop', config: {} },
      }
    } else if (pathname === '/dlq') {
      body = rows
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
    } else if (pathname === '/recovery/validation') {
      // Controlled-drill evidence. `RecoveryValidationSection` dereferences
      // `totals`/`resolution`/`timing` unconditionally, so an empty default
      // throws inside the Recovery Center render after first paint.
      body = {
        generatedAt: new Date().toISOString(),
        windowDays: 30,
        sampleLimit: 100,
        sampleCapped: false,
        totals: {
          drills: 0, completed: 0, recovered: 0, acceptedLoss: 0, awaitingAction: 0,
          replayInProgress: 0, measurementIncomplete: 0, missingEvidence: 0,
          completionRatePercent: null, recoveryRatePercent: null,
        },
        resolution: { operator: 0, automated: 0, unknown: 0, operatorInterventionRatePercent: null },
        timing: { medianElapsedMs: null, p90ElapsedMs: null, averageElapsedMs: null, p95ElapsedMs: null, sampleSize: 0 },
        byFailureMode: [],
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
  expect(homeMeasurement.resources.some((path) => /catalog-en-.*\.js$/.test(path))).toBe(true)
  expect(homeMeasurement.resources.some((path) => /catalog-es-.*\.js$/.test(path))).toBe(false)
  expect(homeMeasurement.resources.some((path) => /supabase-runtime-.*\.js$/.test(path))).toBe(false)
  await captureElement(home, 'web-en-performance-home')

  const workflowsDestination = page.getByRole('button', { name: /^Workflows\b/ })
  await expect(workflowsDestination).toBeVisible()
  await workflowsDestination.click()
  const createWorkflowAction = page.locator(
    'button[aria-controls="workflow-creation-choices"]',
  )
  await expect(createWorkflowAction).toBeVisible()
  await expect(createWorkflowAction).toBeEnabled()
  await resetRouteMeasurement(page)
  await createWorkflowAction.click()
  await page.getByRole('button', { name: /^Start blank\b/ }).click()
  const canvas = page.locator('.workspace-main .react-flow').first()
  await expect(canvas).toBeVisible()
  const workflowBuilderMeasurement = await measureRoute(page, 'workflowBuilder')
  expect(workflowBuilderMeasurement.resources.some((path) => /CanvasWorkspace-.*\.js$/.test(path))).toBe(true)
  await captureElement(canvas, 'web-en-performance-workflow-builder')

  await page.getByRole('button', { name: /^Home\b/ }).click()
  await page.getByTestId('recovery-center-action-cta-triage_failures').click()
  const secondRow = page.getByTestId('activity-row-recovery:perf-b')
  await expect(secondRow).toBeVisible()
  const activityResources = await page.evaluate(() => (
    (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
      .map((entry) => new URL(entry.name).pathname)
  ))
  expect(activityResources.some(
    (path) => /ActivityRecoveryDetail-.*\.js$/.test(path),
  )).toBe(true)
  await resetRouteMeasurement(page)
  await secondRow.click()
  const detail = page.getByTestId('activity-recovery-detail')
  await expect(detail).toContainText('Delivery failed')
  const recoveryMeasurement = await measureRoute(page, 'selectedRecovery')
  expect(recoveryMeasurement.resources.some((path) => path === '/dlq')).toBe(true)
  expect(recoveryMeasurement.transferredBytes).toBeGreaterThan(0)
  await captureElement(detail, 'web-en-performance-selected-recovery')

  await resetRouteMeasurement(page)
  await page.getByRole('button', { name: 'Open user menu' }).click()
  const localeSwitcher = page.getByRole('combobox', { name: 'Change language' })
  await localeSwitcher.selectOption('es')
  // Locale changes update the active catalog in place, so the appearance menu
  // stays open and keeps the operator's current interaction context.
  await expect(page.getByRole('combobox', { name: 'Cambiar idioma' })).toHaveValue('es')
  const localeSwitchResources = await page.evaluate(() => (
    (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
      .map((entry) => new URL(entry.name).pathname)
  ))
  expect(localeSwitchResources.some((path) => /catalog-es-.*\.js$/.test(path))).toBe(true)
  expect(localeSwitchResources.some((path) => /supabase-runtime-.*\.js$/.test(path))).toBe(false)
  await captureElement(page.locator('.we-locale-switcher--row'), 'web-es-locale-switcher-loaded')

  // A fresh Spanish boot must fetch only Spanish. This catches two easy-to-
  // miss regressions: eagerly importing both catalogs and reintroducing an
  // English fallback download before the first localized render.
  const esPage = await page.context().newPage()
  const esBrowserErrors = installConsoleErrorGuards(esPage)
  await stubApi(esPage)
  await esPage.addInitScript(() => {
    window.localStorage.clear()
    window.localStorage.setItem('janusly:locale', 'es')
  })
  await esPage.goto('/')
  const esHome = esPage.locator('.we-recovery-center-hero')
  await expect(esHome).toBeVisible()
  await expect(esHome.locator('.section-kicker')).toHaveText('Inicio')
  const esResources = await esPage.evaluate(() => (
    (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
      .map((entry) => new URL(entry.name).pathname)
  ))
  expect(esResources.some((path) => /catalog-es-.*\.js$/.test(path))).toBe(true)
  expect(esResources.some((path) => /catalog-en-.*\.js$/.test(path))).toBe(false)
  expect(esResources.some((path) => /supabase-runtime-.*\.js$/.test(path))).toBe(false)
  await captureElement(esHome, 'web-es-performance-home')
  expect(esBrowserErrors).toEqual([])
  await esPage.close()

  const measurements = [homeMeasurement, workflowBuilderMeasurement, recoveryMeasurement]
  if (PERF_REPORT) {
    const path = resolve(PERF_REPORT)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify({ generatedAt: new Date().toISOString(), measurements }, null, 2)}\n`)
  }
  expect(browserErrors).toEqual([])
  for (const measurement of measurements) expectWithinBudget(measurement)
})
