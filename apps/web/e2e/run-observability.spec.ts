import { mkdir } from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
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

async function openRuns(page: Page, locale: 'en' | 'es'): Promise<void> {
  await page.getByRole('button', { name: locale === 'en' ? 'Runs' : 'Ejecuciones', exact: true }).click()
  await expect(page.getByTestId('runs-history-virtual-list')).toBeVisible()
}

async function openRunFromHistory(page: Page, runId: string): Promise<void> {
  const history = page.getByTestId('runs-history-virtual-list')
  const prefix = `${runId.slice(0, 8)}…`
  await history.evaluate(element => element.scrollTo({ top: 0 }))
  for (let offset = 0; offset < 100; offset += 4) {
    const card = history.getByRole('group').filter({ hasText: prefix }).first()
    if (await card.isVisible().catch(() => false)) {
      await card.locator('button.list-card-row').click()
      await expect(page.getByTestId('run-overview')).toContainText(runId.slice(0, 12))
      return
    }
    const reachedEnd = await history.evaluate((element, rowOffset) => {
      element.scrollTo({ top: rowOffset * 226 })
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

  await page.goto('/')
  await hideUnrelatedOverlays(page)
  await openRuns(page, 'en')
  await openRunFromHistory(page, failed.runId)

  const englishOverview = page.getByTestId('run-overview')
  await expect(englishOverview).toContainText(failedName)
  await expect(englishOverview).toContainText('Needs attention')
  await expect(englishOverview).toContainText('Trace ID')
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

  await openRuns(page, 'es')
  await openRunFromHistory(page, waiting.runId)
  const spanishWaiting = page.getByTestId('waiting-steps')
  await expect(spanishWaiting).toContainText('Aprobación')
  await expect(spanishWaiting).toContainText('En espera durante')
  await expect(spanishWaiting.getByRole('button', { name: 'Aprobar y reanudar' })).toBeVisible()
  await captureElement(spanishWaiting, 'web-es-run-waiting-approval')

  expect(browserErrors).toEqual([])
})
