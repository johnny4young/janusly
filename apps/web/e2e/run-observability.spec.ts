import { mkdir } from 'node:fs/promises'
import { expect, test, type Locator, type Page, type Route } from '@playwright/test'
import { pollUntilTerminal, pollUntilWaitingOrTerminal, startRun } from './_helpers/demo-helpers'

const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR

function installConsoleErrorGuards(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

async function hideUnrelatedOverlays(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const selector of ['.toast-stack', '.we-onboarding-banner', '.we-budget-banner']) {
      for (const element of document.querySelectorAll<HTMLElement>(selector)) element.style.display = 'none'
    }
  })
}

async function captureElement(locator: Locator, name: string): Promise<void> {
  await expect(locator).toBeVisible()
  if (!EVIDENCE_DIR) return
  await mkdir(EVIDENCE_DIR, { recursive: true })
  await locator.screenshot({ path: `${EVIDENCE_DIR}/${name}.png` })
}

function matchesRunsFilter(rawUrl: string, workflowId: string, status: string): boolean {
  const url = new URL(rawUrl)
  return url.pathname.endsWith('/runs')
    && url.searchParams.get('workflowId') === workflowId
    && url.searchParams.get('status') === status
}

async function openRuns(page: Page, locale: 'en' | 'es'): Promise<void> {
  await page.getByRole('button', { name: locale === 'en' ? 'Runs' : 'Ejecuciones', exact: true }).click()
  await expect(page.getByTestId('runs-history-virtual-list')).toBeVisible()
}

async function openRunFromHistory(page: Page, runId: string): Promise<void> {
  const history = page.getByTestId('runs-history-virtual-list')
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
  throw new Error(`Run ${runId} was not present in the bounded history page`)
}

