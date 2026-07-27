import { mkdir, writeFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

const enabled = process.env.JANUSLY_SEMANTIC_OUTCOME_E2E === '1'
const evidenceDir = process.env.JANUSLY_EVIDENCE_DIR
const apiUrl = process.env.E2E_API_URL ?? 'http://127.0.0.1:7311'

type Locale = 'en' | 'es'
type Fixture = {
  orgId: string
  userId: string
  runId: string
  caseId: string
  workflowName: string
}

const fixtures = new Map<Locale, Fixture>()

function labels(locale: Locale) {
  return locale === 'en'
    ? {
        workflowName: 'Semantic outcome recovery',
        message: 'The draft requires an operator-approved business outcome.',
        reason: 'Reviewed against the business policy.',
        runs: 'Runs',
        recovered: 'Outcome recovered',
        blockedRun: '1 blocked run',
        blockedRunAria: 'Open recovery — 1 run is blocked on a human gate',
        allClearAria: 'Open Recovery Center — no pending work',
      }
    : {
        workflowName: 'Recuperación de resultado semántico',
        message: 'El borrador requiere un resultado de negocio aprobado por un operador.',
        reason: 'Revisado según la política de negocio.',
        runs: 'Ejecuciones',
        recovered: 'Resultado recuperado',
        blockedRun: '1 ejecución bloqueada',
        blockedRunAria: 'Abrir recuperación — 1 ejecución está bloqueada en un gate humano',
        allClearAria: 'Abrir Centro de Recuperación — sin trabajo pendiente',
      }
}

function headers(orgId: string, userId: string) {
  return {
    'content-type': 'application/json',
    'x-org-id': orgId,
    'x-user-id': userId,
  }
}

async function requestJson<T>(
  path: string,
  options: RequestInit & { orgId: string; userId: string },
): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    ...options,
    headers: {
      ...headers(options.orgId, options.userId),
      ...(options.headers ?? {}),
    },
  })
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${path} returned ${response.status}: ${text}`)
  }
  return JSON.parse(text) as T
}

async function createFixture(locale: Locale): Promise<Fixture> {
  const copy = labels(locale)
  const orgId = `local-recovery-lab-semantic-${locale}`
  const userId = `semantic-operator-${locale}`
  const target = `semantic-${locale}-${Date.now()}`
  const workflow = {
    dslVersion: '1.0',
    id: `semantic-outcome-${locale}-${Date.now()}`,
    name: copy.workflowName,
    nodes: [
      {
        id: 'draft_response',
        type: 'transform',
        config: {
          mapping: {
            mode: 'ai',
            approved: false,
            response: 'A syntactically valid draft that is not approved for delivery.',
          },
        },
      },
      {
        id: 'deliver',
        type: 'http',
        config: {
          url: `http://provider-simulator:4010/webhook?target=${target}`,
          method: 'POST',
          headers: { 'X-Idempotency-Key': target },
          body: { result: '{{context.draft_response.output.response}}' },
        },
      },
    ],
    edges: [{ from: 'draft_response', to: 'deliver' }],
    recovery: {
      contract: {
        version: '2',
        failure: {
          technical: {
            terminalNodeFailure: true,
            stalledNode: true,
          },
          semantic: {
            mode: 'deterministic',
            detectors: [
              {
                id: 'operator-approved',
                sourceNodeId: 'draft_response',
                kind: 'expression',
                passWhen: 'context.draft_response.output.approved === true',
                action: 'quarantine',
                message: copy.message,
              },
            ],
            evaluationFixtures: [
              {
                id: 'approved-draft',
                sourceNodeId: 'draft_response',
                output: { mode: 'ai', approved: true, response: 'Reviewed draft' },
                expected: 'pass',
              },
              {
                id: 'unapproved-draft',
                sourceNodeId: 'draft_response',
                output: { mode: 'ai', approved: false, response: 'Unreviewed draft' },
                expected: 'violation',
              },
            ],
          },
        },
        evidence: {
          required: ['failure_snapshot', 'audit_trail', 'terminal_outcome'],
        },
        effects: [
          {
            nodeId: 'deliver',
            kind: 'notification',
            idempotency: 'required',
            receipt: 'provider',
          },
        ],
        repairs: { allowed: ['config_patch'] },
        validation: { minimumEvidenceLevel: 'static' },
        approval: {
          productionMutation: 'required',
          permission: 'recovery.write',
        },
        autonomyLevel: 3,
        verification: {
          kind: 'generation_bound_terminal_success',
        },
        recurrence: { windowDays: 7 },
      },
    },
  }

  const started = await requestJson<{ runId: string }>('/start', {
    method: 'POST',
    orgId,
    userId,
    body: JSON.stringify({ workflow, input: {} }),
  })

  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const snapshot = await requestJson<{
      run: { status: string; outcomeStatus?: string | null }
      nodes: Array<{ nodeId: string; status: string }>
    }>(`/run?runId=${encodeURIComponent(started.runId)}`, {
      method: 'GET',
      orgId,
      userId,
    })
    const delivery = snapshot.nodes.find(node => node.nodeId === 'deliver')
    if (
      snapshot.run.status === 'waiting'
      && snapshot.run.outcomeStatus === 'semantic_quarantined'
      && delivery?.status === 'pending'
    ) {
      const listed = await requestJson<{
        cases: Array<{ id: string; action: string; state: string }>
      }>(`/recovery/cases?runId=${encodeURIComponent(started.runId)}`, {
        method: 'GET',
        orgId,
        userId,
      })
      const recoveryCase = listed.cases.find(
        item => item.action === 'quarantine' && item.state === 'contained',
      )
      if (!recoveryCase) throw new Error('semantic quarantine case was not persisted')
      return {
        orgId,
        userId,
        runId: started.runId,
        caseId: recoveryCase.id,
        workflowName: copy.workflowName,
      }
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`run ${started.runId} did not enter semantic quarantine`)
}

