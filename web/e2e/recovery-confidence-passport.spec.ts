import { openActivityRecoveryDetail, openWorkspaceSection } from './_helpers/workspace-navigation'
import { expect, test, type APIRequestContext, type Page, type Response } from '@playwright/test'
import { mkdir } from 'node:fs/promises'

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3001'
const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR

function authHeaders(orgId: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'x-org-id': orgId, 'x-user-id': 'dev-user' }
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

type WorkflowDocument = {
  id: string
  name: string
  dslVersion: string
  nodes: Array<{ id: string; type: string; config: Record<string, unknown> }>
  edges: Array<{ from: string; to: string }>
}

async function startFailure(
  request: APIRequestContext,
  orgId: string,
  workflow: WorkflowDocument,
): Promise<{ runId: string; deadLetterId: string }> {
  const headers = authHeaders(orgId)
  const started = await request.post(`${API_URL}/start`, { headers, data: workflow })
  if (!started.ok()) {
    throw new Error(`POST /start failed: ${started.status()} ${await started.text()}`)
  }
  const { runId } = await started.json() as { runId?: string }
  if (!runId) throw new Error('POST /start did not return runId')

  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const response = await request.get(`${API_URL}/dlq?limit=100`, { headers })
    if (!response.ok()) {
      throw new Error(`GET /dlq failed: ${response.status()} ${await response.text()}`)
    }
    const rows = await response.json() as Array<{ id: string; runId: string }>
    const deadLetter = rows.find((row) => row.runId === runId)
    if (deadLetter) return { runId, deadLetterId: deadLetter.id }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`Run ${runId} did not create a dead letter`)
}

async function currentActivityRecoveryId(page: Page) {
  const detail = page.getByTestId('activity-recovery-detail')
  return await detail.count() > 0 ? detail.getAttribute('data-dead-letter-id') : null
}

async function waitForNewActivityRecovery(page: Page, previousId: string | null) {
  const detail = page.getByTestId('activity-recovery-detail')
  await expect.poll(async () => {
    if (await detail.count() === 0) return null
    const id = await detail.getAttribute('data-dead-letter-id')
    return id && id !== previousId ? id : null
  }, { timeout: 60_000 }).not.toBeNull()
  await expect(detail).toBeVisible()
  return detail
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
  const workflowId = `passport-local-tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const failingWorkflow: WorkflowDocument = {
    id: workflowId,
    name: 'Provider-free recovery passport',
    dslVersion: '1.0',
    nodes: [{
      id: 'normalize',
      type: 'tool',
      config: { tool: 'text.uppercase', resultPolicy: 'require_ok', input: {} },
    }],
    edges: [],
  }
  let saveRequests = 0
  page.on('request', (outgoing) => {
    if (new URL(outgoing.url()).pathname === '/workflows/save') saveRequests += 1
  })

  await page.addInitScript(({ activeOrg }) => {
    window.localStorage.setItem('janusly:activeOrg', activeOrg)
  }, { activeOrg: orgId })
  await page.goto('/')
  const homeHero = page.locator('.we-recovery-center-hero')
  await expect(homeHero).toBeVisible()
  await expect(page.getByTestId('home-priority-clear')).toBeVisible()
  await captureEvidence(page, '01-home-context-en')
  const saved = await request.post(`${API_URL}/workflows/save`, {
    headers,
    data: failingWorkflow,
  })
  expect(saved.ok(), await saved.text()).toBe(true)
  const initialFailure = await startFailure(request, orgId, failingWorkflow)
  const deadLetterId = initialFailure.deadLetterId
  await openActivityRecoveryDetail(page, deadLetterId)

  const detailResponse = await request.get(`${API_URL}/dlq?id=${encodeURIComponent(deadLetterId)}`, { headers })
  expect(detailResponse.ok()).toBe(true)
  const detail = await detailResponse.json() as {
    nodeId: string
    workflowJson: { nodes: Array<{ id: string; type: string; config: Record<string, unknown> }>; [key: string]: unknown }
  }
  const fixedWorkflow = structuredClone(detail.workflowJson)
  fixedWorkflow.nodes = fixedWorkflow.nodes.map((node) => node.id === detail.nodeId
    ? {
        ...node,
        config: {
          ...node.config,
          input: { value: 'recovered locally' },
        },
      }
    : node)

  await page.route('**/ai/patch-workflow', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        mode: 'ai',
        suggestedWorkflow: fixedWorkflow,
        rationale: 'Provide the required local-tool input without changing the node or tool identity.',
        suggestions: [{
          workflow: fixedWorkflow,
          rationale: 'Provide the required local-tool input without changing the node or tool identity.',
          approachLabel: 'other',
          confidence: 100,
          calibratedConfidence: 100,
          safety: { writeSide: false, approvalRequired: false, approvalPresent: true },
        }],
        evidence: [{ kind: 'signature_rule', sourceRef: 'demo_failure', snippet: 'Matched deterministic demo failure' }],
        recoveryPassport: {
          failureSignature: 'Invalid tool input: text.uppercase',
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
  const repeated = await startFailure(request, orgId, failingWorkflow)
  const repeatedDeadLetterId = repeated.deadLetterId
  await openActivityRecoveryDetail(page, repeatedDeadLetterId)
  const repeatedDetailResponse = await request.get(
    `${API_URL}/dlq?id=${encodeURIComponent(repeatedDeadLetterId)}`,
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
    `${API_URL}/recovery/playbooks/match?deadLetterId=${encodeURIComponent(repeatedDeadLetterId)}`,
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

  // Locale consistency on the playbook's own live surface (not only a unit render).
  await page.evaluate(() => window.localStorage.setItem('janusly:locale', 'es'))
  await page.reload()
  const spanishOccurrence = await startFailure(request, orgId, failingWorkflow)
  const spanishFailureId = spanishOccurrence.deadLetterId
  await openActivityRecoveryDetail(page, spanishFailureId)
  const spanishFailureDetailResponse = await request.get(
    `${API_URL}/dlq?id=${encodeURIComponent(spanishFailureId)}`,
    { headers },
  )
  expect(spanishFailureDetailResponse.ok()).toBe(true)
  const spanishFailureDetail = await spanishFailureDetailResponse.json() as {
    runId: string
  }
  const spanishMatchResponsePromise = waitForPlaybookMatch(playbookMatches, spanishFailureId)
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
  const spanishRegression = await startFailure(request, orgId, failingWorkflow)
  const spanishRegressionId = spanishRegression.deadLetterId
  await openActivityRecoveryDetail(page, spanishRegressionId)
  const spanishRegressionMatchPromise = waitForPlaybookMatch(playbookMatches, spanishRegressionId)
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
        nodes: [{ nodeId: 'normalize', status: 'failed', errorJson: { message: 'La validación volvió a fallar.' } }],
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
  const selectedBeforeFallbackFailure = await currentActivityRecoveryId(page)
  await spanishPack.getByRole('button', { name: 'Iniciar ejercicio de recuperación', exact: true }).click()
  const spanishFailure = await waitForNewActivityRecovery(page, selectedBeforeFallbackFailure)
  const spanishDeadLetterId = await spanishFailure.getAttribute('data-dead-letter-id')
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
