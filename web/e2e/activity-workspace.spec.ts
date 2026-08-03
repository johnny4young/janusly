import { mkdir } from 'node:fs/promises'
import AxeBuilder from '@axe-core/playwright'
import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from '@playwright/test'

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3001'
const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

type Json = Record<string, unknown>
type Locale = 'en' | 'es'
type RunSnapshot = {
  run: { status: string }
  nodes: Array<{ nodeId: string; status: string }>
}
type DeadLetterSummary = {
  id: string
  runId: string
  status: string
}

const copy = {
  en: {
    activity: 'Activity',
    needsAction: 'Needs action',
    failed: 'Failed',
    askJanusly: 'Ask Janusly about this run',
    evidence: 'Failure evidence',
    recoverStep: 'Recover this step',
    reviewWait: 'Review waiting step',
  },
  es: {
    activity: 'Actividad',
    needsAction: 'Requiere acción',
    failed: 'Fallidas',
    askJanusly: 'Pregúntale a Janusly sobre esta ejecución',
    evidence: 'Evidencia del fallo',
    recoverStep: 'Recuperar este paso',
    reviewWait: 'Revisar paso en espera',
  },
} as const

function headers(orgId: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-org-id': orgId,
    'x-user-id': 'dev-user',
  }
}

async function startRun(
  request: APIRequestContext,
  orgId: string,
  workflow: Json,
): Promise<string> {
  const response = await request.post(`${API_URL}/start`, {
    headers: headers(orgId),
    data: workflow,
  })
  if (!response.ok()) {
    throw new Error(`POST /start failed: ${response.status()} ${await response.text()}`)
  }
  const payload = await response.json() as { runId?: unknown }
  if (typeof payload.runId !== 'string') throw new Error('Start response did not include runId')
  return payload.runId
}

async function getRun(
  request: APIRequestContext,
  orgId: string,
  runId: string,
): Promise<RunSnapshot> {
  const response = await request.get(`${API_URL}/run?runId=${encodeURIComponent(runId)}`, {
    headers: headers(orgId),
  })
  if (!response.ok()) {
    throw new Error(`GET /run failed: ${response.status()} ${await response.text()}`)
  }
  return response.json() as Promise<RunSnapshot>
}

