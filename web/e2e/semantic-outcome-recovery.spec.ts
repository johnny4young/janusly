import { mkdir, writeFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import {
  createSemanticRecoveryFixture,
  type SemanticRecoveryFixture,
} from './_helpers/semantic-recovery-fixture'
import {
  openWorkspaceDestination,
  openWorkspaceSection,
} from './_helpers/workspace-navigation'

const enabled = process.env.JANUSLY_SEMANTIC_OUTCOME_E2E === '1'
const evidenceDir = process.env.JANUSLY_EVIDENCE_DIR

type Locale = 'en' | 'es'

const fixtures = new Map<string, SemanticRecoveryFixture>()

function labels(locale: Locale) {
  return locale === 'en'
    ? {
        workflowName: 'Semantic outcome recovery',
        briefTitle: 'Diagnose a business outcome incident',
        message: 'The draft requires an operator-approved business outcome.',
        reason: 'Reviewed against the business policy.',
        runs: 'Runs',
        recovered: 'Outcome recovered',
        blockedRunAria: 'Open recovery — 1 run is blocked on a human gate',
        allClearAria: 'Open Recovery Center — no pending work',
        backToRecovery: 'Back to Recovery Center',
      }
    : {
        workflowName: 'Recuperación de resultado semántico',
        briefTitle: 'Diagnosticar un incidente de resultado de negocio',
        message: 'El borrador requiere un resultado de negocio aprobado por un operador.',
        reason: 'Revisado según la política de negocio.',
        runs: 'Ejecuciones',
        recovered: 'Resultado recuperado',
        blockedRunAria: 'Abrir recuperación — 1 ejecución está bloqueada en un gate humano',
        allClearAria: 'Abrir Centro de Recuperación — sin trabajo pendiente',
        backToRecovery: 'Volver al Centro de recuperación',
      }
}

const createFixture = createSemanticRecoveryFixture

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

async function expectNoHorizontalOverflow(page: Page) {
  const { overflow, scrollX } = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    scrollX: window.scrollX,
  }))
  expect(overflow).toBeLessThanOrEqual(2)
  expect(scrollX).toBe(0)
}

async function hideTransientOverlays(page: Page) {
  await page.evaluate(() => {
    for (const selector of ['.toast', '.toast-stack']) {
      for (const element of document.querySelectorAll<HTMLElement>(selector)) {
        element.style.display = 'none'
      }
    }
  })
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
    fixtures.set(`${locale}-level3`, fixture)
    await persistEvidence()

    const copy = labels(locale)
    const browserErrors = guardBrowserErrors(page)

    await page.addInitScript(({ activeOrg, language }) => {
      window.localStorage.setItem('janusly:activeOrg', activeOrg)
      window.localStorage.setItem('janusly:locale', language)
      window.localStorage.setItem('janusly:recovery:hideIntro', 'true')
    }, { activeOrg: fixture.orgId, language: locale })

    await page.goto('/')
    const action = page.getByTestId(
      `recovery-center-action-recovery-case:${fixture.caseId}`,
    )
    // Home consumes the bounded Operator Brief and intentionally avoids
    // placing detector evidence in the ranking card. The exact incident copy
    // belongs to the authenticated case workspace opened by the CTA.
    await expect(action).toContainText(copy.briefTitle)
    await expect(page.getByRole('button', { name: copy.blockedRunAria })).toBeVisible()
    await expectNoHorizontalOverflow(page)
    await capture(page, `semantic-outcome-quarantine-${locale}`)

    await page.getByTestId(
      `recovery-center-action-cta-recovery-case:${fixture.caseId}`,
    ).click()
    const workspace = page.getByTestId(`recovery-case-workspace-${fixture.caseId}`)
    await expect(workspace).toBeVisible()
    await expect(workspace).toContainText(copy.message)
    const autonomy = page.getByTestId(
      `recovery-autonomy-profile-${fixture.caseId}`,
    )
    await expect(autonomy).toContainText(
      locale === 'en' ? 'Level 3' : 'Nivel 3',
    )
    await expect(autonomy).toContainText(
      locale === 'en'
        ? 'Failure-specific override'
        : 'Excepción específica del fallo',
    )
    await expect(autonomy).toContainText(
      locale === 'en' ? 'Apply with approval' : 'Aplicar con aprobación',
    )
    await expect(autonomy).toContainText(
      locale === 'en' ? 'Autonomous apply' : 'Aplicación autónoma',
    )
    await expectNoHorizontalOverflow(page)
    await capture(page, `semantic-outcome-case-workspace-${locale}`)

    await page.getByTestId(`semantic-recovery-diagnose-${fixture.caseId}`).click()
    await expect(page.getByTestId(`recovery-diagnosis-${fixture.caseId}`)).toBeVisible()
    await expect(
      page.getByTestId(`recovery-case-workspace-${fixture.caseId}`),
    ).toContainText(locale === 'en' ? 'Deterministic' : 'Determinista')
    await capture(page, `semantic-outcome-case-diagnosis-${locale}`)

    const output = page.getByTestId(`semantic-recovery-output-${fixture.caseId}`)
    const disclosure = output.locator('xpath=ancestor::details')
    if (!await output.isVisible()) await disclosure.locator('summary').click()
    await output.fill(
      JSON.stringify({
        mode: 'ai',
        approved: true,
        response: locale === 'en' ? 'Reviewed safe response' : 'Respuesta segura revisada',
      }, null, 2),
    )
    await page.getByLabel(
      locale === 'en' ? 'Operator rationale' : 'Justificación del operador',
    ).fill(copy.reason)
    const proposeButton = page.getByTestId(
      `semantic-recovery-propose-${fixture.caseId}`,
    )
    await proposeButton.scrollIntoViewIfNeeded()
    await capture(page, `semantic-outcome-case-decision-${locale}`)
    await proposeButton.click()

    const validateButton = page.getByTestId(
      `semantic-recovery-validate-${fixture.caseId}`,
    )
    await expect(validateButton).toBeVisible()
    await validateButton.click()
    const approveButton = page.getByTestId(
      `semantic-recovery-approve-${fixture.caseId}`,
    )
    await expect(approveButton).toBeVisible()
    await approveButton.click()
    const applyButton = page.getByTestId(
      `semantic-recovery-apply-${fixture.caseId}`,
    )
    await expect(applyButton).toBeVisible()
    await capture(page, `semantic-outcome-case-approved-${locale}`)
    await applyButton.click()
    await expect(
      page.getByTestId(`recovery-case-workspace-${fixture.caseId}`),
    ).toContainText(locale === 'en' ? 'Recovered' : 'Recuperado')
    await page.getByRole('button', { name: copy.backToRecovery }).click()
    await expect(page.getByTestId('home-priority-clear')).toBeVisible()
    await expect(page.getByRole('button', { name: copy.allClearAria })).toBeVisible()

    const activityDestination = locale === 'en' ? 'Activity' : 'Actividad'
    await openWorkspaceDestination(page, activityDestination)
    const activityRow = page.getByTestId(`activity-row-run:${fixture.runId}`)
    await expect(activityRow).toBeVisible()
    await expect(async () => {
      await page.getByTestId('activity-refresh').click()
      await expect(activityRow).toHaveAttribute('data-category', 'recovered', {
        timeout: 1_000,
      })
    }).toPass({ timeout: 30_000, intervals: [500, 1_000, 2_000] })

    await openWorkspaceSection(
      page,
      activityDestination,
      copy.runs,
    )
    const runRow = page.getByRole('article').filter({ hasText: fixture.workflowName }).first()
    await expect(runRow.locator('[data-outcome-status="semantic_recovered"]')).toHaveText(copy.recovered)
    await runRow.getByRole('button').first().click()
    await expect(runRow.locator('.status-pill[data-status="succeeded"]')).toBeVisible()
    await runRow.scrollIntoViewIfNeeded()
    await hideTransientOverlays(page)
    await capture(page, `semantic-outcome-recovered-${locale}`)
    await expect(runRow.locator('.status-pill[data-status="succeeded"]')).toBeVisible()

    expect(browserErrors).toEqual([])
  })
}