test('active runs explain identity, trigger, chronology, and waits in both locales', async ({ page, request }) => {
  const browserErrors = installConsoleErrorGuards(page)
  const stamp = Date.now()
  const failedName = `E2E Failed invoice ${stamp}`
  const waitingName = `E2E Approval ${stamp}`
  const longName = `E2E Long timeline ${stamp}`

  const failed = await startRun(request, {
    id: `e2e-observability-failed-${stamp}`,
    name: failedName,
    nodes: [{
      id: 'fetch_invoice',
      type: 'http',
      config: { url: '{{secret.E2E_OBSERVABILITY_MISSING_URL}}' },
    }],
    edges: [],
  }, { invoiceId: `inv-${stamp}`, source: 'billing-webhook' })
  expect((await pollUntilTerminal(request, failed.runId)).status).toBe('failed')

  const waiting = await startRun(request, {
    id: `e2e-observability-waiting-${stamp}`,
    name: waitingName,
    nodes: [{
      id: 'approve_refund',
      type: 'approval',
      config: {
        message: 'Finance sign-off',
        title: 'Approve refund evidence',
        description: 'Confirm the invoice and customer history before release.',
      },
    }],
    edges: [],
  }, { invoiceId: `inv-${stamp}`, amountUsd: 49 })
  const waitingSnapshot = await pollUntilWaitingOrTerminal(request, waiting.runId, 'approve_refund')
  expect(waitingSnapshot.status).toBe('running')
  expect(waitingSnapshot.nodes.find(node => node.nodeId === 'approve_refund')?.status).toBe('waiting')

  const long = await startRun(request, {
    id: `e2e-observability-long-${stamp}`,
    name: longName,
    nodes: Array.from({ length: 75 }, (_, index) => ({
      id: `step_${String(index).padStart(2, '0')}`,
      type: 'noop',
      config: {},
    })),
    // Keep the smoke deterministic: a sequential long run produces more than
    // one bounded event page without flooding the worker with 75 simultaneous
    // roots (which would test queue saturation rather than timeline paging).
    edges: Array.from({ length: 74 }, (_, index) => ({
      from: `step_${String(index).padStart(2, '0')}`,
      to: `step_${String(index + 1).padStart(2, '0')}`,
    })),
  }, { source: 'long-run-smoke' })
  expect((await pollUntilTerminal(request, long.runId)).status).toBe('succeeded')

  await page.goto('/')
  await hideUnrelatedOverlays(page)
  await openRuns(page, 'en')
  await openRunFromHistory(page, failed.runId)

  const englishOverview = page.getByTestId('run-overview')
  await expect(englishOverview).toContainText(failedName)
  await expect(englishOverview).toContainText('Needs attention')
  await expect(englishOverview).toContainText('Trace ID')
  await expect(page.getByRole('status', { name: /Live run connection: Polling/ })).toBeVisible()
  await captureElement(englishOverview, 'web-en-run-overview-failed-default')

  const englishInput = page.getByTestId('run-trigger-input')
  await englishInput.locator('summary').click()
  await expect(englishInput).toContainText(`inv-${stamp}`)
  await expect(englishInput).toContainText('billing-webhook')
  await captureElement(englishOverview, 'web-en-run-overview-trigger-expanded')

  await englishOverview.getByRole('button', { name: 'View timeline', exact: true }).click()
  const englishTimeline = page.getByTestId('run-event-timeline')
  await expect(englishTimeline.locator('[data-tone="error"]')).not.toHaveCount(0)
  await expect(englishTimeline.locator('[data-noise="true"]')).not.toHaveCount(0)
  await expect(englishTimeline.locator('time')).not.toHaveCount(0)
  await expect(englishTimeline.locator('[aria-label$="since the previous event"]')).not.toHaveCount(0)
  await captureElement(englishTimeline, 'web-en-run-events-failed-timeline')

  const englishEventFilter = englishTimeline.getByTestId('run-event-filter')
  await englishEventFilter.fill('fetch_invoice')
  await expect(englishTimeline.getByRole('listitem')).not.toHaveCount(0)
  await expect(englishTimeline.getByText(/of \d+ events?/)).toBeVisible()
  await captureElement(englishTimeline, 'web-en-run-events-filtered-node')

  await englishEventFilter.fill('event-that-does-not-exist')
  await expect(englishTimeline).toContainText('No matching events')
  await captureElement(englishTimeline, 'web-en-run-events-filter-empty')
  await englishTimeline.getByRole('button', { name: 'Clear filter' }).click()

  await englishTimeline.getByRole('button', { name: 'Jump to first failure' }).click()
  const englishFirstFailure = englishTimeline.getByRole('listitem').filter({ hasText: 'Step fetch_invoice failed' })
  await expect(englishFirstFailure).toBeFocused()
  await captureElement(englishTimeline, 'web-en-run-events-first-failure')

  await openRuns(page, 'en')
  await openRunFromHistory(page, long.runId)
  await page.getByTestId('run-overview').getByRole('button', { name: 'View timeline', exact: true }).click()
  const englishLoadedTimeline = page.getByTestId('run-event-timeline')
  await expect(englishLoadedTimeline.getByText(/\d+ of \d+ loaded events/)).toBeVisible()
  await expect(englishLoadedTimeline.getByRole('button', { name: 'Jump to first loaded failure' })).toBeDisabled()
  await expect(englishLoadedTimeline.getByRole('button', { name: 'Load older events' })).toBeVisible()
  await captureElement(englishLoadedTimeline, 'web-en-run-events-loaded-page')
  await englishLoadedTimeline.getByTestId('run-event-filter').fill('event-that-does-not-exist')
  await expect(englishLoadedTimeline).toContainText('No loaded events match. Load older events to search more history.')
  await captureElement(englishLoadedTimeline, 'web-en-run-events-loaded-filter-empty')

  await openRuns(page, 'en')
  await openRunFromHistory(page, waiting.runId)
  const englishWaiting = page.getByTestId('waiting-steps')
  await expect(englishWaiting).toContainText('Approval')
  await expect(englishWaiting).toContainText('Approve refund evidence')
  await expect(englishWaiting).toContainText('Confirm the invoice and customer history before release.')
  await expect(englishWaiting).toContainText('Waiting for')
  await expect(englishWaiting.getByRole('button', { name: 'Approve and resume' })).toBeVisible()
  await captureElement(englishWaiting, 'web-en-run-waiting-approval')

  await page.evaluate(() => window.localStorage.setItem('janusly:locale', 'es'))
  await page.reload()
  await hideUnrelatedOverlays(page)
  await openRuns(page, 'es')
  await openRunFromHistory(page, failed.runId)

  const spanishOverview = page.getByTestId('run-overview')
  await expect(spanishOverview).toContainText('Necesita atención')
  await expect(spanishOverview).toContainText('ID de traza')
  const spanishInput = page.getByTestId('run-trigger-input')
  await spanishInput.locator('summary').click()
  await expect(spanishInput).toContainText('Entrada que inició la ejecución')
  await expect(spanishInput).toContainText(`inv-${stamp}`)
  await captureElement(spanishOverview, 'web-es-run-overview-trigger-expanded')

  await spanishOverview.getByRole('button', { name: 'Ver cronología', exact: true }).click()
  const spanishTimeline = page.getByTestId('run-event-timeline')
  await expect(spanishTimeline.locator('[data-tone="error"]')).not.toHaveCount(0)
  await expect(spanishTimeline.locator('[aria-label$="desde el evento anterior"]')).not.toHaveCount(0)
  await captureElement(spanishTimeline, 'web-es-run-events-failed-timeline')

  const spanishEventFilter = spanishTimeline.getByTestId('run-event-filter')
  await spanishEventFilter.fill('fetch_invoice')
  await expect(spanishTimeline.getByRole('listitem')).not.toHaveCount(0)
  await captureElement(spanishTimeline, 'web-es-run-events-filtered-node')
  await spanishTimeline.getByRole('button', { name: 'Ir al primer fallo' }).click()
  const spanishFirstFailure = spanishTimeline.getByRole('listitem').filter({ hasText: 'Paso fetch_invoice falló' })
  await expect(spanishFirstFailure).toBeFocused()
  await captureElement(spanishTimeline, 'web-es-run-events-first-failure')

  await openRuns(page, 'es')
  await openRunFromHistory(page, long.runId)
  await page.getByTestId('run-overview').getByRole('button', { name: 'Ver cronología', exact: true }).click()
  const spanishLoadedTimeline = page.getByTestId('run-event-timeline')
  await expect(spanishLoadedTimeline.getByText(/\d+ de \d+ eventos cargados/)).toBeVisible()
  await expect(spanishLoadedTimeline.getByRole('button', { name: 'Ir al primer fallo cargado' })).toBeDisabled()
  await expect(spanishLoadedTimeline.getByRole('button', { name: 'Cargar eventos anteriores' })).toBeVisible()
  await captureElement(spanishLoadedTimeline, 'web-es-run-events-loaded-page')
  await spanishLoadedTimeline.getByTestId('run-event-filter').fill('evento-inexistente')
  await expect(spanishLoadedTimeline).toContainText('Ningún evento cargado coincide.')
  await captureElement(spanishLoadedTimeline, 'web-es-run-events-loaded-filter-empty')

  await openRuns(page, 'es')
  await openRunFromHistory(page, waiting.runId)
  const spanishWaiting = page.getByTestId('waiting-steps')
  await expect(spanishWaiting).toContainText('Aprobación')
  await expect(spanishWaiting).toContainText('En espera durante')
  await expect(spanishWaiting.getByRole('button', { name: 'Aprobar y reanudar' })).toBeVisible()
  await captureElement(spanishWaiting, 'web-es-run-waiting-approval')

  expect(browserErrors).toEqual([])
})

