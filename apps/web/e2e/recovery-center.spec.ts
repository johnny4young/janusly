import { expect, test } from '@playwright/test'

test('Recovery Center is the authenticated desktop home', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')

  await expect(page.locator('.we-recovery-center-hero .section-kicker', { hasText: 'Recovery Center' })).toBeVisible()
  await expect(page.getByTestId('recovery-center-metric-failures')).toBeVisible()
  await expect(page.getByTestId('recovery-center-metric-mttr')).toBeVisible()
  await expect(page.getByRole('button', { name: /^AI Studio\b/ })).toBeVisible()

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(2)
})

test('Recovery Center remains usable on mobile and the builder is one tap away', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')

  await expect(page.locator('.we-recovery-center-hero .section-kicker', { hasText: 'Recovery Center' })).toBeVisible()
  await page.getByRole('button', { name: /^AI Studio\b/ }).click()
  await expect(page.locator('.workspace-main .workflow-node').first()).toBeVisible()

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(2)
})
