import { expect, test } from '@playwright/test'

test.use({ viewport: { width: 390, height: 844 } })

test('mobile workspace remains usable without horizontal overflow', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByRole('button', { name: /^AI Studio\b/ })).toBeVisible()
  const workspaceGroup = page.getByRole('button', { name: /^Workspace\b/ })
  if (await workspaceGroup.getAttribute('aria-expanded') !== 'true') await workspaceGroup.click()
  await expect(page.getByRole('button', { name: /^Connections\b/ })).toBeVisible()

  await page.getByRole('button', { name: 'Runs', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Runs', exact: true })).toBeVisible()

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(2)
})

test('mobile node setup can be reached from the canvas', async ({ page }) => {
  await page.goto('/')

  await page.getByRole('button', { name: /^AI Studio\b/ }).click()
  await page.locator('.workflow-node').filter({ hasText: 'Call an API' }).click()

  await expect(page.getByRole('heading', { name: 'Step setup', exact: true })).toBeVisible()
  await expect(page.getByLabel('Request URL')).toBeVisible()
})
