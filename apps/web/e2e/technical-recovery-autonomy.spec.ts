import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { openWorkspaceSection } from './_helpers/workspace-navigation'

const execFileAsync = promisify(execFile)
const COMPOSE_FILE = fileURLToPath(new URL('../../../docker-compose.yml', import.meta.url))
const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR

const LOCALES = [
  {
    locale: 'en',
    recover: 'Recover',
    eligible: 'Technically eligible',
    blocked: 'Operator required',
    blockedReason: 'The operator policy does not allow this repair class.',
  },
  {
    locale: 'es',
    recover: 'Recuperar',
    eligible: 'Técnicamente elegible',
    blocked: 'Requiere operador',
    blockedReason: 'La política del operador no permite esta clase de reparación.',
  },
] as const

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function jsonLiteral(value: unknown): string {
  return `${sqlLiteral(JSON.stringify(value))}::jsonb`
}

function workflow(maxAttempts: number, url = 'https://payments.example/charge') {
  return {
    id: 'billing-recovery',
    name: 'Billing recovery',
    recovery: {
      contract: {
        version: '1',
        failure: {
          technical: {
            terminalNodeFailure: true,
            stalledNode: true,
          },
          semantic: { mode: 'disabled' },
        },
        evidence: {
          required: [
            'failure_snapshot',
            'audit_trail',
            'validation_receipt',
            'effect_receipt',
            'terminal_outcome',
          ],
        },
        effects: [{
          nodeId: 'charge',
          kind: 'financial_mutation',
          idempotency: 'required',
          receipt: 'provider',
        }],
        repairs: { allowed: ['retry', 'config_patch'] },
        validation: { minimumEvidenceLevel: 'provider_simulated' },
        approval: {
          productionMutation: 'autonomous_level_4',
          permission: 'recovery.write',
        },
        autonomyLevel: 4,
        narrowAutonomy: {
          allowedRepairClasses: ['retry'],
          minimumPriorVerifiedRecoveries: 2,
          maxAffectedExecutions: 1,
          rollbackRequired: true,
        },
        verification: { kind: 'generation_bound_terminal_success' },
        recurrence: { windowDays: 7 },
      },
    },
    nodes: [{
      id: 'charge',
      type: 'http',
      config: {
        url,
        method: 'POST',
        retry: { maxAttempts },
      },
    }],
    edges: [],
  }
}

