/** Real-stack and bilingual UI proof for queue pressure observability. */

import { mkdir } from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'

const API_URL = process.env.E2E_API_URL ?? 'http://127.0.0.1:3001'
const API_METRICS_URL = process.env.E2E_API_METRICS_URL
const WORKER_METRICS_URL = process.env.E2E_WORKER_METRICS_URL
const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR

type QueueState = {
  waiting: number
  active: number
  oldestWaitingSeconds: number | null
  warnSeconds: number
} | null

type QueueRouteState = (NonNullable<QueueState> & { maintenance?: QueueState }) | null | 'protocol-error'

const copy = {
  en: {
    operations: 'Operations',
    clear: 'Workflow queue clear',
    processing: '2 jobs waiting · oldest 40 seconds',
    delayed: 'Queue delayed',
    delayedIdle: 'Jobs are waiting for a worker',
    unavailable: 'Queue status unavailable',
    transportUnavailable: 'request failed',
    maintenanceClear: 'Maintenance queue clear',
    maintenanceDelayed: 'Maintenance delayed',
  },
  es: {
    operations: 'Operaciones',
    clear: 'Cola de flujos sin espera',
    processing: '2 trabajos en espera · el más antiguo lleva 40 segundos',
    delayed: 'Cola con demora',
    delayedIdle: 'Los trabajos están esperando un proceso de ejecución',
    unavailable: 'Estado de la cola no disponible',
    transportUnavailable: 'falló la solicitud',
    maintenanceClear: 'Cola de mantenimiento sin espera',
    maintenanceDelayed: 'Mantenimiento con demora',
  },
} as const

function headers(orgId: string): Record<string, string> {
  return { 'x-org-id': orgId, 'x-user-id': 'dev-user' }
}

function installErrorGuards(page: Page): string[] {
  const errors: string[] = []
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', error => errors.push(error.message))
  return errors
}

async function hideUnrelatedOverlays(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const selector of [
      '.toast-stack',
      '.toast',
      '.we-onboarding-banner',
      '.we-budget-blocked-banner',
      '[data-testid="command-palette"]',
    ]) {
      for (const element of document.querySelectorAll<HTMLElement>(selector)) {
        element.style.display = 'none'
      }
    }
  })
}

async function capture(locator: Locator, name: string): Promise<void> {
  await expect(locator).toBeVisible()
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  expect(box?.width ?? 0).toBeGreaterThan(0)
  expect(box?.height ?? 0).toBeGreaterThan(0)
  if (!EVIDENCE_DIR) return
  await mkdir(EVIDENCE_DIR, { recursive: true })
  await locator.screenshot({
    path: `${EVIDENCE_DIR}/${name}.png`,
    animations: 'disabled',
    caret: 'hide',
  })
}