test('recommendation-only policy keeps replacement locked and accepted loss explicit', async ({ page }) => {
  test.skip(!enabled, 'requires the persistent local Docker stack')
  const fixture = await createFixture('en', {
    autonomyLevel: 1,
    orgSuffix: 'policy',
  })
  fixtures.set('en-level1', fixture)
  await persistEvidence()
  const browserErrors = guardBrowserErrors(page)

  await page.addInitScript(({ activeOrg }) => {
    window.localStorage.setItem('janusly:activeOrg', activeOrg)
    window.localStorage.setItem('janusly:locale', 'en')
    window.localStorage.setItem('janusly:recovery:hideIntro', 'true')
  }, { activeOrg: fixture.orgId })

  await page.goto('/')
  await page.getByTestId(
    `recovery-center-action-cta-recovery-case:${fixture.caseId}`,
  ).click()
  const workspace = page.getByTestId(
    `recovery-case-workspace-${fixture.caseId}`,
  )
  await expect(workspace).toBeVisible()
  const autonomy = page.getByTestId(
    `recovery-autonomy-profile-${fixture.caseId}`,
  )
  await expect(autonomy).toContainText('Level 1')
  await expect(autonomy).toContainText('Failure-specific override')
  await page.getByTestId(`semantic-recovery-diagnose-${fixture.caseId}`).click()
  await expect(page.getByTestId(`recovery-diagnosis-${fixture.caseId}`)).toBeVisible()
  await expect(workspace).toContainText(
    'This failure policy does not permit replacement',
  )
  await expect(
    page.getByTestId(`semantic-recovery-output-${fixture.caseId}`),
  ).toHaveCount(0)
  await expect(
    page.getByTestId(`semantic-recovery-propose-${fixture.caseId}`),
  ).toHaveCount(0)
  const acceptLoss = page.getByTestId(
    `semantic-recovery-accept-${fixture.caseId}`,
  )
  await expect(acceptLoss).toBeVisible()
  await acceptLoss.scrollIntoViewIfNeeded()
  await expectNoHorizontalOverflow(page)
  await capture(page, 'semantic-outcome-policy-blocked-en')
  await acceptLoss.click()
  await expect(page.getByTestId(`semantic-recovery-validate-${fixture.caseId}`)).toBeVisible()
  await expect(workspace.getByRole('radiogroup', { name: 'Recovery candidates' })).toBeVisible()
  expect(browserErrors).toEqual([])
})