async function seedAutonomyEvidence(orgId: string): Promise<void> {
  const suffix = orgId.replaceAll(/[^a-zA-Z0-9]/g, '').slice(-24)
  const original = workflow(1)
  const eligibleCandidate = workflow(3)
  const blockedCandidate = workflow(1, 'https://payments.example/v2/charge')
  const eligibleDlq = `autonomy-eligible-dlq-${suffix}`
  const blockedDlq = `autonomy-blocked-dlq-${suffix}`
  const priorDlqs = [0, 1].map((index) => `autonomy-prior-${suffix}-${index}`)
  const now = new Date().toISOString()
  const deadLetterRows = [
    [eligibleDlq, 'run-eligible', original],
    [blockedDlq, 'run-blocked', original],
    ...priorDlqs.map((id, index) => [id, `run-prior-${index}`, original] as const),
  ].map(([id, runId, snapshot]) => `(
    ${sqlLiteral(id)},
    ${sqlLiteral(orgId)},
    ${sqlLiteral(`${runId}-${suffix}`)},
    'charge',
    1,
    ${jsonLiteral(snapshot)},
    ${jsonLiteral(snapshot.nodes[0])},
    '{"code":"provider_timeout","message":"Provider timed out"}'::jsonb,
    'open',
    ${sqlLiteral(now)}::timestamptz
  )`).join(',')
  const appliedRows = priorDlqs.flatMap((deadLetterId, index) => [
    `(
      ${sqlLiteral(`autonomy-prior-eligible-${suffix}-${index}`)},
      ${sqlLiteral(orgId)},
      ${sqlLiteral(deadLetterId)},
      'signature-eligible',
      'applied',
      ${jsonLiteral(eligibleCandidate)},
      'add_retry',
      95,
      'provider_simulated',
      1,
      ${sqlLiteral(now)}::timestamptz,
      ${sqlLiteral(now)}::timestamptz
    )`,
    `(
      ${sqlLiteral(`autonomy-prior-blocked-${suffix}-${index}`)},
      ${sqlLiteral(orgId)},
      ${sqlLiteral(deadLetterId)},
      'signature-blocked',
      'applied',
      ${jsonLiteral(blockedCandidate)},
      'fix_url',
      95,
      'provider_simulated',
      1,
      ${sqlLiteral(now)}::timestamptz,
      ${sqlLiteral(now)}::timestamptz
    )`,
  ]).join(',')
  const impactRows = priorDlqs.map((deadLetterId, index) => `(
    ${sqlLiteral(deadLetterId)},
    ${sqlLiteral(orgId)},
    ${sqlLiteral(`run-prior-${index}-${suffix}`)},
    'charge',
    'operator',
    ${sqlLiteral(now)}::timestamptz,
    1000
  )`).join(',')

  await execFileAsync('docker', [
    'compose', '-f', COMPOSE_FILE,
    'exec', '-T', 'postgres',
    'psql', '-U', 'postgres', '-d', 'workflow', '-v', 'ON_ERROR_STOP=1',
    '-c', `INSERT INTO dead_letters (
      id, org_id, run_id, node_id, attempt, workflow_json, node_json,
      error_json, status, created_at
    ) VALUES ${deadLetterRows};
    INSERT INTO auto_healing_runs (
      id, org_id, dead_letter_id, signature, status, proposed_patch_json,
      approach_label, confidence, validation_evidence_level,
      loop_attempt_count, created_at, updated_at
    ) VALUES (
      ${sqlLiteral(`autonomy-eligible-${suffix}`)},
      ${sqlLiteral(orgId)},
      ${sqlLiteral(eligibleDlq)},
      'signature-eligible',
      'validated',
      ${jsonLiteral(eligibleCandidate)},
      'add_retry',
      92,
      'provider_simulated',
      1,
      ${sqlLiteral(now)}::timestamptz,
      ${sqlLiteral(now)}::timestamptz
    ), (
      ${sqlLiteral(`autonomy-blocked-${suffix}`)},
      ${sqlLiteral(orgId)},
      ${sqlLiteral(blockedDlq)},
      'signature-blocked',
      'validated',
      ${jsonLiteral(blockedCandidate)},
      'fix_url',
      88,
      'provider_simulated',
      1,
      ${sqlLiteral(now)}::timestamptz,
      ${sqlLiteral(now)}::timestamptz
    ), ${appliedRows};
    INSERT INTO recovery_impact_events (
      dead_letter_id, org_id, run_id, node_id, user_id,
      recovered_at, downtime_ended_ms
    ) VALUES ${impactRows};`,
  ])
}

async function prepareSession(
  page: Page,
  locale: 'en' | 'es',
): Promise<string> {
  const orgId =
    `technical-autonomy-${locale}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await page.addInitScript(({ activeOrg, selectedLocale }) => {
    window.localStorage.setItem('janusly:activeOrg', activeOrg)
    window.localStorage.setItem('janusly:locale', selectedLocale)
  }, { activeOrg: orgId, selectedLocale: locale })
  return orgId
}

async function capture(locator: Locator, name: string): Promise<void> {
  await expect(locator).toBeVisible()
  if (!EVIDENCE_DIR) return
  await mkdir(EVIDENCE_DIR, { recursive: true })
  await locator.screenshot({
    path: `${EVIDENCE_DIR}/${name}.png`,
    animations: 'disabled',
    caret: 'hide',
  })
}

test.describe.configure({ mode: 'serial' })

for (const contract of LOCALES) {
  test(`${contract.locale} explains eligible and blocked Level 4 repairs`, async ({ page }) => {
    const consoleErrors: string[] = []
    const pageErrors: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('pageerror', (error) => pageErrors.push(error.message))

    await page.setViewportSize({ width: 1440, height: 1100 })
    const orgId = await prepareSession(page, contract.locale)
    await seedAutonomyEvidence(orgId)
    await page.goto('/')
    await openWorkspaceSection(
      page,
      contract.locale === 'en' ? 'Activity' : 'Actividad',
      contract.recover,
    )

    const card = page.getByTestId('auto-healing-pending-card')
    await expect(card.getByText(contract.eligible, { exact: true })).toBeVisible()
    await expect(card.getByText(contract.blocked, { exact: true })).toBeVisible()
    await expect(card.getByText(contract.blockedReason, { exact: true })).toBeVisible()
    await expect(card.locator('.we-auto-healing-autonomy__factor')).toHaveCount(14)
    expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await capture(card, `web-${contract.locale}-technical-recovery-autonomy`)

    expect(consoleErrors).toEqual([])
    expect(pageErrors).toEqual([])
  })
}
