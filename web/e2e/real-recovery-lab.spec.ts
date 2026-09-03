import { mkdir, readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

const enabled = process.env.JANUSLY_REAL_RECOVERY_LAB_E2E === '1'
const evidenceDir = process.env.JANUSLY_EVIDENCE_DIR
const evidencePath = process.env.JANUSLY_RECOVERY_LAB_EVIDENCE
const orgId = process.env.JANUSLY_RECOVERY_LAB_ORG_ID ?? 'local-recovery-lab'

type RecoveryLabEvidence = {
  failedRunId: string
  validationRunId: string
}

async function readRecoveryLabEvidence(): Promise<RecoveryLabEvidence> {
  if (!evidencePath) throw new Error('JANUSLY_RECOVERY_LAB_EVIDENCE is required')
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8')) as Partial<RecoveryLabEvidence>
  if (!evidence.failedRunId || !evidence.validationRunId) {
    throw new Error('Recovery Lab evidence is missing run identifiers')
  }
  return evidence as RecoveryLabEvidence
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

async function prepare(page: Page, locale: 'en' | 'es') {
  await page.addInitScript(({ activeOrg, language }) => {
    window.localStorage.setItem('janusly:activeOrg', activeOrg)
    window.localStorage.setItem('janusly:locale', language)
    window.localStorage.setItem('janusly:recovery:hideIntro', 'true')
  }, { activeOrg: orgId, language: locale })
}

for (const locale of ['en', 'es'] as const) {
  test(`real recovery lab exposes combined recovery evidence in ${locale}`, async ({ page }) => {
    test.skip(!enabled, 'requires a completed persistent local recovery lab')
    const evidence = await readRecoveryLabEvidence()
    const browserErrors = guardBrowserErrors(page)
    await prepare(page, locale)
    await page.goto('/')

    const runsLabel = locale === 'en' ? 'Runs' : 'Ejecuciones'
    const evidenceLabel = locale === 'en' ? 'Provider simulated' : 'Proveedor simulado'
    const outcomeLabel = locale === 'en' ? 'Outcome recovered' : 'Resultado recuperado'
    const knownCostLabel = locale === 'en' ? 'Known cost' : 'Costo conocido'
    const receiptLabel = locale === 'en'
      ? 'Provider simulation receipt recorded'
      : 'Recibo de simulación del proveedor registrado'
    await page.getByRole('button', { name: runsLabel, exact: true }).click()
    await expect(page.getByRole('heading', { name: runsLabel, exact: true })).toBeVisible()

    const recoveredOutcome = page.getByTestId(`run-semantic-outcome-${evidence.failedRunId}`)
    await expect(recoveredOutcome).toHaveText(outcomeLabel)
    const recoveredRow = recoveredOutcome.locator('xpath=ancestor::article')
    await recoveredRow.scrollIntoViewIfNeeded()
    await capture(page, `real-recovery-lab-semantic-run-${locale}`)

    await recoveredRow.locator('button.list-card-row').click()
    await page.getByTestId('run-workspace-tab-timeline').click()
    await page.getByTestId('run-event-filter').fill('recovery.semantic')
    const semanticViolation = page.getByRole('listitem', { name: /recovery\.semantic_violation/i })
    const semanticResolution = page.getByRole('listitem', { name: /recovery\.semantic_resolved/i })
    await expect(semanticViolation).toBeVisible()
    await expect(semanticResolution).toBeVisible()
    const knownCost = page.getByTestId('run-resource-usage')
      .locator('dl > div')
      .filter({ hasText: knownCostLabel })
    await expect(knownCost.locator('dd')).toHaveText(/0[.,]00/)
    await semanticResolution.scrollIntoViewIfNeeded()
    await capture(page, `real-recovery-lab-semantic-timeline-${locale}`)

    await page.getByTestId('run-workspace-tab-overview').click()
    const validationEvidence = page.getByTestId(`run-validation-evidence-${evidence.validationRunId}`)
    await expect(validationEvidence).toHaveText(evidenceLabel)
    const validationRow = validationEvidence.locator('xpath=ancestor::article')
    await expect(validationRow).toBeVisible()
    await validationRow.scrollIntoViewIfNeeded()
    await capture(page, `real-recovery-lab-provider-run-${locale}`)

    await validationRow.locator('button.list-card-row').click()
    await expect(page.getByTestId('active-run-validation-evidence'))
      .toHaveText(evidenceLabel)
    await page.getByTestId('run-workspace-tab-timeline').click()
    await page.getByTestId('run-event-filter').fill('provider_simulation_receipt')
    const receiptRow = page.getByRole('listitem').filter({ hasText: receiptLabel })
    await expect(receiptRow).toContainText('provider_simulation_receipt')
    await receiptRow.scrollIntoViewIfNeeded()
    await capture(page, `real-recovery-lab-provider-receipt-${locale}`)

    expect(browserErrors).toEqual([])
  })
}
