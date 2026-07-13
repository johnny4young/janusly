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

async function selectedDeadLetterTestId(page: Page) {
  const selected = page.locator('[data-testid^="dlq-row-"][data-selected="true"]').first()
  return await selected.count() > 0 ? selected.getAttribute('data-testid') : null
}

async function waitForNewSelectedFailure(page: Page, previousTestId: string | null, nodeId?: string) {
  const selected = page.locator('[data-testid^="dlq-row-"][data-selected="true"]')
    .filter(nodeId ? { hasText: nodeId } : {})
    .first()
  await expect.poll(async () => {
    if (await selected.count() === 0) return null
    const testId = await selected.getAttribute('data-testid')
    return testId && testId !== previousTestId ? testId : null
  }, { timeout: 30_000 }).not.toBeNull()
  await expect(selected).toBeVisible()
  return selected
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
  // The success toast precedes the async refresh + workflow-open handoff. Wait
  // for that final destination before navigating back, otherwise the handoff
  // can replace the Packs DOM while Playwright is clicking its action button.
  await expect(page.getByRole('heading', { name: 'Step setup', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Packs', exact: true }).click()
  const selectedBeforeInitialFailure = await selectedDeadLetterTestId(page)
  await pack.getByRole('button', { name: 'Break a node', exact: true }).click()

  const failedRow = await waitForNewSelectedFailure(page, selectedBeforeInitialFailure, 'page_oncall')
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

  // Promote the proven recovery manually: create a draft, then activate in a
  // separate action. The server re-verifies the structural diff, sandbox run,
  // exact saved version, replayed DLQ row, and accepted feedback.
  await page.getByRole('button', { name: 'Create playbook', exact: true }).click()
  const playbookForm = page.getByTestId('recovery-playbook-form')
  await expect(playbookForm).toBeVisible()
  await captureElement(playbookForm, 'web-en-recovery-playbook-form')
  await page.getByRole('button', { name: 'Save draft', exact: true }).click()
  const playbookDraft = page.getByTestId('recovery-playbook-draft')
  await expect(playbookDraft).toBeVisible()
  await expect(playbookDraft).toContainText('Draft ready')
  await captureElement(playbookDraft, 'web-en-recovery-playbook-draft')
  await page.getByRole('button', { name: 'Activate playbook', exact: true }).click()
  const playbookActive = page.getByTestId('recovery-playbook-active')
  await expect(playbookActive).toBeVisible()
  await captureElement(playbookActive, 'web-en-recovery-playbook-active')

  // A new exact-signature failure offers the playbook but never invokes it.
  // Explicit use returns the immutable source, then the normal sandbox and
  // production Apply gates run again against the fresh failure.
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: 'Packs', exact: true }).click()
  const repeatPack = page.locator('.list-card').filter({ hasText: 'Incident triage' }).first()
  const selectedBeforeRepeatedFailure = await selectedDeadLetterTestId(page)
  await repeatPack.getByRole('button', { name: 'Break a node', exact: true }).click()
  await waitForNewSelectedFailure(page, selectedBeforeRepeatedFailure, 'page_oncall')
  await page.getByRole('button', { name: /Suggest fix/i }).click()
  const playbookMatch = page.getByTestId('recovery-playbook-match')
  await expect(playbookMatch).toBeVisible()
  await expect(playbookMatch).toContainText('never runs automatically')
  await captureElement(playbookMatch, 'web-en-recovery-playbook-match')
  await page.getByRole('button', { name: 'Use and revalidate', exact: true }).click()
  const playbookReview = page.getByTestId('recovery-playbook-revalidation')
  await expect(playbookReview).toBeVisible()
  await expect(page.getByRole('button', { name: /Apply validated fix/i })).toHaveCount(0)
  await captureElement(playbookReview, 'web-en-recovery-playbook-revalidation')
  await page.getByRole('button', { name: /Validate in sandbox/i }).click()
  await expect(page.getByRole('button', { name: /Apply validated fix/i })).toBeVisible({ timeout: 30_000 })
  expect(saveRequests, 'fresh playbook sandbox must not auto-save').toBe(1)
  await page.getByRole('button', { name: /Apply validated fix/i }).click()
  const useRecorded = page.getByTestId('recovery-playbook-use-recorded')
  await expect(useRecorded).toBeVisible({ timeout: 30_000 })
  await expect(useRecorded).toContainText('1 successful production use')
  expect(saveRequests).toBe(2)
  await captureElement(useRecorded, 'web-en-recovery-playbook-use-recorded')
  await page.getByRole('button', { name: 'Close', exact: true }).click()

  // Locale parity on the playbook's own live surface (not only a unit render).
  await page.evaluate(() => window.localStorage.setItem('janusly:locale', 'es'))
  await page.reload()
  await page.getByRole('button', { name: 'Packs', exact: true }).click()
  const spanishPlaybookPack = page.locator('.list-card').filter({ hasText: 'Triage de incidentes' }).first()
  const selectedBeforeSpanishFailure = await selectedDeadLetterTestId(page)
  await spanishPlaybookPack.getByRole('button', { name: 'Romper un nodo', exact: true }).click()
  await waitForNewSelectedFailure(page, selectedBeforeSpanishFailure, 'page_oncall')
  await page.getByRole('button', { name: /Sugerir corrección/i }).click()
  const spanishPlaybookMatch = page.getByTestId('recovery-playbook-match')
  await expect(spanishPlaybookMatch).toContainText('nunca se ejecuta automáticamente')
  await captureElement(spanishPlaybookMatch, 'web-es-recovery-playbook-match')
  await page.getByRole('button', { name: 'Retirar', exact: true }).click()
  const retireConfirm = page.getByTestId('recovery-playbook-retire-confirm')
  await expect(retireConfirm).toContainText('¿Retirar este playbook?')
  await captureElement(retireConfirm, 'web-es-recovery-playbook-retire-confirm')
  await page.getByRole('button', { name: 'Mantener activo', exact: true }).click()
  await page.getByRole('button', { name: 'Usar y volver a validar', exact: true }).click()
  const spanishPlaybookReview = page.getByTestId('recovery-playbook-revalidation')
  await expect(spanishPlaybookReview).toContainText('ejecuta el sandbox actual')
  await captureElement(spanishPlaybookReview, 'web-es-recovery-playbook-revalidation')

  // The backend regression transition is covered against real Postgres in
  // integration tests. Here we isolate the terminal browser state so its
  // explanatory copy and layout are captured deterministically.
  await page.route('**/run?runId=*', async (route) => {
    const runId = new URL(route.request().url()).searchParams.get('runId') ?? 'validation-regressed'
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        run: { id: runId, status: 'failed' },
        nodes: [{ nodeId: 'page_oncall', status: 'failed', errorJson: { message: 'El timeout volvió a superar el límite.' } }],
      }),
    })
  })
  await page.route('**/recovery/playbooks/*/outcome', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ playbook: { status: 'retired' } }),
    })
  })
  await page.getByRole('button', { name: /Validar en sandbox/i }).click()
  const regression = page.getByTestId('recovery-playbook-regression')
  await expect(regression).toContainText('Playbook retirado tras una regresión', { timeout: 30_000 })
  await captureElement(regression, 'web-es-recovery-playbook-regression')
  await page.unroute('**/run?runId=*')
  await page.unroute('**/recovery/playbooks/*/outcome')
  await page.keyboard.press('Escape')

  // A second real failure exercises the blocked fallback in Spanish. The
  // same dialog stays useful without an AI provider and never enables the
  // sandbox/apply actions for a no-op suggestion.
  await page.reload()
  await page.getByRole('button', { name: 'Packs', exact: true }).click()
  const spanishPack = page.locator('.list-card').filter({ hasText: 'Escalamiento de soporte' }).first()
  await spanishPack.getByRole('button', { name: 'Instalar', exact: true }).click()
  await expect(page.getByText(/Pack instalado/)).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Configuración del paso', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Packs', exact: true }).click()
  const selectedBeforeFallbackFailure = await selectedDeadLetterTestId(page)
  await spanishPack.getByRole('button', { name: 'Romper un nodo', exact: true }).click()
  const spanishFailure = await waitForNewSelectedFailure(page, selectedBeforeFallbackFailure)
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
