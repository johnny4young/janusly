import { expect, test } from '@playwright/test'

test('dev session can create, save, run, and reopen a workflow', async ({ page }) => {
  const workflowName = `E2E Noop ${Date.now()}`

  await page.goto('/')
  await expect(page.getByText('dev-user')).toBeVisible()

  await page.getByRole('button', { name: 'New', exact: true }).click()
  await page.getByLabel('Name').fill(workflowName)
  await page.getByRole('button', { name: /Do nothing/i }).click()

  await page.getByRole('button', { name: 'Validate', exact: true }).click()
  await expect(page.getByText('Flow is ready to run')).toBeVisible()

  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText(/Saved version \d+/)).toBeVisible()

  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.getByText(/Run started:/)).toBeVisible()
  await expect(page.locator('.workflow-node').filter({ hasText: 'Do nothing' }).filter({ hasText: 'Done' })).toBeVisible({ timeout: 30_000 })

  await page.getByRole('button', { name: 'Flows' }).click()
  await page.getByRole('button', { name: 'Refresh' }).click()
  await expect(page.getByText(workflowName, { exact: true })).toBeVisible()
})

test('human form pauses a run, validates input, and resumes with submitted output', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('dev-user')).toBeVisible()

  await page.getByRole('button', { name: 'New', exact: true }).click()
  await page.getByLabel('Name').fill(`E2E Human Form ${Date.now()}`)
  await page.getByRole('button', { name: /Collect form/i }).click()

  await page.getByRole('button', { name: 'Validate', exact: true }).click()
  await expect(page.getByText('Flow is ready to run')).toBeVisible()

  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.getByText(/Run started:/)).toBeVisible()
  await page.getByRole('button', { name: 'Runs', exact: true }).click()
  await expect(page.getByRole('button', { name: /Fill form/i })).toBeVisible({ timeout: 30_000 })

  await page.getByRole('button', { name: /Fill form/i }).click()
  await expect(page.getByRole('heading', { name: 'Collect request details' })).toBeVisible()
  await page.getByLabel('requester').fill('Ada')
  await page.getByLabel('reason').fill('PTO request')
  await page.getByRole('button', { name: /Submit form/i }).click()

  await expect(page.getByText(/Form .* submitted/)).toBeVisible()
  await expect(page.locator('.workflow-node').filter({ hasText: 'Done' })).toBeVisible({ timeout: 30_000 })
})