async function pollRun(
  request: APIRequestContext,
  orgId: string,
  runId: string,
  predicate: (snapshot: RunSnapshot) => boolean,
): Promise<RunSnapshot> {
  const deadline = Date.now() + 30_000
  let latest: RunSnapshot | null = null
  while (Date.now() < deadline) {
    latest = await getRun(request, orgId, runId)
    if (predicate(latest)) return latest
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Run ${runId} did not reach the expected state: ${JSON.stringify(latest)}`)
}

async function pollDeadLetter(
  request: APIRequestContext,
  orgId: string,
  runId: string,
): Promise<DeadLetterSummary> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const response = await request.get(`${API_URL}/dlq?limit=100`, {
      headers: headers(orgId),
    })
    if (!response.ok()) {
      throw new Error(`GET /dlq failed: ${response.status()} ${await response.text()}`)
    }
    const rows = await response.json() as DeadLetterSummary[]
    const match = rows.find(row => row.runId === runId)
    if (match) return match
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`No dead letter was created for run ${runId}`)
}

async function seedActivity(
  request: APIRequestContext,
  orgId: string,
): Promise<{ failedRunId: string; waitingRunId: string; deadLetterId: string }> {
  const stamp = Date.now()
  const waitingRunId = await startRun(request, orgId, {
    id: `activity-approval-${stamp}`,
    name: 'Expense approval',
    nodes: [{
      id: 'manager_approval',
      type: 'approval',
      config: { message: 'Approve the expense report' },
    }],
    edges: [],
  })
  await pollRun(
    request,
    orgId,
    waitingRunId,
    snapshot => snapshot.nodes.some(
      node => node.nodeId === 'manager_approval' && node.status === 'waiting',
    ),
  )

  const failedRunId = await startRun(request, orgId, {
    id: `activity-failure-${stamp}`,
    name: 'Customer sync',
    nodes: [{
      id: 'load_customer_secret',
      type: 'transform',
      config: { mapping: { token: '{{secret.ACTIVITY_E2E_MISSING}}' } },
    }],
    edges: [],
  })
  await pollRun(request, orgId, failedRunId, snapshot => snapshot.run.status === 'failed')
  const deadLetter = await pollDeadLetter(request, orgId, failedRunId)

  await startRun(request, orgId, {
    id: `activity-success-${stamp}`,
    name: 'Daily summary',
    nodes: [{ id: 'complete', type: 'noop', config: {} }],
    edges: [],
  }).then(runId => pollRun(request, orgId, runId, snapshot => snapshot.run.status === 'succeeded'))

  return { failedRunId, waitingRunId, deadLetterId: deadLetter.id }
}

function installBrowserErrorGuards(page: Page): string[] {
  const errors: string[] = []
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  page.on('pageerror', error => errors.push(`page: ${error.message}`))
  page.on('response', response => {
    const resourceType = response.request().resourceType()
    if (response.status() >= 400 && (resourceType === 'fetch' || resourceType === 'xhr')) {
      errors.push(`http ${response.status()}: ${response.request().method()} ${response.url()}`)
    }
  })
  return errors
}

async function preparePage(page: Page, orgId: string, locale: Locale): Promise<void> {
  await page.addInitScript(({ activeOrg, selectedLocale }) => {
    window.localStorage.setItem('janusly:activeOrg', activeOrg)
    window.localStorage.setItem('janusly:locale', selectedLocale)
    window.localStorage.setItem('janusly:activeTab', 'runs')
    window.localStorage.removeItem('janusly:sidebar:state')
  }, { activeOrg: orgId, selectedLocale: locale })
  await page.goto('/')
  await expect(page.getByTestId('activity-workspace')).toBeVisible()
  await page.evaluate(() => {
    for (const selector of ['.toast-stack', '.we-onboarding-banner', '.we-budget-banner']) {
      for (const element of document.querySelectorAll<HTMLElement>(selector)) {
        element.style.display = 'none'
      }
    }
  })
}

async function expectAccessible(page: Page, context: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()
  const blocking = results.violations
    .filter(violation => violation.impact === 'serious' || violation.impact === 'critical')
    .map(violation => ({
      context,
      rule: violation.id,
      targets: violation.nodes.map(node => node.target.map(String)),
    }))
  expect(blocking).toEqual([])
}

async function capture(surface: Locator, name: string): Promise<void> {
  await expect(surface).toBeVisible()
  if (!EVIDENCE_DIR) return
  await mkdir(EVIDENCE_DIR, { recursive: true })
  await surface.screenshot({
    path: `${EVIDENCE_DIR}/${name}.png`,
    animations: 'disabled',
    caret: 'hide',
  })
}

async function selectActivityRow(
  page: Page,
  kind: 'run' | 'recovery',
  entityId: string,
): Promise<Locator> {
  const row = page.getByTestId(`activity-row-${kind}:${entityId}`)
  await expect(row).toBeVisible()
  await row.locator('button.list-card-row').click()
  return row
}

test.describe.configure({ mode: 'serial' })

for (const locale of ['en', 'es'] as const) {
  test(`${locale} keeps real run and recovery work in one approachable Activity workspace`, async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000)
    const orgId = `activity-workspace-${locale}-${Date.now()}`
    const browserErrors = installBrowserErrorGuards(page)
    const seeded = await seedActivity(request, orgId)
    await page.setViewportSize(locale === 'en'
      ? { width: 1440, height: 1000 }
      : { width: 430, height: 932 })
    await preparePage(page, orgId, locale)

    const shell = page.locator('.app-shell')
    const feed = page.getByTestId('activity-feed-list')
    await expect(page.getByRole('heading', {
      name: copy[locale].activity,
      exact: true,
    })).toBeVisible()
    await expect(feed.getByRole('article')).toHaveCount(4)
    await expect(page.getByTestId('activity-filter-needs_action')).toContainText('2')
    await expect(page.getByTestId('activity-filter-failed')).toContainText('1')
    await expect(page.getByText(copy[locale].askJanusly, { exact: true })).toHaveCount(0)

    await page.getByTestId('activity-filter-needs_action').click()
    await expect(feed.getByRole('article')).toHaveCount(2)
    await expect(feed).toContainText(copy[locale].reviewWait)
    await expect(feed).toContainText(copy[locale].recoverStep)
    await expectAccessible(page, `${locale} Activity needs-action inventory`)
    await capture(shell, `web-${locale}-activity-needs-action`)

    await page.getByTestId('activity-filter-all').click()
    await selectActivityRow(page, 'run', seeded.failedRunId)
    await expect(page.getByTestId('run-overview')).toContainText(seeded.failedRunId.slice(0, 12))
    await expect(page.getByText(copy[locale].askJanusly, { exact: true })).toBeVisible()
    await expect(feed).toBeVisible()
    await expectAccessible(page, `${locale} Activity run detail`)
    await page.getByTestId('activity-detail').scrollIntoViewIfNeeded()
    await capture(shell, `web-${locale}-activity-run-detail`)

    await selectActivityRow(page, 'recovery', seeded.deadLetterId)
    const recoveryDetail = page.getByTestId('activity-recovery-detail')
    await expect(recoveryDetail).toBeVisible()
    await expect(recoveryDetail).toContainText(copy[locale].evidence)
    await expect(recoveryDetail).toContainText('Customer sync')
    await expect(page.getByText(copy[locale].askJanusly, { exact: true })).toBeVisible()
    await expect(feed).toBeVisible()
    await expectAccessible(page, `${locale} Activity recovery detail`)
    await capture(shell, `web-${locale}-activity-recovery-detail`)

    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(2)
    expect(browserErrors).toEqual([])
  })
}
