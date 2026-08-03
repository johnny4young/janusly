import { openWorkspaceSection } from './_helpers/workspace-navigation'
import { expect, test, type Page, type Response } from '@playwright/test'
import { mkdir } from 'node:fs/promises'

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3001'
const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR

function authHeaders(orgId: string): Record<string, string> {
  return { 'x-org-id': orgId, 'x-user-id': 'dev-user' }
}

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

async function selectWorkerInterruptedFailure(
  pack: import('@playwright/test').Locator,
  locale: 'en' | 'es',
) {
  await pack
    .getByLabel(locale === 'es' ? 'Escenario de fallo' : 'Failure scenario')
    .selectOption('worker_interrupted_during_page')
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
  }, { timeout: 60_000 }).not.toBeNull()
  await expect(selected).toBeVisible()
  return selected
}

function recordPlaybookMatches(page: Page): Map<string, Response> {
  const responses = new Map<string, Response>()
  page.on('response', (response) => {
    const url = new URL(response.url())
    const deadLetterId = url.pathname === '/recovery/playbooks/match'
      ? url.searchParams.get('deadLetterId')
      : null
    if (deadLetterId) responses.set(deadLetterId, response)
  })
  return responses
}

async function waitForPlaybookMatch(
  responses: Map<string, Response>,
  deadLetterId: string,
): Promise<Response> {
  await expect.poll(() => responses.has(deadLetterId), { timeout: 30_000 }).toBe(true)
  const response = responses.get(deadLetterId)
  if (!response) throw new Error(`Missing recorded playbook match for ${deadLetterId}`)
  return response
}

