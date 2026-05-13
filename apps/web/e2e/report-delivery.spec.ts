import { expect, test } from '@playwright/test'

test.use({ viewport: { width: 1440, height: 900 } })

test('run history opens report delivery dialog and surfaces a credential error', async ({ page }) => {
  const workflowName = `E2E Report Delivery ${Date.now()}`

  await page.goto('/')
  await expect(page.getByText('dev-user')).toBeVisible()
  await expect(page.locator('.workspace-main .workflow-node').first()).toBeVisible()

  await page.getByRole('button', { name: 'New', exact: true }).click()
  await page.getByLabel('Name').fill(workflowName)
  await page.getByRole('button', { name: /Do nothing/i }).click()

  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.getByText(/Run started:/)).toBeVisible()
  await expect(page.locator('.workflow-node').filter({ hasText: 'Do nothing' }).filter({ hasText: 'Done' })).toBeVisible({ timeout: 30_000 })

  await page.getByRole('button', { name: 'Runs', exact: true }).click()
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
