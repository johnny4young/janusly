import { openWorkspaceSection } from './_helpers/workspace-navigation'
import { mkdir } from 'node:fs/promises'
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3001'
const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR

type DrillResponse = {
  deadLetterId: string
  runId: string
}

type DeadLetterDetail = {
  nodeId: string
  runId: string
  workflowJson: {
    nodes: Array<{ id: string; type: string; config: Record<string, unknown> }>
    [key: string]: unknown
  }
}

function authHeaders(orgId: string): Record<string, string> {
  return { 'x-org-id': orgId, 'x-user-id': 'dev-user' }
}

function installBrowserErrorGuards(page: Page) {
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

async function prepareSession(page: Page, locale: 'en' | 'es'): Promise<string> {
  const orgId = `drill-outcome-${locale}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await page.addInitScript(({ activeOrg, selectedLocale }) => {
    window.localStorage.setItem('janusly:activeOrg', activeOrg)
    window.localStorage.setItem('janusly:locale', selectedLocale)
  }, { activeOrg: orgId, selectedLocale: locale })
  return orgId
}

async function startContractDrill(page: Page, packName: string, actionName: string): Promise<DrillResponse> {
  const pack = page.locator('.list-card').filter({ hasText: packName }).first()
  await expect(pack).toBeVisible()
  await pack.locator('select').last().selectOption('github_contract_drift')
  const responsePromise = page.waitForResponse((response) => (
    response.url().endsWith('/solution-packs/incident-triage/inject-failure')
    && response.request().method() === 'POST'
  ))
  await pack.getByRole('button', { name: actionName, exact: true }).click()
  const response = await responsePromise
  expect(response.status()).toBe(200)
  return await response.json() as DrillResponse
}

async function waitForRunStatus(
  request: APIRequestContext,
  orgId: string,
  runId: string,
  expected: string,
): Promise<void> {
  await expect.poll(async () => {
    const response = await request.get(`${API_URL}/run?runId=${encodeURIComponent(runId)}`, {
      headers: authHeaders(orgId),
    })
    if (!response.ok()) return `http-${response.status()}`
    return ((await response.json()) as { run?: { status?: string } }).run?.status ?? 'missing'
  }, { timeout: 30_000 }).toBe(expected)
}

test('a successful drill replay exposes terminal recovery time and recurrence monitoring', async ({ page, request }) => {
  const browserErrors = installBrowserErrorGuards(page)
  const orgId = await prepareSession(page, 'en')

  await page.goto('/')
  await openWorkspaceSection(page, 'Workflows', 'Packs')
  const drill = await startContractDrill(page, 'Incident triage', 'Start recovery drill')

  const focusedFailure = page.locator(`[data-testid="dlq-row-${drill.deadLetterId}"]`)
  await expect(focusedFailure).toBeVisible({ timeout: 30_000 })
  const initialOutcome = page.getByTestId('dlq-recovery-drill-outcome')
  await expect(initialOutcome.getByRole('status')).toHaveText('Action needed')
  await expect(initialOutcome).toContainText('No terminal recovery evidence yet.')

  const detailResponse = await request.get(
    `${API_URL}/dlq?id=${encodeURIComponent(drill.deadLetterId)}`,
    { headers: authHeaders(orgId) },
  )
  expect(detailResponse.ok()).toBe(true)
  const detail = await detailResponse.json() as DeadLetterDetail
  const fixedWorkflow = structuredClone(detail.workflowJson)
  fixedWorkflow.nodes = fixedWorkflow.nodes.map((node) => node.id === detail.nodeId
    ? { id: node.id, type: 'noop', config: {} }
    : node)

  const replayResponse = await request.post(`${API_URL}/dlq/replay`, {
    headers: authHeaders(orgId),
    data: { deadLetterId: drill.deadLetterId, suggestedWorkflow: fixedWorkflow },
  })
  expect(replayResponse.ok()).toBe(true)
  await waitForRunStatus(request, orgId, detail.runId, 'succeeded')

  // Remount the queue after the API-driven replay so its detail read observes
  // the immutable terminal-impact row written by the worker.
  await openWorkspaceSection(page, 'Workflows', 'Packs')
  await openWorkspaceSection(page, 'Activity', 'Recover')
  await page.locator('#dlq-filter').selectOption('all')
  await expect(focusedFailure).toBeVisible({ timeout: 30_000 })
  await focusedFailure.click()
  const recoveredOutcome = page.getByTestId('dlq-recovery-drill-outcome')
  await expect(recoveredOutcome.getByRole('status')).toHaveText('Recovered', { timeout: 30_000 })
  await expect(recoveredOutcome).toContainText('Verified by generation-matched terminal success.')
  await expect(recoveredOutcome).toContainText('Recovery time')
  await expect(recoveredOutcome).toContainText(/No recurrence detected; monitoring through/)
  await dismissToasts(page)
  await captureEvidence(recoveredOutcome, 'recovery-drill-outcome-en-recovered')

  await page.getByRole('button', { name: /^Home\b/ }).click()
  const validation = page.getByTestId('recovery-validation-section')
  await expect(validation).toContainText('Recovery validation')
  await expect(validation).toContainText('1/1')
  await expect(validation).toContainText('1 recovered')
  await expect(validation).toContainText('100%')
  await captureEvidence(validation, 'recovery-validation-en-recovered')

  const exportResponse = await request.get(
    `${API_URL}/reports/recovery-validation?windowDays=30&format=markdown`,
    { headers: authHeaders(orgId) },
  )
  expect(exportResponse.ok()).toBe(true)
  expect(exportResponse.headers()['content-disposition']).toContain('janusly-recovery-validation-')
  expect(await exportResponse.text()).toContain('Recovery rate among completed outcomes**: 1/1 (100.0%)')

  expect(browserErrors).toEqual([])
})

test('Spanish mobile resolve records accepted loss and refreshes the selected drill detail', async ({ page }) => {
  const browserErrors = installBrowserErrorGuards(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await prepareSession(page, 'es')

  await page.goto('/')
  await page.getByRole('button', { name: 'Navegación' }).click()
  await openWorkspaceSection(page, 'Flujos', 'Paquetes')
  const drill = await startContractDrill(page, 'Triage de incidentes', 'Iniciar ejercicio de recuperación')

  await expect(page.locator(`[data-testid="dlq-row-${drill.deadLetterId}"]`)).toBeVisible({ timeout: 30_000 })
  const outcome = page.getByTestId('dlq-recovery-drill-outcome')
  await expect(outcome.getByRole('status')).toHaveText('Requiere acción')
  await expect(outcome).toContainText('Todavía no hay evidencia de recuperación terminal.')

  const resolveResponse = page.waitForResponse((response) => (
    new URL(response.url()).pathname === '/dlq/resolve'
    && response.request().method() === 'POST'
  ))
  await page.getByRole('button', { name: 'Resolver', exact: true }).click()
  expect((await resolveResponse).status()).toBe(200)

  await expect(outcome.getByRole('status')).toHaveText('Pérdida aceptada', { timeout: 30_000 })
  await expect(outcome).toContainText('Registrado a partir de la decisión del operador de aceptar la pérdida.')
  await expect(outcome).toContainText('Tiempo de recuperación')
  await expect(outcome).toContainText('La reincidencia se evalúa después de una recuperación verificada.')

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(2)
  await dismissToasts(page)
  await captureEvidence(outcome, 'recovery-drill-outcome-es-accepted-loss-mobile')

  await page.getByRole('button', { name: 'Navegación' }).click()
  await page.locator('#workspace-sidebar').getByRole('button', { name: /^Inicio\b/ }).click()
  const validation = page.getByTestId('recovery-validation-section')
  await expect(validation).toContainText('Validación de recuperación')
  await expect(validation).toContainText('1/1')
  await expect(validation).toContainText('1 pérdida aceptada')
  await expect(validation).toContainText('0%')
  const validationOverflow = await validation.evaluate((node) => node.scrollWidth - node.clientWidth)
  expect(validationOverflow).toBeLessThanOrEqual(2)
  await page.setViewportSize({ width: 390, height: 1_200 })
  await expect(page.locator('#workspace-sidebar')).toBeHidden()
  await page.waitForTimeout(300)
  await captureEvidence(validation, 'recovery-validation-es-accepted-loss-mobile')

  expect(browserErrors).toEqual([])
})
