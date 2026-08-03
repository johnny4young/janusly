import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { expectNoBlockingAccessibilityViolations } from './_helpers/accessibility'
import { openWorkspaceSection } from './_helpers/workspace-navigation'

const enabled = process.env.JANUSLY_LOCAL_LOAD_SOAK_E2E === '1'
const evidenceDir = process.env.JANUSLY_EVIDENCE_DIR
const apiUrl = process.env.E2E_API_URL ?? 'http://127.0.0.1:7311'
const workflowName = process.env.JANUSLY_LOAD_WORKFLOW_NAME ?? 'Load soak workflow'
const expectedRuns = Number(process.env.JANUSLY_LOAD_EXPECTED_RUNS ?? '0')
const orgId = process.env.JANUSLY_LOCAL_ORG_ID ?? 'default'
const headers = {
  'x-org-id': orgId,
  'x-user-id': 'local-load-soak',
}

function guardBrowserErrors(page: Page) {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('response', (response) => {
    if (response.status() >= 400) {
      errors.push(`${response.status()} ${new URL(response.url()).pathname}`)
    }
  })
  return errors
}

async function capture(page: Page, name: string) {
  if (!evidenceDir) return
  await mkdir(evidenceDir, { recursive: true })
  await page.screenshot({
    path: `${evidenceDir}/${name}.png`,
    fullPage: true,
    animations: 'disabled',
    caret: 'hide',
  })
}

async function expectHealthySurface(page: Page, context: string) {
  await expectNoBlockingAccessibilityViolations(page, context)
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(2)
}

async function changeLocale(page: Page, locale: 'en' | 'es') {
  const trigger = page.locator('.user-menu__trigger')
  await trigger.click()
  await page
    .getByLabel(/^(Change language|Cambiar idioma)$/)
    .selectOption(locale)
  await expect(page.locator('html')).toHaveAttribute('lang', locale)
  await trigger.click()
  await expect(page.locator('.user-menu__popover')).toBeHidden()
}

test('drained load remains observable and usable in English and Spanish', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000)
  test.skip(!enabled, 'requires the local load/soak qualification profile')
  expect(expectedRuns).toBeGreaterThan(0)
  const browserErrors = guardBrowserErrors(page)

  const queueResponse = await request.get(`${apiUrl}/system/queue`, { headers })
  expect(queueResponse.ok()).toBe(true)
  const queue = await queueResponse.json() as {
    waiting: number
    active: number
    maintenance: { waiting: number; active: number } | null
  }
  expect(queue).toMatchObject({
    waiting: 0,
    active: 0,
    maintenance: { waiting: 0, active: 0 },
  })

  const runsResponse = await request.get(`${apiUrl}/runs?limit=200`, { headers })
  expect(runsResponse.ok()).toBe(true)
  const runs = await runsResponse.json() as Array<{
    status: string
    workflowName?: string
  }>
  expect(runs.length).toBeGreaterThan(0)
  expect(runs.length).toBeLessThanOrEqual(expectedRuns)
  expect(runs.every(({ status }) => status === 'succeeded')).toBe(true)

  await page.addInitScript(({ activeOrg }) => {
    window.localStorage.setItem('janusly:activeOrg', activeOrg)
    window.localStorage.setItem('janusly:locale', 'en')
    window.localStorage.setItem('janusly:recovery:hideIntro', 'true')
  }, { activeOrg: orgId })
  await page.goto('/')
  await openWorkspaceSection(page, 'Activity', 'Runs')
  await expect(page.getByTestId('activity-run-history')).toBeVisible()
  const history = page.getByTestId('runs-history-virtual-list')
  await expect(history.getByText(workflowName).first()).toBeVisible()
  await expect(history.locator('[data-status="succeeded"]').first()).toBeVisible()
  await expectHealthySurface(page, 'English activity after local load')
  await capture(page, 'load-soak-activity-en')

  await changeLocale(page, 'es')
  await openWorkspaceSection(page, 'Configuración', 'Espacio de trabajo')
  await page.getByTestId('operations-rail-tab-infrastructure').click()
  await expect(page.getByTestId('queue-lag-chip')).toHaveAttribute('data-state', 'clear')
  await expect(page.getByTestId('maintenance-queue-lag-chip')).toHaveAttribute(
    'data-state',
    'clear',
  )
  await expectHealthySurface(page, 'Spanish infrastructure after queue drain')
  await capture(page, 'load-soak-infrastructure-es')

  await page.setViewportSize({ width: 390, height: 844 })
  const infrastructure = page.locator('.we-infrastructure-card')
  await expect(infrastructure).toBeVisible()
  expect(
    await infrastructure.evaluate((element) =>
      element.scrollWidth <= element.clientWidth + 1),
  ).toBe(true)
  await expectHealthySurface(page, 'compact Spanish infrastructure after queue drain')
  await capture(page, 'load-soak-infrastructure-es-mobile')

  expect(browserErrors).toEqual([])
})
