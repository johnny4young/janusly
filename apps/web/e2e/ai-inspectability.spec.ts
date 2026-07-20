/**
 * Real-stack acceptance for inspectable AI policy and decisions.
 *
 * Organization/workflow guidance writes use the live API and database, agent
 * reasoning is produced by the real worker, and recovery alternatives are
 * rendered against a genuine DLQ entry. The patch endpoint alone is stubbed
 * because completion providers are intentionally optional in the E2E stack.
 */

import { mkdir } from 'node:fs/promises'
import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from '@playwright/test'
import { db, runEvents } from '../../../packages/db/src/index'

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3001'
const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR

type Json = Record<string, unknown>
type Locale = 'en' | 'es'
type RunEvent = {
  id?: string
  nodeId?: string
  type?: string
  payload?: Record<string, unknown>
}

function authHeaders(orgId: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-org-id': orgId,
    'x-user-id': 'dev-user',
  }
}

async function apiGet<T>(request: APIRequestContext, orgId: string, path: string): Promise<T> {
  const response = await request.get(`${API_URL}${path}`, { headers: authHeaders(orgId) })
  if (!response.ok()) throw new Error(`GET ${path} failed: ${response.status()} ${await response.text()}`)
  return response.json() as Promise<T>
}

async function apiPost<T>(
  request: APIRequestContext,
  orgId: string,
  path: string,
  body: Json,
): Promise<T> {
  const response = await request.post(`${API_URL}${path}`, {
    headers: authHeaders(orgId),
    data: body,
  })
  if (!response.ok()) throw new Error(`POST ${path} failed: ${response.status()} ${await response.text()}`)
  return response.json() as Promise<T>
}

function installConsoleErrorGuards(page: Page): string[] {
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
      '.we-budget-banner',
      '[data-testid="command-palette"]',
    ]) {
      for (const element of document.querySelectorAll<HTMLElement>(selector)) {
        element.style.display = 'none'
      }
    }
  })
}

async function capture(surface: Locator, name: string): Promise<void> {
  await expect(surface).toBeVisible()
  await surface.scrollIntoViewIfNeeded()
  if (!EVIDENCE_DIR) return
  await mkdir(EVIDENCE_DIR, { recursive: true })
  await surface.screenshot({ path: `${EVIDENCE_DIR}/${name}.png` })
}

async function setBrowserContext(page: Page, orgId: string, locale: Locale = 'en'): Promise<void> {
  await page.addInitScript(({ activeOrg, initialLocale }) => {
    window.localStorage.setItem('janusly:activeOrg', activeOrg)
    if (window.localStorage.getItem('janusly:locale') === null) {
      window.localStorage.setItem('janusly:locale', initialLocale)
    }
  }, { activeOrg: orgId, initialLocale: locale })
}

async function switchLocale(page: Page, locale: Locale): Promise<void> {
  await page.evaluate(nextLocale => window.localStorage.setItem('janusly:locale', nextLocale), locale)
  await page.reload()
  await hideUnrelatedOverlays(page)
}

async function openOperationsReliability(page: Page, locale: Locale): Promise<void> {
  await page.getByRole('button', {
    name: locale === 'en' ? 'Operations' : 'Operaciones',
    exact: true,
  }).click()
  const reliability = page.getByTestId('operations-rail-tab-reliability')
  await expect(reliability).toBeVisible()
  await reliability.click()
}

async function openWorkflowMetadata(
  page: Page,
  locale: Locale,
  workflowId: string,
  workflowName: string,
): Promise<Locator> {
  await page.getByRole('button', {
    name: locale === 'en' ? 'Flows' : 'Flujos',
    exact: true,
  }).click()
  const row = page.getByTestId(`workflows-row-${workflowId}`)
  await expect(row).toContainText(workflowName)
  const workflowResponse = page.waitForResponse(response => {
    if (response.request().method() !== 'GET') return false
    const url = new URL(response.url())
    return url.pathname.endsWith('/workflows/latest') && url.searchParams.get('workflowId') === workflowId
  })
  await row.click()
  expect((await workflowResponse).ok()).toBe(true)
  await page.getByRole('button', {
    name: locale === 'en' ? 'Step setup' : 'Configuración de paso',
    exact: true,
  }).click()
  const panel = page.locator('.we-workflow-metadata-panel')
  await expect(panel).toBeVisible()
  return panel
}