test('recovery passport requires sandbox success and a separate apply decision', async ({ page, request }) => {
  test.slow()
  const browserErrors = installConsoleErrorGuards(page)
  const playbookMatches = recordPlaybookMatches(page)
  const orgId = process.env.JANUSLY_RECOVERY_PASSPORT_ORG_ID
    ?? `recovery-passport-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const headers = authHeaders(orgId)
  let saveRequests = 0
  page.on('request', (outgoing) => {
    if (new URL(outgoing.url()).pathname === '/workflows/save') saveRequests += 1
  })

  await page.addInitScript(({ activeOrg }) => {
    window.localStorage.setItem('janusly:activeOrg', activeOrg)
  }, { activeOrg: orgId })
  await page.goto('/')
  const onboarding = page.getByTestId('onboarding-banner')
  await expect(onboarding).toBeVisible()
  expect(await onboarding.evaluate((node) => getComputedStyle(node).position)).not.toBe('fixed')
  await captureEvidence(page, '01-contextual-onboarding-en')
  await openWorkspaceSection(page, 'Workflows', 'Templates')
  const pack = page.getByTestId('solution-pack-incident-triage')
  await pack.getByRole('button', { name: 'Install', exact: true }).click()
  await expect(page.getByText(/Pack installed/)).toBeVisible()
  // The success toast precedes the async refresh + workflow-open handoff. Wait
  // for that final destination before navigating back, otherwise the handoff
  // can replace the catalog DOM while Playwright is clicking its action button.
  await expect(page.getByRole('heading', { name: 'Build', exact: true })).toBeVisible()
  await openWorkspaceSection(page, 'Workflows', 'Templates')
  await selectWorkerInterruptedFailure(pack, 'en')
  const selectedBeforeInitialFailure = await selectedDeadLetterTestId(page)
  await pack.getByRole('button', { name: 'Start recovery drill', exact: true }).click()
  await openWorkspaceSection(page, 'Activity', 'Recover')

  const failedRow = await waitForNewSelectedFailure(page, selectedBeforeInitialFailure, 'page_oncall')
  const rowTestId = await failedRow.getAttribute('data-testid')
  const deadLetterId = rowTestId?.replace('dlq-row-', '')
  expect(deadLetterId).toBeTruthy()

  const detailResponse = await request.get(`${API_URL}/dlq?id=${encodeURIComponent(deadLetterId!)}`, { headers })
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
  await expect(passport.locator('.we-recovery-passport__factors > li')).toHaveCount(5)
  await expect(passport.locator('[data-status="review"]')).toHaveCount(1)
  await captureElement(passport, '02-passport-needs-review-en')

  await page.getByRole('button', { name: /Validate in sandbox/i }).click()
  await expect(passport).toHaveAttribute('data-verdict', 'safe_to_apply', { timeout: 30_000 })
  await expect(passport.locator('[data-status="pass"]')).toHaveCount(5)
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
  await openWorkspaceSection(page, 'Workflows', 'Templates')
  const repeatPack = page.getByTestId('solution-pack-incident-triage')
  await selectWorkerInterruptedFailure(repeatPack, 'en')
  const selectedBeforeRepeatedFailure = await selectedDeadLetterTestId(page)
  await repeatPack.getByRole('button', { name: 'Start recovery drill', exact: true }).click()
  await openWorkspaceSection(page, 'Activity', 'Recover')
  const repeatedFailure = await waitForNewSelectedFailure(page, selectedBeforeRepeatedFailure, 'page_oncall')
  const repeatedTestId = await repeatedFailure.getAttribute('data-testid')
  const repeatedDeadLetterId = repeatedTestId?.replace('dlq-row-', '')
  expect(repeatedDeadLetterId).toBeTruthy()
  const repeatedDetailResponse = await request.get(
    `${API_URL}/dlq?id=${encodeURIComponent(repeatedDeadLetterId!)}`,
    { headers },
  )
  expect(repeatedDetailResponse.ok()).toBe(true)
  const repeatedDetail = await repeatedDetailResponse.json() as { runId: string }
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
  const validationResponsePromise = page.waitForResponse((response) => (
    new URL(response.url()).pathname === '/dlq/validate-fix' && response.request().method() === 'POST'
  ))
  await page.getByRole('button', { name: /Validate in sandbox/i }).click()
  const validationResponse = await validationResponsePromise
  const validation = await validationResponse.json() as { runId: string }
  await expect(page.getByRole('button', { name: /Apply validated fix/i })).toBeVisible({ timeout: 30_000 })
  expect(saveRequests, 'fresh playbook sandbox must not auto-save').toBe(1)
  await page.getByRole('button', { name: /Apply validated fix/i }).click()
  const usePending = page.getByTestId('recovery-playbook-use-pending')
  await expect(usePending).toBeVisible({ timeout: 30_000 })
  await expect(usePending).toContainText('awaiting verification')
  expect(saveRequests).toBe(2)
  await captureElement(usePending, 'web-en-recovery-playbook-use-pending')

  await expect.poll(async () => {
    const response = await request.get(
      `${API_URL}/run?runId=${encodeURIComponent(repeatedDetail.runId)}`,
      { headers },
    )
    if (!response.ok()) return 'missing'
    return ((await response.json()) as { run?: { status?: string } }).run?.status ?? 'missing'
  }, { timeout: 30_000 }).toBe('succeeded')

  const matchResponse = await request.get(
    `${API_URL}/recovery/playbooks/match?deadLetterId=${encodeURIComponent(repeatedDeadLetterId!)}`,
    { headers },
  )
  expect(matchResponse.ok()).toBe(true)
  const matched = await matchResponse.json() as { playbook: { id: string } }
  const outcomeResponse = await request.post(
    `${API_URL}/recovery/playbooks/${encodeURIComponent(matched.playbook.id)}/outcome`,
    {
      headers,
      data: {
        deadLetterId: repeatedDeadLetterId,
        validationRunId: validation.runId,
        phase: 'applied',
      },
    },
  )
  expect(outcomeResponse.ok()).toBe(true)
  await expect(outcomeResponse.json()).resolves.toMatchObject({
    playbook: { successfulUses: 1 },
    recorded: false,
  })
  await page.getByRole('button', { name: 'Close', exact: true }).click()

  // Locale parity on the playbook's own live surface (not only a unit render).
  await page.evaluate(() => window.localStorage.setItem('janusly:locale', 'es'))
  await page.reload()
  await openWorkspaceSection(page, 'Flujos', 'Plantillas')
  const spanishPlaybookPack = page.getByTestId('solution-pack-incident-triage')
  await selectWorkerInterruptedFailure(spanishPlaybookPack, 'es')
  const selectedBeforeSpanishFailure = await selectedDeadLetterTestId(page)
  await spanishPlaybookPack.getByRole('button', { name: 'Iniciar ejercicio de recuperación', exact: true }).click()
  await openWorkspaceSection(page, 'Actividad', 'Recuperar')
  const spanishPlaybookFailure = await waitForNewSelectedFailure(page, selectedBeforeSpanishFailure, 'page_oncall')
  const spanishFailureTestId = await spanishPlaybookFailure.getAttribute('data-testid')
  const spanishFailureId = spanishFailureTestId?.replace('dlq-row-', '')
  expect(spanishFailureId).toBeTruthy()
  const spanishFailureDetailResponse = await request.get(
    `${API_URL}/dlq?id=${encodeURIComponent(spanishFailureId!)}`,
    { headers },
  )
  expect(spanishFailureDetailResponse.ok()).toBe(true)
  const spanishFailureDetail = await spanishFailureDetailResponse.json() as {
    runId: string
  }
  const spanishMatchResponsePromise = waitForPlaybookMatch(playbookMatches, spanishFailureId!)
  await page.getByRole('button', { name: /Sugerir corrección/i }).click()
  const spanishMatchResponse = await spanishMatchResponsePromise
  expect(spanishMatchResponse.ok()).toBe(true)
  await expect(spanishMatchResponse.json()).resolves.toMatchObject({
    playbook: { status: 'active' },
  })
  const spanishPlaybookMatch = page.getByTestId('recovery-playbook-match')
  await expect(spanishPlaybookMatch).toContainText('nunca se ejecuta automáticamente', { timeout: 30_000 })
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

  await page.getByRole('button', { name: /Validar en sandbox/i }).click()
  await expect(page.getByRole('button', { name: /Aplicar corrección validada/i })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: /Aplicar corrección validada/i }).click()
  const spanishUsePending = page.getByTestId('recovery-playbook-use-pending')
  await expect(spanishUsePending).toContainText('Uso del playbook pendiente de verificación', { timeout: 30_000 })
  await expect(spanishUsePending).toContainText('solo cuando este reintento termine correctamente')
  await captureElement(spanishUsePending, 'web-es-recovery-playbook-use-pending')
  await expect.poll(async () => {
    const response = await request.get(
      `${API_URL}/run?runId=${encodeURIComponent(spanishFailureDetail.runId)}`,
      { headers },
    )
    if (!response.ok()) return 'missing'
    return ((await response.json()) as { run?: { status?: string } })
      .run?.status ?? 'missing'
  }, { timeout: 30_000 }).toBe('succeeded')

  // A separate occurrence drives the regression state so the successful-use
  // smoke above and the failed-validation smoke below remain causally honest.
  await page.getByRole('button', { name: 'Cerrar', exact: true }).click()
  await openWorkspaceSection(page, 'Flujos', 'Plantillas')
  await selectWorkerInterruptedFailure(spanishPlaybookPack, 'es')
  const selectedBeforeSpanishRegression = await selectedDeadLetterTestId(page)
  await spanishPlaybookPack.getByRole('button', { name: 'Iniciar ejercicio de recuperación', exact: true }).click()
  await openWorkspaceSection(page, 'Actividad', 'Recuperar')
  const spanishRegressionFailure = await waitForNewSelectedFailure(
    page,
    selectedBeforeSpanishRegression,
    'page_oncall',
  )
  const spanishRegressionTestId = await spanishRegressionFailure.getAttribute('data-testid')
  const spanishRegressionId = spanishRegressionTestId?.replace('dlq-row-', '')
  expect(spanishRegressionId).toBeTruthy()
  const spanishRegressionMatchPromise = waitForPlaybookMatch(playbookMatches, spanishRegressionId!)
  await page.getByRole('button', { name: /Sugerir corrección/i }).click()
  const spanishRegressionMatch = await spanishRegressionMatchPromise
  expect(spanishRegressionMatch.ok()).toBe(true)
  await expect(spanishRegressionMatch.json()).resolves.toMatchObject({
    playbook: { status: 'active' },
  })
  await expect(page.getByTestId('recovery-playbook-match')).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Usar y volver a validar', exact: true }).click()
  await expect(page.getByTestId('recovery-playbook-revalidation')).toBeVisible()

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
  await openWorkspaceSection(page, 'Flujos', 'Plantillas')
  const spanishPack = page.getByTestId('solution-pack-support-escalation')
  await spanishPack.getByRole('button', { name: 'Instalar', exact: true }).click()
  await expect(page.getByText(/Pack instalado/)).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Crear', exact: true })).toBeVisible()
  await openWorkspaceSection(page, 'Flujos', 'Plantillas')
  const selectedBeforeFallbackFailure = await selectedDeadLetterTestId(page)
  await spanishPack.getByRole('button', { name: 'Iniciar ejercicio de recuperación', exact: true }).click()
  await openWorkspaceSection(page, 'Actividad', 'Recuperar')
  const spanishFailure = await waitForNewSelectedFailure(page, selectedBeforeFallbackFailure)
  const spanishRowTestId = await spanishFailure.getAttribute('data-testid')
  const spanishDeadLetterId = spanishRowTestId?.replace('dlq-row-', '')
  expect(spanishDeadLetterId).toBeTruthy()
  const spanishDetailResponse = await request.get(
    `${API_URL}/dlq?id=${encodeURIComponent(spanishDeadLetterId!)}`,
    { headers },
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
  await expect(blockedPassport.locator('[data-status="block"]')).toHaveCount(1)
  await expect(page.getByRole('button', { name: /Validar en sandbox/i })).toBeDisabled()
  await captureElement(blockedPassport, '04-passport-unsafe-es')
  expect(browserErrors).toEqual([])
})
