import { mkdir } from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'

const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR

function installConsoleErrorGuards(page: Page) {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('response', (response) => {
    if (response.status() >= 400) {
      errors.push(`${response.status()} ${new URL(response.url()).pathname}`)
    }
  })
  return errors
}

async function captureEvidence(locator: Locator, name: string): Promise<void> {
  await expect(locator).toBeVisible()
  if (!EVIDENCE_DIR) return
  await mkdir(EVIDENCE_DIR, { recursive: true })
  await locator.screenshot({ path: `${EVIDENCE_DIR}/${name}.png` })
}

async function dismissToasts(page: Page): Promise<void> {
  const toasts = page.locator('.toast-stack .toast')
  while ((await toasts.count()) > 0) await toasts.first().click()
  await expect(toasts).toHaveCount(0)
}

async function prepareSession(page: Page, locale: 'en' | 'es'): Promise<void> {
  const orgId = `solution-packs-${locale}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await page.addInitScript(({ activeOrg, selectedLocale }) => {
    window.localStorage.setItem('janusly:activeOrg', activeOrg)
    window.localStorage.setItem('janusly:locale', selectedLocale)
  }, { activeOrg: orgId, selectedLocale: locale })
}

test('Solution Packs install, sample-run, and recovery-drill flows work from the UI', async ({ page }) => {
  const browserErrors = installConsoleErrorGuards(page)

  await prepareSession(page, 'en')
  await page.goto('/')
  await expect(page.getByText('dev-user')).toBeVisible()

  await page.getByRole('button', { name: 'Packs', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Solution Packs', exact: true })).toBeVisible()

  const incidentPack = page.locator('.list-card').filter({ hasText: 'Incident triage' }).first()
  await expect(incidentPack).toBeVisible()
  await expect(incidentPack.getByLabel('ops_github missing (github_token)')).toBeVisible()
  await expect(incidentPack.getByLabel('ops_slack missing (slack_webhook)')).toBeVisible()
  const drillSelect = incidentPack.getByLabel('Failure scenario')
  await drillSelect.selectOption('worker_interrupted_during_page')
  await expect(incidentPack.getByText('Worker interrupted', { exact: true })).toBeVisible()
  await expect(incidentPack.getByText('Real reaper path')).toBeVisible()
  await expect(incidentPack.getByText(/real stalled-node reaper/)).toBeVisible()
  await captureEvidence(incidentPack, 'solution-packs-en-worker-interruption-drill')

  await incidentPack.getByRole('button', { name: 'Install', exact: true }).click()
  await expect(page.getByText(/Pack installed/)).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Step setup', exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Incident triage')
  await expect(page.locator('.workflow-node').filter({ hasText: 'Run a tool' })).toHaveCount(2)

  await page.getByRole('button', { name: 'Packs', exact: true }).click()
  await incidentPack.getByRole('button', { name: 'Preview sample run', exact: true }).click()
  await expect(page.getByText('Sample run started in the sandbox.')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Runs', exact: true })).toBeVisible()
  await expect(page.getByTestId('run-overview').locator('.status-pill[data-status]')).toBeVisible({ timeout: 30_000 })

  await page.getByRole('button', { name: 'Packs', exact: true }).click()
  await incidentPack.getByLabel('Failure scenario').selectOption('worker_interrupted_during_page')
  const requestPromise = page.waitForRequest((request) => request.url().endsWith('/solution-packs/incident-triage/inject-failure'))
  const responsePromise = page.waitForResponse((response) => response.url().endsWith('/solution-packs/incident-triage/inject-failure'))
  await incidentPack.getByRole('button', { name: 'Start recovery drill', exact: true }).click()
  expect((await requestPromise).postDataJSON()).toEqual({ fixtureId: 'worker_interrupted_during_page' })
  const drillResponse = await responsePromise
  expect(drillResponse.status()).toBe(200)
  const drillBody = await drillResponse.json()
  expect(drillBody).toMatchObject({
    failureMode: 'worker_stalled',
    recoveryPath: 'stalled_node_reaper',
    evidence: { recoveryPath: 'stalled_node_reaper', scanned: 1, reaped: 1, deadLettered: 1 },
  })
  expect(drillBody.evidence.thresholdMinutes).toBeGreaterThanOrEqual(15)
  expect(drillBody.evidence.thresholdMinutes).toBeLessThanOrEqual(1440)
  expect(drillBody.evidence.simulatedStallMs).toBe(drillBody.evidence.thresholdMinutes * 60_000 + 1_000)
  await expect(page.getByText('Recovery drill created')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Runs', exact: true })).toBeVisible()
  const focusedFailure = page.locator('[data-testid^="dlq-row-"][data-selected="true"]').filter({ hasText: 'page_oncall' }).first()
  await expect(focusedFailure).toBeVisible({ timeout: 30_000 })
  await expect(focusedFailure).toBeFocused()
  const targetInMainViewport = await focusedFailure.evaluate((node) => {
    const main = node.closest('.workspace-main')
    if (!main) return false
    const target = node.getBoundingClientRect()
    const viewport = main.getBoundingClientRect()
    return target.top >= viewport.top - 2 && target.bottom <= viewport.bottom + 2
  })
  expect(targetInMainViewport).toBe(true)
  const drillContext = page.getByTestId('dlq-recovery-drill-context')
  await expect(drillContext).toContainText('Recovery drill')
  await expect(drillContext).toContainText('Real reaper path')
  await expect(page.getByText(/worker_stalled/)).toBeVisible()
  await dismissToasts(page)
  await captureEvidence(page.getByTestId('recovery-queue'), 'solution-packs-en-worker-interruption-recovery-queue')

  expect(browserErrors).toEqual([])
})

test('Spanish recovery drills remain usable on mobile without horizontal overflow', async ({ page }) => {
  const browserErrors = installConsoleErrorGuards(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await prepareSession(page, 'es')
  await page.goto('/')
  await page.getByRole('button', { name: 'Navegación' }).click()
  await page.locator('#workspace-sidebar').getByRole('button', { name: 'Packs', exact: true }).click()

  await expect(page.getByRole('heading', { name: 'Solution Packs', exact: true })).toBeVisible()
  const incidentPack = page.locator('.list-card').filter({ hasText: 'Triage de incidentes' }).first()
  await expect(incidentPack).toBeVisible()
  await incidentPack.getByLabel('Escenario de fallo').selectOption('github_contract_drift')
  await expect(incidentPack.getByText('Cambio de contrato')).toBeVisible()
  await expect(incidentPack.getByText('Escenario determinista')).toBeVisible()
  await expect(incidentPack.getByText(/sin la URL que requiere el siguiente paso/)).toBeVisible()
  await captureEvidence(incidentPack, 'solution-packs-es-contract-drift-mobile')

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(2)

  await incidentPack.getByRole('button', { name: 'Iniciar ejercicio de recuperación', exact: true }).click()
  await expect(page.getByText('Ejercicio de recuperación creado')).toBeVisible()
  const focusedFailure = page.locator('[data-testid^="dlq-row-"][data-selected="true"]').filter({ hasText: 'open_issue' }).first()
  await expect(focusedFailure).toBeVisible({ timeout: 30_000 })
  const drillContext = page.getByTestId('dlq-recovery-drill-context')
  await expect(drillContext).toContainText('Ejercicio de recuperación')
  await expect(drillContext).toContainText('Escenario determinista')
  await dismissToasts(page)
  await captureEvidence(page.getByTestId('recovery-queue'), 'solution-packs-es-contract-drift-recovery-queue')

  expect(browserErrors).toEqual([])
})
