import { expect, test } from '@playwright/test'

test('unconfigured documentation capability exposes no dead controls', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByTestId('status-bar-docs')).toHaveCount(0)

  await page.getByRole('button', { name: 'Open user menu' }).click()
  await expect(page.getByRole('link', { name: 'Docs & changelog' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Close menu' }).click()

  await page.getByRole('button', { name: /command palette/i }).click()
  const palette = page.getByTestId('command-palette')
  await expect(palette).toBeVisible()
  await palette.locator('input').fill('documentation')
  await expect(palette.getByText('Open documentation')).toHaveCount(0)
})