test('run history filters and compares a failure with its strictly preceding success in both locales', async ({ page, request }) => {
  const browserErrors = installConsoleErrorGuards(page)
  const stamp = Date.now()
  const workflowId = `e2e-history-diagnostic-${stamp}`
  const workflowName = `E2E Billing diagnostic ${stamp}`
  const noBaselineWorkflowId = `e2e-history-no-baseline-${stamp}`
  const noBaselineWorkflowName = `E2E No baseline ${stamp}`

  const successful = await startRun(request, {
    id: workflowId,
    name: workflowName,
    nodes: [{ id: 'process_invoice', type: 'noop', config: {} }],
    edges: [],
  }, { invoiceId: `inv-green-${stamp}` })
  expect((await pollUntilTerminal(request, successful.runId)).status).toBe('succeeded')

  const failed = await startRun(request, {
    id: workflowId,
    name: workflowName,
    nodes: [{
      id: 'process_invoice',
      type: 'http',
      config: { url: '{{secret.E2E_HISTORY_DIAGNOSTIC_MISSING_URL}}' },
    }],
    edges: [],
  }, { invoiceId: `inv-failed-${stamp}` })
  expect((await pollUntilTerminal(request, failed.runId)).status).toBe('failed')

  const noBaselineFailure = await startRun(request, {
    id: noBaselineWorkflowId,
    name: noBaselineWorkflowName,
    nodes: [{
      id: 'process_invoice',
      type: 'http',
      config: { url: '{{secret.E2E_HISTORY_NO_BASELINE_MISSING_URL}}' },
    }],
    edges: [],
  }, { invoiceId: `inv-no-baseline-${stamp}` })
  expect((await pollUntilTerminal(request, noBaselineFailure.runId)).status).toBe('failed')

  await page.goto('/')
  await hideUnrelatedOverlays(page)
  await openRuns(page, 'en')
  const englishHistory = page.getByTestId('run-history')
  await expect(englishHistory).toContainText(workflowName)
  await captureElement(englishHistory, 'web-en-run-history-default')
  await page.getByTestId('run-history-workflow-filter').selectOption({ label: workflowName })

  let releaseFilteredRequest!: () => void
  const filteredRequestHold = new Promise<void>(resolve => { releaseFilteredRequest = resolve })
  const delayFilteredRequest = async (route: Route) => {
    if (matchesRunsFilter(route.request().url(), workflowId, 'failed')) await filteredRequestHold
    await route.continue()
  }
  await page.route('**/v1/runs**', delayFilteredRequest)
  const filteredResponse = page.waitForResponse(response => matchesRunsFilter(response.url(), workflowId, 'failed'))
  await page.getByTestId('run-history-status-filter').selectOption('failed')

  await expect(englishHistory).toContainText('Loading matching runs…')
  await captureElement(englishHistory, 'web-en-run-history-filter-loading')
  releaseFilteredRequest()
  expect((await filteredResponse).ok()).toBe(true)
  await page.unroute('**/v1/runs**', delayFilteredRequest)
  await expect(englishHistory).toContainText('1 run')
  await expect(englishHistory).toContainText(workflowName)
  await expect(englishHistory).toContainText('Needs attention')
  await captureElement(englishHistory, 'web-en-run-history-filtered-failure')

  const emptyResponse = page.waitForResponse(response => matchesRunsFilter(response.url(), workflowId, 'timed_out'))
  await page.getByTestId('run-history-status-filter').selectOption('timed_out')
  expect((await emptyResponse).ok()).toBe(true)
  await expect(englishHistory).toContainText('No matching runs')
  await captureElement(englishHistory, 'web-en-run-history-filter-empty')

  await page.getByTestId('run-history-clear-filters').click()
  await expect(page.getByTestId('run-history-workflow-filter')).toHaveValue('')
  await expect(page.getByTestId('run-history-status-filter')).toHaveValue('')
  await expect(englishHistory).toContainText(workflowName)
  await captureElement(englishHistory, 'web-en-run-history-filters-cleared')

  await page.evaluate(({ id }) => {
    const realFetch = window.fetch.bind(window)
    window.fetch = (input, init) => {
      const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input.url
      const url = new URL(rawUrl, window.location.href)
      if (url.pathname.endsWith('/runs')
        && url.searchParams.get('workflowId') === id
        && url.searchParams.get('status') === 'cancelled') {
        return Promise.reject(new TypeError('Simulated caught history request failure'))
      }
      return realFetch(input, init)
    }
  }, { id: workflowId })
  await page.getByTestId('run-history-workflow-filter').selectOption({ label: workflowName })
  await page.getByTestId('run-history-status-filter').selectOption('cancelled')
  await expect(englishHistory.getByRole('alert')).toContainText('Could not load the filtered run history.')
  await captureElement(englishHistory, 'web-en-run-history-filter-error')

  await page.reload()
  await hideUnrelatedOverlays(page)
  await openRuns(page, 'en')
  await page.getByTestId('run-history-workflow-filter').selectOption({ label: workflowName })

  const restoredResponse = page.waitForResponse(response => matchesRunsFilter(response.url(), workflowId, 'failed'))
  await page.getByTestId('run-history-status-filter').selectOption('failed')
  expect((await restoredResponse).ok()).toBe(true)
  await expect(page.getByTestId(`history-compare-last-successful-${failed.runId}`)).toBeVisible()

  let releaseBaselineRequest!: () => void
  const baselineRequestHold = new Promise<void>(resolve => { releaseBaselineRequest = resolve })
  const delayBaselineRequest = async (route: Route) => {
    if (matchesRunsFilter(route.request().url(), workflowId, 'succeeded')) await baselineRequestHold
    await route.continue()
  }
  await page.route('**/v1/runs**', delayBaselineRequest)
  await page.getByTestId(`history-compare-last-successful-${failed.runId}`).click()
  const englishDialog = page.getByTestId('run-history-comparison-dialog')
  await expect(englishDialog).toContainText('Compare with last successful')
  await expect(englishDialog).toContainText('Finding the preceding successful run…')
  await captureElement(englishDialog, 'web-en-run-history-comparison-loading')
  releaseBaselineRequest()
  await expect(englishDialog).toContainText(successful.runId.slice(0, 12))
  await page.unroute('**/v1/runs**', delayBaselineRequest)
  await expect(englishDialog).toContainText(failed.runId.slice(0, 12))
  await expect(englishDialog.getByTestId('comparison-row-process_invoice')).toBeVisible()
  await expect(englishDialog.getByRole('columnheader', { name: 'Last successful' })).toBeVisible()
  await expect(englishDialog.getByRole('columnheader', { name: 'Selected run' })).toBeVisible()
  await captureElement(englishDialog, 'web-en-run-history-last-successful-comparison')
  await englishDialog.getByRole('button', { name: 'Close' }).last().click()

  const noBaselineResponse = page.waitForResponse(response =>
    matchesRunsFilter(response.url(), noBaselineWorkflowId, 'failed'))
  await page.getByTestId('run-history-workflow-filter').selectOption({ label: noBaselineWorkflowName })
  expect((await noBaselineResponse).ok()).toBe(true)
  await page.getByTestId(`history-compare-last-successful-${noBaselineFailure.runId}`).click()
  const missingDialog = page.getByTestId('run-history-comparison-dialog')
  await expect(missingDialog).toContainText('No earlier successful run')
  await captureElement(missingDialog, 'web-en-run-history-comparison-no-baseline')
  await missingDialog.getByRole('button', { name: 'Close' }).last().click()

  const comparisonErrorHistoryResponse = page.waitForResponse(response =>
    matchesRunsFilter(response.url(), workflowId, 'failed'))
  await page.getByTestId('run-history-workflow-filter').selectOption({ label: workflowName })
  expect((await comparisonErrorHistoryResponse).ok()).toBe(true)
  await page.evaluate(() => {
    const realFetch = window.fetch.bind(window)
    let rejectNextComparison = true
    window.fetch = (input, init) => {
      const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input.url
      const url = new URL(rawUrl, window.location.href)
      if (rejectNextComparison && url.pathname.endsWith('/runs/compare')) {
        rejectNextComparison = false
        return Promise.reject(new TypeError('Simulated caught comparison request failure'))
      }
      return realFetch(input, init)
    }
  })
  await page.getByTestId(`history-compare-last-successful-${failed.runId}`).click()
  const errorDialog = page.getByTestId('run-history-comparison-dialog')
  await expect(errorDialog.getByRole('alert')).toContainText('Could not load the historical comparison.')
  await captureElement(errorDialog, 'web-en-run-history-comparison-error')
  await errorDialog.getByRole('button', { name: 'Retry' }).click()
  await expect(errorDialog.getByTestId('comparison-row-process_invoice')).toBeVisible()
  await errorDialog.getByRole('button', { name: 'Close' }).last().click()

  await page.evaluate(() => window.localStorage.setItem('janusly:locale', 'es'))
  await page.reload()
  await hideUnrelatedOverlays(page)
  await openRuns(page, 'es')
  await page.getByTestId('run-history-workflow-filter').selectOption({ label: workflowName })
  await expect(page.getByTestId('run-history-status-filter').getByRole('option', { name: 'Tiempo agotado' })).toHaveCount(1)
  const spanishFilteredResponse = page.waitForResponse(response => matchesRunsFilter(response.url(), workflowId, 'failed'))
  await page.getByTestId('run-history-status-filter').selectOption('failed')
  expect((await spanishFilteredResponse).ok()).toBe(true)

  const spanishHistory = page.getByTestId('run-history')
  await expect(spanishHistory).toContainText('1 ejecución')
  await expect(spanishHistory).toContainText('Necesita atención')
  await captureElement(spanishHistory, 'web-es-run-history-filtered-failure')

  await page.getByTestId(`history-compare-last-successful-${failed.runId}`).click()
  const spanishDialog = page.getByTestId('run-history-comparison-dialog')
  await expect(spanishDialog).toContainText('Comparar con la última exitosa')
  await expect(spanishDialog.getByRole('columnheader', { name: 'Última exitosa' })).toBeVisible()
  await expect(spanishDialog.getByRole('columnheader', { name: 'Seleccionada' })).toBeVisible()
  await captureElement(spanishDialog, 'web-es-run-history-last-successful-comparison')

  expect(browserErrors).toEqual([])
})