async function readOrgGuidance(request: APIRequestContext, orgId: string): Promise<string> {
  const payload = await apiGet<{ config: Array<{ key: string; value: unknown }> }>(
    request,
    orgId,
    '/org/config',
  )
  const entry = payload.config.find(candidate => candidate.key === 'ai.operatorGuidance')
  return typeof entry?.value === 'string' ? entry.value : ''
}

async function saveWorkflow(
  request: APIRequestContext,
  orgId: string,
  workflow: Json,
): Promise<void> {
  await apiPost(request, orgId, '/workflows/save', workflow)
}

async function startRun(
  request: APIRequestContext,
  orgId: string,
  workflow: Json,
  input: Json = {},
): Promise<string> {
  const response = await apiPost<{ runId: string }>(request, orgId, '/start', { workflow, input })
  return response.runId
}

async function pollUntilTerminal(
  request: APIRequestContext,
  orgId: string,
  runId: string,
  maxMs = 30_000,
): Promise<{ status: string; events: RunEvent[] }> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < maxMs) {
    const payload = await apiGet<{
      run: { status: string }
      events: RunEvent[]
    }>(request, orgId, `/run?runId=${encodeURIComponent(runId)}`)
    if (['succeeded', 'failed', 'cancelled'].includes(payload.run.status)) {
      return { status: payload.run.status, events: payload.events }
    }
    await new Promise(resolve => setTimeout(resolve, 400))
  }
  throw new Error(`Run ${runId} did not reach a terminal state`)
}

async function findDeadLetter(
  request: APIRequestContext,
  orgId: string,
  runId: string,
): Promise<{ id: string; nodeId: string }> {
  const rows = await apiGet<Array<{ id: string; runId: string; nodeId: string }>>(
    request,
    orgId,
    '/dlq?limit=100',
  )
  const row = rows.find(candidate => candidate.runId === runId)
  if (!row) throw new Error(`Run ${runId} did not create a dead letter`)
  return row
}