test('queue pressure stays private, observable, and clear in English and Spanish', async ({ page, request }) => {
  test.setTimeout(120_000)
  const browserErrors = installErrorGuards(page)
  const orgId = `queue-pressure-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  const publicResponse = await request.get(`${API_URL}/health`)
  expect(publicResponse.ok()).toBe(true)
  const publicBody = await publicResponse.json() as {
    ok: boolean
    queue: { degraded: boolean } | null
  }
  expect(publicBody.ok).toBe(true)
  if (publicBody.queue !== null) {
    expect(Object.keys(publicBody.queue)).toEqual(['degraded'])
    expect(typeof publicBody.queue.degraded).toBe('boolean')
  }

  const adminResponse = await request.get(`${API_URL}/system/queue`, { headers: headers(orgId) })
  expect(adminResponse.ok()).toBe(true)
  const adminBody = await adminResponse.json() as QueueRouteState
  expect(adminBody).not.toBeNull()
  expect(adminBody).not.toBe('protocol-error')
  if (adminBody === null || adminBody === 'protocol-error') throw new Error('queue health unavailable')
  expect(adminBody).toMatchObject({ warnSeconds: 60 })
  expect(adminBody.waiting).toBeGreaterThanOrEqual(0)
  expect(adminBody.active).toBeGreaterThanOrEqual(0)
  expect(adminBody.maintenance).toMatchObject({ warnSeconds: 300 })

  expect(API_METRICS_URL).toBeTruthy()
  expect(WORKER_METRICS_URL).toBeTruthy()
  const [apiMetrics, workerMetrics] = await Promise.all([
    request.get(API_METRICS_URL as string),
    request.get(WORKER_METRICS_URL as string),
  ])
  expect(apiMetrics.ok()).toBe(true)
  expect(workerMetrics.ok()).toBe(true)
  await expect(apiMetrics.text()).resolves.toContain('janusly_rate_limit_degraded_buckets')
  const workerMetricsText = await workerMetrics.text()
  expect(workerMetricsText).toContain('workflow_queue_waiting_jobs')
  expect(workerMetricsText).toContain('workflow_queue_active_jobs')
  expect(workerMetricsText).toContain('maintenance_queue_waiting_jobs')
  expect(workerMetricsText).toContain('maintenance_queue_active_jobs')
  expect(workerMetricsText).toContain('janusly_rate_limit_degraded_buckets')

  let queueState: QueueRouteState = 'protocol-error'
  let queueRequestCount = 0
  await page.route('**/system/queue', async (route) => {
    queueRequestCount += 1
    if (queueState === 'protocol-error') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'malformed queue telemetry response' }),
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(queueState),
    })
  })
  await page.addInitScript(({ activeOrg }) => {
    window.localStorage.setItem('janusly:activeOrg', activeOrg)
    window.localStorage.setItem('janusly:recovery:hideIntro', 'true')
  }, { activeOrg: orgId })
  // Keep the production 20s cadence in application code while making this
  // real-browser smoke exercise poll-driven transitions without a 200s test.
  await page.addInitScript(() => {
    const nativeSetInterval = window.setInterval.bind(window)
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) =>
      nativeSetInterval(handler, timeout === 20_000 ? 100 : timeout, ...args)) as typeof window.setInterval
  })

  const states = [
    {
      name: 'transport-unavailable',
      value: 'protocol-error',
      expectedState: 'unavailable',
      copyKey: 'transportUnavailable',
    },
    {
      name: 'clear',
      value: { waiting: 0, active: 1, oldestWaitingSeconds: null, warnSeconds: 60 },
      expectedState: 'clear',
      copyKey: 'clear',
    },
    {
      name: 'processing',
      value: { waiting: 2, active: 1, oldestWaitingSeconds: 40, warnSeconds: 60 },
      expectedState: 'processing',
      copyKey: 'processing',
    },
    {
      name: 'delayed',
      value: { waiting: 2, active: 1, oldestWaitingSeconds: 125, warnSeconds: 60 },
      expectedState: 'delayed',
      copyKey: 'delayed',
    },
    {
      name: 'delayed-idle',
      value: { waiting: 2, active: 0, oldestWaitingSeconds: 125, warnSeconds: 60 },
      expectedState: 'delayed',
      copyKey: 'delayedIdle',
    },
    { name: 'unavailable', value: null, expectedState: 'unavailable', copyKey: 'unavailable' },
  ] as const

  // Establish the web origin before mutating localStorage between locale runs.
  // Playwright's initial about:blank document denies localStorage access.
  await page.goto('/')
  for (const locale of ['en', 'es'] as const) {
    await page.evaluate(selectedLocale => {
      window.localStorage.setItem('janusly:locale', selectedLocale)
    }, locale)
    queueState = states[0].value
    await page.goto('/')
    await hideUnrelatedOverlays(page)
    await page.getByRole('button', { name: copy[locale].operations, exact: true }).click()
    const chip = page.getByTestId('queue-lag-chip')
    for (const state of states) {
      const requestsBeforeTransition = queueRequestCount
      queueState = state.value
      await expect(chip).toHaveAttribute('data-state', state.expectedState)
      await expect(chip).toContainText(copy[locale][state.copyKey])
      if (state !== states[0]) {
        await expect.poll(() => queueRequestCount).toBeGreaterThan(requestsBeforeTransition)
      }
      if (state.name === 'delayed') {
        await expect(chip).toContainText(locale === 'en'
          ? 'Jobs are still processing'
          : 'Los trabajos siguen en proceso')
      }
      if (state.name === 'delayed-idle') {
        await expect(chip).not.toContainText(locale === 'en'
          ? 'Jobs are still processing'
          : 'Los trabajos siguen en proceso')
      }
      await hideUnrelatedOverlays(page)
      await capture(chip, `web-${locale}-queue-lag-${state.name}`)
    }

    const requestsBeforeMaintenance = queueRequestCount
    queueState = {
      waiting: 0,
      active: 1,
      oldestWaitingSeconds: null,
      warnSeconds: 60,
      maintenance: locale === 'en'
        ? { waiting: 2, active: 0, oldestWaitingSeconds: 301, warnSeconds: 300 }
        : { waiting: 0, active: 1, oldestWaitingSeconds: null, warnSeconds: 300 },
    }
    const maintenanceChip = page.getByTestId('maintenance-queue-lag-chip')
    await expect.poll(() => queueRequestCount).toBeGreaterThan(requestsBeforeMaintenance)
    await expect(chip).toHaveAttribute('data-state', 'clear')
    await expect(maintenanceChip).toHaveAttribute('data-state', locale === 'en' ? 'delayed' : 'clear')
    await expect(maintenanceChip).toContainText(locale === 'en'
      ? copy.en.maintenanceDelayed
      : copy.es.maintenanceClear)
    await hideUnrelatedOverlays(page)
    await capture(
      page.locator('.we-operations-header'),
      `web-${locale}-workflow-maintenance-queues`,
    )
  }

  await page.setViewportSize({ width: 390, height: 844 })
  const mobileHeader = page.locator('.we-operations-header')
  await expect(page.getByTestId('maintenance-queue-lag-chip')).toBeVisible()
  expect(await mobileHeader.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  await capture(mobileHeader, 'web-es-workflow-maintenance-queues-mobile')

  expect(browserErrors).toEqual([])
})
