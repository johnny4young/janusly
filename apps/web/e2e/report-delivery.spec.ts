import { addCanvasStep, openWorkspaceSection } from './_helpers/workspace-navigation'
import { expect, test } from '@playwright/test'

test.use({ viewport: { width: 1440, height: 900 } })

test('run history opens report delivery dialog and surfaces a credential error', async ({ page }) => {
  const workflowName = `E2E Report Delivery ${Date.now()}`

  await page.goto('/')
  await expect(page.getByText('dev-user')).toBeVisible()
  await expect(page.locator('.we-home-header .section-kicker', { hasText: 'Home' })).toBeVisible()

  await page.getByRole('button', { name: 'Workflows', exact: true }).click()
  await page.getByRole('button', { name: 'New workflow', exact: true }).click()
  await page.getByRole('button', { name: /^Start blank\b/ }).click()
  await page.getByRole('textbox', { name: 'Name' }).fill(workflowName)
  await addCanvasStep(page, 'Do nothing')
  await expect(page.locator('.workflow-node').filter({ hasText: 'Do nothing' })).toBeVisible()

  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.getByText(/Run started:/)).toBeVisible()
  await openWorkspaceSection(page, 'Workflows', 'Build')
  await expect(page.locator('.workflow-node').filter({ hasText: 'Do nothing' }).filter({ hasText: 'Done' })).toBeVisible({ timeout: 30_000 })

  await openWorkspaceSection(page, 'Activity', 'Runs')
  const history = page.getByTestId('runs-history-virtual-list')
  const runRow = history.getByRole('article').filter({ hasText: workflowName }).first()
  await expect(runRow).toBeVisible({ timeout: 30_000 })
  await runRow.locator('button.list-card-row').click()
  await expect(page.getByTestId('run-overview')).toBeVisible()
  const sendButton = page.getByRole('button', { name: /Send run explain report for/ }).first()
  await expect(sendButton).toBeVisible({ timeout: 30_000 })
  await sendButton.click()

  await expect(page.getByRole('dialog', { name: 'Send run report' })).toBeVisible()
  await expect(page.getByText('Source run')).toBeVisible()
  await expect(page.getByTestId('report-delivery-submit')).toBeDisabled()

  await page.getByTestId('report-delivery-credential').fill('missing-smoke-credential')
  await expect(page.getByTestId('report-delivery-submit')).toBeEnabled()
  await page.getByTestId('report-delivery-submit').click()

  await expect(page.getByRole('alert')).toContainText('credential not found: missing-smoke-credential')
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(2)
})