async function openRunTimeline(page: Page, locale: Locale, runId: string): Promise<void> {
  await page.getByRole('button', {
    name: locale === 'en' ? 'Runs' : 'Ejecuciones',
    exact: true,
  }).click()
  const history = page.getByTestId('runs-history-virtual-list')
  await expect(history).toBeVisible()
  const prefix = `${runId.slice(0, 8)}…`
  await expect.poll(() => history.getByRole('article').count()).toBeGreaterThan(0)
  await history.evaluate(element => element.scrollTo({ top: 0 }))
  for (let offset = 0; offset < 100; offset += 4) {
    const card = history.getByRole('article').filter({ hasText: prefix }).first()
    if (await card.isVisible().catch(() => false)) {
      await card.locator('button.list-card-row').click()
      const overview = page.getByTestId('run-overview')
      await expect(overview).toContainText(runId.slice(0, 12))
      await overview.getByRole('button', {
        name: locale === 'en' ? 'View timeline' : 'Ver cronología',
        exact: true,
      }).click()
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

async function openRecoverySuggestion(
  page: Page,
  locale: Locale,
  deadLetterId: string,
  nodeId: string,
): Promise<Locator> {
  await page.getByRole('button', {
    name: locale === 'en' ? 'Runs' : 'Ejecuciones',
    exact: true,
  }).click()
  const queue = page.getByTestId('recovery-queue')
  await expect(queue).toBeVisible()
  await queue.getByTestId('dlq-search').fill(nodeId)
  const row = queue.getByTestId(`dlq-row-${deadLetterId}`)
  await expect(row).toBeVisible()
  await row.click()
  await page.getByRole('button', {
    name: locale === 'en' ? 'Suggest fix' : 'Sugerir corrección',
    exact: true,
  }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', {
    name: locale === 'en' ? 'Generate suggestion' : 'Generar sugerencia',
    exact: true,
  }).click()
  const hypotheses = dialog.getByTestId('recovery-hypotheses')
  await expect(hypotheses).toBeVisible()
  return hypotheses
}

test.describe.configure({ mode: 'serial' })

test('organization and workflow guidance survive real saves, retry, and both locales', async ({ page, request }) => {
  test.setTimeout(120_000)
  const browserErrors = installConsoleErrorGuards(page)
  const stamp = Date.now()
  const orgId = `inspect-guidance-${stamp}`
  const workflowId = `inspect-guidance-flow-${stamp}`
  const workflowName = `Inspectable guidance ${stamp}`
  const seededOrgGuidance = '# Reliability\n- Prefer explicit approval before write-side actions'
  const englishOrgGuidance = `${seededOrgGuidance}\n- Keep retries bounded`
  const spanishOrgGuidance = `${englishOrgGuidance}\n- Mostrar siempre la evidencia determinista`
  const englishWorkflowGuidance = '# Workflow policy\n- Prefer timeout changes before retry changes'
  const spanishWorkflowGuidance = `${englishWorkflowGuidance}\n- Conservar la aprobación financiera`

  await apiPost(request, orgId, '/org/config', {
    key: 'ai.operatorGuidance',
    value: seededOrgGuidance,
  })
  await saveWorkflow(request, orgId, {
    id: workflowId,
    name: workflowName,
    nodes: [{ id: 'finish', type: 'noop', config: {} }],
    edges: [],
  })
  await setBrowserContext(page, orgId)
  await page.goto('/')
  await hideUnrelatedOverlays(page)

  await page.getByRole('button', { name: 'Operations', exact: true }).click()
  let failOrgLoads = true
  let delayNextOrgSave = true
  await page.route('**/org/config', async route => {
    const method = route.request().method()
    if (method === 'GET' && failOrgLoads) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ config: [] }),
      })
      return
    }
    if (method === 'POST' && delayNextOrgSave) {
      delayNextOrgSave = false
      await page.waitForTimeout(650)
    }
    await route.continue()
  })
  await page.getByTestId('operations-rail-tab-reliability').click()

  const orgCard = page.getByTestId('ai-guidance-settings')
  const orgInput = orgCard.getByTestId('ai-guidance-org-input')
  const orgSave = orgCard.getByTestId('ai-guidance-org-save')
  await expect(orgCard.getByRole('alert')).toContainText("Couldn't load AI guidance.")
  await expect(orgInput).toBeDisabled()
  await expect(orgSave).toBeDisabled()
  await hideUnrelatedOverlays(page)
  await capture(orgCard, 'web-en-org-guidance-error')

  failOrgLoads = false
  await orgCard.getByTestId('ai-guidance-org-retry').click()
  await expect(orgInput).toHaveValue(seededOrgGuidance)
  await expect(orgInput).toBeEnabled()
  await hideUnrelatedOverlays(page)
  await capture(orgCard, 'web-en-org-guidance-loaded')

  await orgInput.fill('Use postgres://operator:super-secret@db.internal/acme')
  await expect(orgInput).toHaveAttribute('aria-invalid', 'true')
  await expect(orgCard).toContainText('Guidance contains a secret-like value. Remove it before saving.')
  await expect(orgSave).toBeDisabled()
  await capture(orgCard, 'web-en-org-guidance-secret-blocked')

  await orgInput.fill(englishOrgGuidance)
  const englishOrgSaveResponse = page.waitForResponse(response => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/org/config'
  ))
  await orgSave.click()
  await expect(orgSave).toHaveText('Saving…')
  await capture(orgCard, 'web-en-org-guidance-saving')
  expect((await englishOrgSaveResponse).ok()).toBe(true)
  await expect(orgSave).toHaveText('Save guidance')
  expect(await readOrgGuidance(request, orgId)).toBe(englishOrgGuidance)
  await hideUnrelatedOverlays(page)
  await capture(orgCard, 'web-en-org-guidance-saved')

  let failWorkflowLoads = true
  await page.route(`**/workflows/${workflowId}/metadata`, async route => {
    if (route.request().method() === 'GET' && failWorkflowLoads) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ metadata: 'malformed' }),
      })
      return
    }
    await route.continue()
  })

  const englishMetadata = await openWorkflowMetadata(page, 'en', workflowId, workflowName)
  const englishWorkflowInput = englishMetadata.getByTestId('workflow-metadata-ai-guidance')
  await expect(englishWorkflowInput).toBeDisabled()
  await expect(englishMetadata.getByTestId('workflow-metadata-save')).toBeDisabled()
  const workflowLoadError = englishMetadata.getByTestId('workflow-metadata-load-error')
  await expect(workflowLoadError).toContainText("Couldn't load workflow metadata.")
  await capture(workflowLoadError, 'web-en-workflow-guidance-error')

  failWorkflowLoads = false
  await englishMetadata.getByTestId('workflow-metadata-retry').click()
  await expect(englishWorkflowInput).toBeEnabled()
  await englishWorkflowInput.fill('Use redis://operator:super-secret@cache.internal/0')
  await expect(englishWorkflowInput).toHaveAttribute('aria-invalid', 'true')
  await expect(englishMetadata).toContainText('Guidance contains a secret-like value. Remove it before saving.')
  await expect(englishMetadata.getByTestId('workflow-metadata-save')).toBeDisabled()
  await capture(
    englishWorkflowInput.locator('xpath=ancestor::label[1]'),
    'web-en-workflow-guidance-secret-blocked',
  )

  await englishWorkflowInput.fill(englishWorkflowGuidance)
  const englishWorkflowSaveResponse = page.waitForResponse(response => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/workflows/${workflowId}/metadata`
  ))
  await englishMetadata.getByRole('button', { name: 'Save', exact: true }).click()
  expect((await englishWorkflowSaveResponse).ok()).toBe(true)
  const englishMetadataPayload = await apiGet<{
    metadata: { aiGuidanceMarkdown?: string | null } | null
  }>(request, orgId, `/workflows/${workflowId}/metadata`)
  expect(englishMetadataPayload.metadata?.aiGuidanceMarkdown).toBe(englishWorkflowGuidance)
  const englishWorkflowField = englishWorkflowInput.locator('xpath=ancestor::label[1]')
  await hideUnrelatedOverlays(page)
  await capture(englishWorkflowField, 'web-en-workflow-guidance-saved')

  await switchLocale(page, 'es')
  await openOperationsReliability(page, 'es')
  const spanishOrgCard = page.getByTestId('ai-guidance-settings')
  const spanishOrgInput = spanishOrgCard.getByTestId('ai-guidance-org-input')
  await expect(spanishOrgInput).toHaveValue(englishOrgGuidance)
  await spanishOrgInput.fill(`Use sk-ant-${'a'.repeat(24)}`)
  await expect(spanishOrgInput).toHaveAttribute('aria-invalid', 'true')
  await expect(spanishOrgCard).toContainText('La guía contiene un valor con apariencia de secreto. Elimínalo antes de guardar.')
  await capture(spanishOrgCard, 'web-es-org-guidance-secret-blocked')
  await spanishOrgInput.fill(spanishOrgGuidance)
  const spanishOrgSaveResponse = page.waitForResponse(response => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/org/config'
  ))
  await spanishOrgCard.getByTestId('ai-guidance-org-save').click()
  expect((await spanishOrgSaveResponse).ok()).toBe(true)
  expect(await readOrgGuidance(request, orgId)).toBe(spanishOrgGuidance)
  await hideUnrelatedOverlays(page)
  await capture(spanishOrgCard, 'web-es-org-guidance-saved')

  const spanishMetadata = await openWorkflowMetadata(page, 'es', workflowId, workflowName)
  const spanishWorkflowInput = spanishMetadata.getByTestId('workflow-metadata-ai-guidance')
  await expect(spanishWorkflowInput).toBeEnabled()
  await expect(spanishWorkflowInput).toHaveValue(englishWorkflowGuidance)
  await spanishWorkflowInput.fill(`Use sk-ant-${'b'.repeat(24)}`)
  await expect(spanishWorkflowInput).toHaveAttribute('aria-invalid', 'true')
  await expect(spanishMetadata).toContainText('La guía contiene un valor con apariencia de secreto. Elimínalo antes de guardar.')
  await capture(
    spanishWorkflowInput.locator('xpath=ancestor::label[1]'),
    'web-es-workflow-guidance-secret-blocked',
  )
  await spanishWorkflowInput.fill(spanishWorkflowGuidance)
  const spanishWorkflowSaveResponse = page.waitForResponse(response => (
    response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/workflows/${workflowId}/metadata`
  ))
  await spanishMetadata.getByRole('button', { name: 'Guardar', exact: true }).click()
  expect((await spanishWorkflowSaveResponse).ok()).toBe(true)
  const spanishMetadataPayload = await apiGet<{
    metadata: { aiGuidanceMarkdown?: string | null } | null
  }>(request, orgId, `/workflows/${workflowId}/metadata`)
  expect(spanishMetadataPayload.metadata?.aiGuidanceMarkdown).toBe(spanishWorkflowGuidance)
  const spanishWorkflowField = spanishWorkflowInput.locator('xpath=ancestor::label[1]')
  await hideUnrelatedOverlays(page)
  await capture(spanishWorkflowField, 'web-es-workflow-guidance-saved')

  await page.unroute('**/org/config')
  await page.unroute(`**/workflows/${workflowId}/metadata`)
  expect(browserErrors).toEqual([])
})