function guardBrowserErrors(page: Page) {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${new URL(response.url()).pathname}`)
  })
  return errors
}

async function capture(page: Page, name: string) {
  if (!evidenceDir) return
  await mkdir(evidenceDir, { recursive: true })
  await page.screenshot({ path: `${evidenceDir}/${name}.png`, fullPage: true })
}

async function persistEvidence() {
  if (!evidenceDir) return
  await mkdir(evidenceDir, { recursive: true })
  await writeFile(
    `${evidenceDir}/semantic-outcome-evidence.json`,
    `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      evidenceLevel: 'deterministic_local_runtime',
      fixtures: Object.fromEntries(fixtures),
    }, null, 2)}\n`,
    'utf8',
  )
}

for (const locale of ['en', 'es'] as const) {
  test(`semantic quarantine is visible and recoverable in ${locale}`, async ({ page }) => {
    test.skip(!enabled, 'requires the persistent local Docker stack')
    const fixture = await createFixture(locale)
    fixtures.set(locale, fixture)
    await persistEvidence()

    const copy = labels(locale)
    const browserErrors = guardBrowserErrors(page)

    await page.addInitScript(({ activeOrg, language }) => {
      window.localStorage.setItem('janusly:activeOrg', activeOrg)
      window.localStorage.setItem('janusly:locale', language)
      window.localStorage.setItem('janusly:recovery:hideIntro', 'true')
    }, { activeOrg: fixture.orgId, language: locale })

    await page.goto('/')
    const tile = page.getByTestId('recovery-center-tile-semantic')
    await expect(tile).toContainText(copy.message)
    await expect(page.getByRole('button', { name: copy.blockedRunAria })).toContainText(
      copy.blockedRun,
    )
    const recoveryCase = page.getByTestId(`semantic-recovery-case-${fixture.caseId}`)
    await expect(recoveryCase).toBeVisible()
    await recoveryCase.scrollIntoViewIfNeeded()
    await capture(page, `semantic-outcome-quarantine-${locale}`)

    await page.getByTestId(`semantic-recovery-open-${fixture.caseId}`).click()
    await page.getByTestId(`semantic-recovery-output-${fixture.caseId}`).fill(
      JSON.stringify({
        mode: 'ai',
        approved: true,
        response: locale === 'en' ? 'Reviewed safe response' : 'Respuesta segura revisada',
      }, null, 2),
    )
    await page.getByLabel(
      locale === 'en' ? 'Operator rationale' : 'Justificación del operador',
    ).fill(copy.reason)
    await page.getByTestId(`semantic-recovery-replace-${fixture.caseId}`).click()
    await expect(page.getByTestId('recovery-center-semantic-allclear')).toBeVisible()
    await expect(page.getByRole('button', { name: copy.allClearAria })).toBeVisible()

    await page.getByRole('button', { name: copy.runs, exact: true }).click()
    const runRow = page.getByRole('article').filter({ hasText: fixture.workflowName }).first()
    await expect(runRow.locator('[data-outcome-status="semantic_recovered"]')).toHaveText(copy.recovered)
    await runRow.getByRole('button').first().click()
    await expect(runRow.locator('.status-pill[data-status="succeeded"]')).toBeVisible()
    await runRow.scrollIntoViewIfNeeded()
    await capture(page, `semantic-outcome-recovered-${locale}`)
    await expect(runRow.locator('.status-pill[data-status="succeeded"]')).toBeVisible()

    expect(browserErrors).toEqual([])
  })
}
