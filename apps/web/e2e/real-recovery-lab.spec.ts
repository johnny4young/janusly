import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

const enabled = process.env.JANUSLY_REAL_RECOVERY_LAB_E2E === '1'
const evidenceDir = process.env.JANUSLY_EVIDENCE_DIR
const orgId = process.env.JANUSLY_RECOVERY_LAB_ORG_ID ?? 'local-recovery-lab'

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
  test(`real recovery lab exposes provider evidence in ${locale}`, async ({ page }) => {
    test.skip(!enabled, 'requires a completed persistent local recovery lab')
    const browserErrors = guardBrowserErrors(page)
    await prepare(page, locale)
    await page.goto('/')

    const runsLabel = locale === 'en' ? 'Runs' : 'Ejecuciones'
    const evidenceLabel = locale === 'en' ? 'Provider simulated' : 'Proveedor simulado'
    const receiptLabel = locale === 'en'
      ? 'Provider simulation receipt recorded'
      : 'Recibo de simulación del proveedor registrado'
    await page.getByRole('button', { name: runsLabel, exact: true }).click()
    await expect(page.getByRole('heading', { name: runsLabel, exact: true })).toBeVisible()

    const validationRow = page.getByRole('article').filter({ hasText: evidenceLabel }).first()
    await expect(validationRow).toBeVisible()
    await expect(validationRow.getByText(evidenceLabel, { exact: true })).toBeVisible()
    await validationRow.scrollIntoViewIfNeeded()
    await capture(page, `real-recovery-lab-runs-${locale}`)

    await validationRow.locator('button.list-card-row').click()
    await expect(page.getByTestId('active-run-validation-evidence'))
      .toHaveText(evidenceLabel)
    await page.getByTestId('run-workspace-tab-timeline').click()
    await page.getByTestId('run-event-filter').fill('provider_simulation_receipt')
    const receiptRow = page.getByRole('listitem').filter({ hasText: receiptLabel })
    await expect(receiptRow).toContainText('provider_simulation_receipt')
    await receiptRow.scrollIntoViewIfNeeded()
    await capture(page, `real-recovery-lab-receipt-${locale}`)

    expect(browserErrors).toEqual([])
  })
}