test('recovery exposes considered alternatives separately from evidence in both locales', async ({ page, request }) => {
  test.setTimeout(120_000)
  const browserErrors = installConsoleErrorGuards(page)
  const stamp = Date.now()
  const orgId = `inspect-recovery-${stamp}`
  const nodeId = `inspect_failure_${stamp}`
  const failingWorkflow = {
    id: `inspect-recovery-flow-${stamp}`,
    name: `Inspectable recovery ${stamp}`,
    nodes: [{
      id: nodeId,
      type: 'http',
      config: { url: `{{secret.INSPECTABLE_RECOVERY_${stamp}}}` },
    }],
    edges: [],
  }
  const fixedWorkflow = {
    ...failingWorkflow,
    nodes: [{ id: nodeId, type: 'noop', config: {} }],
  }

  const runId = await startRun(request, orgId, failingWorkflow, { source: 'inspectable-recovery' })
  expect((await pollUntilTerminal(request, orgId, runId)).status).toBe('failed')
  const deadLetter = await findDeadLetter(request, orgId, runId)
  expect(deadLetter.nodeId).toBe(nodeId)

  await setBrowserContext(page, orgId)
  await page.route('**/ai/patch-workflow', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        mode: 'ai',
        suggestedWorkflow: fixedWorkflow,
        rationale: 'Replace the unresolved remote call with a safe deterministic step.',
        suggestions: [{
          workflow: fixedWorkflow,
          rationale: 'Replace the unresolved remote call with a safe deterministic step.',
          approachLabel: 'other',
          confidence: 94,
          calibratedConfidence: 91,
          safety: { writeSide: false, approvalRequired: false, approvalPresent: true },
          consideredAlternatives: [
            {
              approach: 'Increase the HTTP timeout',
              rejectedBecause: 'The request URL is unresolved, so waiting longer cannot restore execution.',
            },
            {
              approach: 'Retry the original node',
              rejectedBecause: 'A retry would repeat the same deterministic missing-secret failure.',
            },
          ],
        }],
        evidence: [{
          kind: 'signature_rule',
          sourceRef: 'missing_secret',
          snippet: 'The failing node stopped before issuing an outbound request.',
        }],
        recoveryPassport: {
          failureSignature: 'Missing secret while resolving the HTTP target',
          priorSameSignatureOutcome: null,
        },
      }),
    })
  })

  await page.goto('/')
  await hideUnrelatedOverlays(page)
  const englishHypotheses = await openRecoverySuggestion(page, 'en', deadLetter.id, nodeId)
  expect(await englishHypotheses.evaluate(element => (element as HTMLDetailsElement).open)).toBe(false)
  await expect(englishHypotheses).toContainText('Why this fix · 2 alternatives considered')
  await capture(englishHypotheses, 'web-en-recovery-hypotheses-collapsed')
  await englishHypotheses.locator('summary').click()
  expect(await englishHypotheses.evaluate(element => (element as HTMLDetailsElement).open)).toBe(true)
  await expect(englishHypotheses).toContainText('Increase the HTTP timeout')
  await expect(englishHypotheses).toContainText('Retry the original node')
  const englishEvidence = page.locator('.we-recovery-evidence')
  await expect(englishEvidence).toBeVisible()
  expect(await englishHypotheses.evaluate(element => {
    const evidence = document.querySelector('.we-recovery-evidence')
    return evidence !== null
      && Boolean(element.compareDocumentPosition(evidence) & Node.DOCUMENT_POSITION_FOLLOWING)
  })).toBe(true)
  await capture(englishHypotheses, 'web-en-recovery-hypotheses-expanded')
  await page.getByRole('button', { name: 'Close recovery dialog' }).click()

  await switchLocale(page, 'es')
  const spanishHypotheses = await openRecoverySuggestion(page, 'es', deadLetter.id, nodeId)
  expect(await spanishHypotheses.evaluate(element => (element as HTMLDetailsElement).open)).toBe(false)
  await expect(spanishHypotheses).toContainText('Por qué esta corrección · 2 alternativas consideradas')
  await capture(spanishHypotheses, 'web-es-recovery-hypotheses-collapsed')
  await spanishHypotheses.locator('summary').click()
  expect(await spanishHypotheses.evaluate(element => (element as HTMLDetailsElement).open)).toBe(true)
  await expect(spanishHypotheses).toContainText('Increase the HTTP timeout')
  await expect(spanishHypotheses).toContainText('La evidencia determinista aparece por separado')
  await capture(spanishHypotheses, 'web-es-recovery-hypotheses-expanded')

  await page.unroute('**/ai/patch-workflow')
  expect(browserErrors).toEqual([])
})

