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
  await drillSelect.selectOption('classification_output_invalid')
  await expect(incidentPack.getByText('Invalid AI output')).toBeVisible()
  await expect(incidentPack.getByText(/outside the expected severity contract/)).toBeVisible()
  await captureEvidence(incidentPack, 'solution-packs-en-ai-output-drill')

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
  await incidentPack.getByLabel('Failure scenario').selectOption('classification_output_invalid')
  const requestPromise = page.waitForRequest((request) => request.url().endsWith('/solution-packs/incident-triage/inject-failure'))
  await incidentPack.getByRole('button', { name: 'Start recovery drill', exact: true }).click()
  expect((await requestPromise).postDataJSON()).toEqual({ fixtureId: 'classification_output_invalid' })
  await expect(page.getByText('Recovery drill created')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Runs', exact: true })).toBeVisible()
  const focusedFailure = page.locator('[data-testid^="dlq-row-"][data-selected="true"]').filter({ hasText: 'classify' }).first()
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
  await captureEvidence(page.getByTestId('recovery-queue'), 'solution-packs-en-ai-output-recovery-queue')

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
  await expect(incidentPack.getByText(/sin la URL que requiere el siguiente paso/)).toBeVisible()
  await captureEvidence(incidentPack, 'solution-packs-es-contract-drift-mobile')

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(2)

  await incidentPack.getByRole('button', { name: 'Iniciar ejercicio de recuperación', exact: true }).click()
  await expect(page.getByText('Ejercicio de recuperación creado')).toBeVisible()
  const focusedFailure = page.locator('[data-testid^="dlq-row-"][data-selected="true"]').filter({ hasText: 'open_issue' }).first()
  await expect(focusedFailure).toBeVisible({ timeout: 30_000 })
  await captureEvidence(page.getByTestId('recovery-queue'), 'solution-packs-es-contract-drift-recovery-queue')

  expect(browserErrors).toEqual([])
})
