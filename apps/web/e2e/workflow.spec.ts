import { expect, test } from '@playwright/test'

test('dev session can create, save, run, and reopen a workflow', async ({ page }) => {
  const workflowName = `E2E Noop ${Date.now()}`

  await page.goto('/')
  await expect(page.getByText('dev-user')).toBeVisible()

  await page.getByRole('button', { name: 'New', exact: true }).click()
  await page.getByLabel('Name').fill(workflowName)
  await page.getByRole('button', { name: /^noop$/i }).click()

  await page.getByRole('button', { name: 'Validate', exact: true }).click()
  await expect(page.getByText('Workflow contract is valid')).toBeVisible()

  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText(/Saved version \d+/)).toBeVisible()

  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.getByText(/Run started:/)).toBeVisible()
  await expect(page.getByText(/NOOP \/ succeeded/)).toBeVisible({ timeout: 30_000 })

  await page.getByRole('button', { name: 'Workflows' }).click()
  await page.getByRole('button', { name: 'Refresh' }).click()
  await expect(page.getByText(workflowName)).toBeVisible()
})
