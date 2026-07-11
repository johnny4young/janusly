import { expect, test, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3001'
const AUTH_HEADERS = { 'x-org-id': 'default', 'x-user-id': 'dev-user' }
const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR

async function captureEvidence(page: Page, name: string) {
  if (!EVIDENCE_DIR) return
  await mkdir(EVIDENCE_DIR, { recursive: true })
  await page.screenshot({ path: `${EVIDENCE_DIR}/${name}.png`, fullPage: true })
}

async function captureElement(locator: import('@playwright/test').Locator, name: string) {
  if (!EVIDENCE_DIR) return
  await mkdir(EVIDENCE_DIR, { recursive: true })
  await locator.screenshot({ path: `${EVIDENCE_DIR}/${name}.png` })
}

function installConsoleErrorGuards(page: Page) {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') {
      const location = message.location().url
      errors.push(location ? `${message.text()} @ ${location}` : message.text())
    }
  })
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

test('recovery passport requires sandbox success and a separate apply decision', async ({ page, request }) => {
  const browserErrors = installConsoleErrorGuards(page)
  let saveRequests = 0
  page.on('request', (outgoing) => {
    if (new URL(outgoing.url()).pathname === '/workflows/save') saveRequests += 1
  })

  await page.goto('/')
  const onboarding = page.getByTestId('onboarding-banner')
  await expect(onboarding).toBeVisible()
  expect(await onboarding.evaluate((node) => getComputedStyle(node).position)).not.toBe('fixed')
  await captureEvidence(page, '01-contextual-onboarding-en')
  await page.getByRole('button', { name: 'Packs', exact: true }).click()
  const pack = page.locator('.list-card').filter({ hasText: 'Incident triage' }).first()
  await pack.getByRole('button', { name: 'Install', exact: true }).click()
  await expect(page.getByText(/Pack installed/)).toBeVisible()
  await page.getByRole('button', { name: 'Packs', exact: true }).click()
  await pack.getByRole('button', { name: 'Break a node', exact: true }).click()

  const failedRow = page.locator('[data-testid^="dlq-row-"][data-selected="true"]').filter({ hasText: 'page_oncall' }).first()
  await expect(failedRow).toBeVisible({ timeout: 30_000 })
  const rowTestId = await failedRow.getAttribute('data-testid')
  const deadLetterId = rowTestId?.replace('dlq-row-', '')
  expect(deadLetterId).toBeTruthy()

  const detailResponse = await request.get(`${API_URL}/dlq?id=${encodeURIComponent(deadLetterId!)}`, { headers: AUTH_HEADERS })
  expect(detailResponse.ok()).toBe(true)
  const detail = await detailResponse.json() as {
    nodeId: string
    workflowJson: { nodes: Array<{ id: string; type: string; config: Record<string, unknown> }>; [key: string]: unknown }
  }
  const fixedWorkflow = structuredClone(detail.workflowJson)
  fixedWorkflow.nodes = fixedWorkflow.nodes.map((node) => node.id === detail.nodeId
    ? { id: node.id, type: 'noop', config: {} }
    : node)

  await page.route('**/ai/patch-workflow', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        mode: 'ai',
        suggestedWorkflow: fixedWorkflow,
        rationale: 'Replace the deterministic demo failure with a safe no-op.',
        suggestions: [{
          workflow: fixedWorkflow,
          rationale: 'Replace the deterministic demo failure with a safe no-op.',
          approachLabel: 'other',
          confidence: 100,
          calibratedConfidence: 100,
          safety: { writeSide: false, approvalRequired: false, approvalPresent: true },
        }],
        evidence: [{ kind: 'signature_rule', sourceRef: 'demo_failure', snippet: 'Matched deterministic demo failure' }],
        recoveryPassport: {
          failureSignature: 'Deterministic demo failure on tool node',
          priorSameSignatureOutcome: null,
        },
      }),
    })
  })

  await page.getByRole('button', { name: /Suggest fix/i }).click()
  await page.getByRole('button', { name: /Generate suggestion/i }).click()
  const passport = page.getByTestId('recovery-confidence-passport')
  await expect(passport).toHaveAttribute('data-verdict', 'needs_review')
  await expect(passport).toContainText('Sandbox validation required')
  await captureElement(passport, '02-passport-needs-review-en')

  await page.getByRole('button', { name: /Validate in sandbox/i }).click()
  await expect(passport).toHaveAttribute('data-verdict', 'safe_to_apply', { timeout: 30_000 })
  await expect(page.getByRole('button', { name: /Apply validated fix/i })).toBeVisible()
  expect(saveRequests, 'sandbox success must not auto-save').toBe(0)

  await page.getByRole('button', { name: /Apply validated fix/i }).click()
  await expect(page.getByText('Patch applied.', { exact: true })).toBeVisible({ timeout: 30_000 })
  expect(saveRequests).toBe(1)

  // A second real failure exercises the blocked fallback in Spanish. The
  // same dialog stays useful without an AI provider and never enables the
  // sandbox/apply actions for a no-op suggestion.
  await page.evaluate(() => window.localStorage.setItem('janusly:locale', 'es'))
  await page.reload()
  await page.getByRole('button', { name: 'Packs', exact: true }).click()
  const spanishPack = page.locator('.list-card').filter({ hasText: 'Escalamiento de soporte' }).first()
  await spanishPack.getByRole('button', { name: 'Instalar', exact: true }).click()
  await expect(page.getByText(/Pack instalado/)).toBeVisible()
  await page.getByRole('button', { name: 'Packs', exact: true }).click()
  await spanishPack.getByRole('button', { name: 'Romper un nodo', exact: true }).click()
  const spanishFailure = page.locator('[data-testid^="dlq-row-"][data-selected="true"]').first()
  await expect(spanishFailure).toBeVisible({ timeout: 30_000 })
  const spanishRowTestId = await spanishFailure.getAttribute('data-testid')
  const spanishDeadLetterId = spanishRowTestId?.replace('dlq-row-', '')
  expect(spanishDeadLetterId).toBeTruthy()
  const spanishDetailResponse = await request.get(
    `${API_URL}/dlq?id=${encodeURIComponent(spanishDeadLetterId!)}`,
    { headers: AUTH_HEADERS },
  )
  expect(spanishDetailResponse.ok()).toBe(true)
  const spanishWorkflow = (await spanishDetailResponse.json() as { workflowJson: unknown }).workflowJson
  await page.unroute('**/ai/patch-workflow')
  await page.route('**/ai/patch-workflow', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        mode: 'fallback',
        suggestedWorkflow: spanishWorkflow,
        rationale: 'AI unavailable',
        suggestions: [{
          workflow: spanishWorkflow,
          rationale: 'AI unavailable',
          approachLabel: 'other',
          confidence: 0,
          safety: { writeSide: false, approvalRequired: false, approvalPresent: true },
        }],
        evidence: [],
        recoveryPassport: {
          failureSignature: 'Deterministic demo failure on tool node',
          priorSameSignatureOutcome: null,
        },
        aiError: 'no_llm_configured',
      }),
    })
  })
  await page.getByRole('button', { name: /Sugerir corrección/i }).click()
  await page.getByRole('button', { name: /Generar sugerencia/i }).click()
  const blockedPassport = page.getByTestId('recovery-confidence-passport')
  await expect(blockedPassport).toHaveAttribute('data-verdict', 'unsafe')
  await expect(blockedPassport).toContainText('No es seguro aplicar')
  await expect(blockedPassport).toContainText('No hay un parche aplicable')
  await expect(page.getByRole('button', { name: /Validar en sandbox/i })).toBeDisabled()
  await captureElement(blockedPassport, '04-passport-unsafe-es')
  expect(browserErrors).toEqual([])
})
