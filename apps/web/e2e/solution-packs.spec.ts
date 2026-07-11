import { expect, test, type Page } from '@playwright/test'

function installConsoleErrorGuards(page: Page) {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

test('Solution Packs install, sample-run, and failure injection flows work from the UI', async ({ page }) => {
  const browserErrors = installConsoleErrorGuards(page)

  await page.goto('/')
  await expect(page.getByText('dev-user')).toBeVisible()

  await page.getByRole('button', { name: 'Packs', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Solution Packs', exact: true })).toBeVisible()

  const incidentPack = page.locator('.list-card').filter({ hasText: 'Incident triage' }).first()
  await expect(incidentPack).toBeVisible()
  await expect(incidentPack.getByLabel('ops_github missing (github_token)')).toBeVisible()
  await expect(incidentPack.getByLabel('ops_slack missing (slack_webhook)')).toBeVisible()

  await incidentPack.getByRole('button', { name: 'Install', exact: true }).click()
  await expect(page.getByText(/Pack installed/)).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Step setup', exact: true })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Name' })).toHaveValue('Incident triage')
  await expect(page.locator('.workflow-node').filter({ hasText: 'Run a tool' })).toHaveCount(2)

  await page.getByRole('button', { name: 'Packs', exact: true }).click()
  await incidentPack.getByRole('button', { name: 'Preview sample run', exact: true }).click()
  await expect(page.getByText('Sample run started in the sandbox.')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Runs', exact: true })).toBeVisible()
  await expect(page.getByText(/Status: (running|succeeded|failed|waiting)/)).toBeVisible({ timeout: 30_000 })

  await page.getByRole('button', { name: 'Packs', exact: true }).click()
  await incidentPack.getByRole('button', { name: 'Break a node', exact: true }).click()
  await expect(page.getByText('Demo failure injected')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Runs', exact: true })).toBeVisible()
  const focusedFailure = page.locator('[data-testid^="dlq-row-"][data-selected="true"]').filter({ hasText: 'page_oncall' }).first()
  await expect(focusedFailure).toBeVisible({ timeout: 30_000 })
  await expect(focusedFailure).toBeFocused()
  const targetInMainViewport = await focusedFailure.evaluate((node) => {
    const main = node.closest('.workspace-main')
    if (!main) return false
    const target = node.getBoundingClientRect()
    const viewport = main.getBoundingClientRect()
    return target.top >= viewport.top - 2 && target.bottom <= viewport.bottom + 2
  })
  expect(targetInMainViewport).toBe(true)

  expect(browserErrors).toEqual([])
})

test('Solution Packs remains usable on mobile without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  await page.getByRole('button', { name: 'Navigation' }).click()
  await page.locator('#workspace-sidebar').getByRole('button', { name: 'Packs', exact: true }).click()

  await expect(page.getByRole('heading', { name: 'Solution Packs', exact: true })).toBeVisible()
  await expect(page.locator('.list-card').filter({ hasText: 'Support escalation' })).toBeVisible()

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(2)
})