test('the real worker emits one bounded agent rationale and the timeline hides its legacy twin', async ({ page, request }) => {
  test.setTimeout(120_000)
  const browserErrors = installConsoleErrorGuards(page)
  const stamp = Date.now()
  const orgId = `inspect-reasoning-${stamp}`
  const nodeId = `policy_operator_${stamp}`
  const runId = await startRun(request, orgId, {
    id: `inspect-reasoning-flow-${stamp}`,
    name: `Inspectable reasoning ${stamp}`,
    nodes: [{
      id: nodeId,
      type: 'agent',
      config: {
        name: 'Policy operator',
        planner: 'rules',
        goal: 'Uppercase the provided value',
        value: 'janusly',
        maxSteps: 1,
      },
    }],
    edges: [],
  }, { source: 'inspectable-reasoning' })
  const terminal = await pollUntilTerminal(request, orgId, runId)
  expect(terminal.status).toBe('succeeded')
  const reasoningEvent = terminal.events.find(event => event.type === 'agent.reasoning')
  const legacyEvent = terminal.events.find(event => event.type === 'agent.step.planned')
  expect(reasoningEvent?.id).toBeTruthy()
  expect(legacyEvent?.id).toBeTruthy()
  expect(reasoningEvent?.payload).toMatchObject({
    agent: 'Policy operator',
    planner: 'rules',
    mode: 'rules',
    decision: 'use_tool',
    tool: 'text.uppercase',
    replacesEventId: legacyEvent?.id,
  })
  expect(JSON.stringify(reasoningEvent?.payload)).not.toContain('JANUSLY')
  const transitionRunId = await startRun(request, orgId, {
    id: `inspect-reasoning-transition-${stamp}`,
    name: `Reasoning transition ${stamp}`,
    nodes: [{ id: 'finish', type: 'noop', config: {} }],
    edges: [],
  })
  expect((await pollUntilTerminal(request, orgId, transitionRunId)).status).toBe('succeeded')

  await setBrowserContext(page, orgId)
  await page.goto('/')
  await hideUnrelatedOverlays(page)
  await openRunTimeline(page, 'en', runId)
  const englishTimeline = page.locator('[data-testid="run-event-timeline"]:visible')
  const englishFilter = englishTimeline.getByTestId('run-event-filter')
  const englishEvents = englishTimeline.locator('.we-reasoning-list article.we-run-event')
  await englishFilter.fill('agent.reasoning')
  await expect(englishEvents).toHaveCount(1)
  const englishEventCard = englishTimeline.getByTestId(`run-event-${reasoningEvent!.id}`)
  const englishSummary = englishEventCard.getByTestId('agent-reasoning-summary')
  await expect(englishSummary).toContainText('Why this step?')
  await expect(englishSummary).toContainText('Goal matched text uppercase transformation')
  await expect(englishSummary).toContainText('Tool text.uppercase')
  await expect(englishSummary).toContainText('Rules')
  await capture(englishEventCard, 'web-en-agent-reasoning-result')
  await englishFilter.fill('agent.step.planned')
  await expect(englishEvents).toHaveCount(0)

  await switchLocale(page, 'es')
  await openRunTimeline(page, 'es', runId)
  const spanishTimeline = page.locator('[data-testid="run-event-timeline"]:visible')
  const spanishFilter = spanishTimeline.getByTestId('run-event-filter')
  const spanishEvents = spanishTimeline.locator('.we-reasoning-list article.we-run-event')
  await spanishFilter.fill('agent.reasoning')
  await expect(spanishEvents).toHaveCount(1)
  const spanishEventCard = spanishTimeline.getByTestId(`run-event-${reasoningEvent!.id}`)
  const spanishSummary = spanishEventCard.getByTestId('agent-reasoning-summary')
  await expect(spanishSummary).toContainText('¿Por qué este paso?')
  await expect(spanishSummary).toContainText('Herramienta text.uppercase')
  await expect(spanishSummary).toContainText('Reglas')
  await capture(spanishEventCard, 'web-es-agent-reasoning-result')
  await spanishFilter.fill('agent.step.planned')
  await expect(spanishEvents).toHaveCount(0)
  await openRunTimeline(page, 'es', transitionRunId)

  const injectedSecret = `sk-proj-${'z'.repeat(24)}`
  const malformedReasoningId = `malformed-${reasoningEvent!.id}`
  await db.insert(runEvents).values({
    id: malformedReasoningId,
    runId,
    nodeId,
    type: 'agent.reasoning',
    payload: { decision: 'use_tool', reason: injectedSecret },
    createdAt: new Date(),
  })

  await openRunTimeline(page, 'es', runId)
  const spanishInvalidTimeline = page.locator('[data-testid="run-event-timeline"]:visible')
  await spanishInvalidTimeline.getByTestId('run-event-filter').fill('agent.reasoning')
  const spanishInvalidCard = spanishInvalidTimeline.getByTestId(`run-event-${malformedReasoningId}`)
  await expect(spanishInvalidCard.getByTestId('agent-reasoning-invalid'))
    .toContainText('Este evento de razonamiento no se pudo mostrar de forma segura.')
  await expect(spanishInvalidCard).not.toContainText(injectedSecret)
  await expect(spanishInvalidCard.getByText('Ver evento sin procesar')).toHaveCount(0)
  await capture(spanishInvalidCard, 'web-es-agent-reasoning-invalid')

  await switchLocale(page, 'en')
  await openRunTimeline(page, 'en', transitionRunId)
  await openRunTimeline(page, 'en', runId)
  const englishInvalidTimeline = page.locator('[data-testid="run-event-timeline"]:visible')
  await englishInvalidTimeline.getByTestId('run-event-filter').fill('agent.reasoning')
  const englishInvalidCard = englishInvalidTimeline.getByTestId(`run-event-${malformedReasoningId}`)
  await expect(englishInvalidCard.getByTestId('agent-reasoning-invalid'))
    .toContainText('This reasoning event could not be displayed safely.')
  await expect(englishInvalidCard).not.toContainText(injectedSecret)
  await expect(englishInvalidCard.getByText('Show raw event')).toHaveCount(0)
  await capture(englishInvalidCard, 'web-en-agent-reasoning-invalid')

  expect(browserErrors).toEqual([])
})
