import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

const enabled = process.env.JANUSLY_LOCAL_STACK_E2E === '1'
const evidenceDir = process.env.JANUSLY_EVIDENCE_DIR

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

async function screenshot(page: Page, name: string) {
  if (!evidenceDir) return
  await mkdir(evidenceDir, { recursive: true })
  await page.screenshot({ path: `${evidenceDir}/${name}.png`, fullPage: true })
}

test('persistent local stack exposes configured packs and recoverable provider failures', async ({ page }) => {
  test.skip(!enabled, 'requires the persistent local Docker stack')
  const browserErrors = guardBrowserErrors(page)
  await page.addInitScript(() => {
    window.localStorage.setItem('janusly:activeOrg', 'default')
    window.localStorage.setItem('janusly:locale', 'en')
  })

  await page.goto('/')
  await expect(page.getByText('dev-user')).toBeVisible()
  await expect(page.locator('.top-bar-breadcrumb')).toContainText('Sample workflow')
  await expect(page.locator('.top-bar-breadcrumb')).not.toContainText('undefined')
  await page.getByRole('button', { name: 'Packs', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Solution Packs', exact: true })).toBeVisible()

  const incidentPack = page.locator('.list-card').filter({ hasText: 'Incident triage' }).first()
  await expect(incidentPack.getByLabel('ops_github configured (github_token)')).toBeVisible()
  await expect(incidentPack.getByLabel('ops_slack configured (slack_webhook)')).toBeVisible()
  await screenshot(page, 'local-stack-packs-configured')

  const recoverButton = page.locator('.top-bar-cta')
  await expect(recoverButton).toBeVisible()
  await expect(recoverButton).toContainText('Recover')
  await recoverButton.click()
  const recoveryQueue = page.getByTestId('recovery-queue')
  await expect(recoveryQueue).toBeVisible()
  await expect(recoveryQueue).toContainText('page')
  await screenshot(page, 'local-stack-provider-failure-recovery')

  expect(browserErrors).toEqual([])
})
