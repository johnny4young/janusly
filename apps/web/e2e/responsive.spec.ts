import { addCanvasStep, openWorkspaceSection } from './_helpers/workspace-navigation'
import { expect, test } from '@playwright/test'

test.use({ viewport: { width: 390, height: 844 } })

async function openMobileNavigation(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Navigation' }).click()
  await expect(page.locator('#workspace-sidebar')).toBeVisible()
}

test('mobile workspace remains usable without horizontal overflow', async ({ page }) => {
  await page.goto('/')

  await expect(page.locator('.we-recovery-center-hero')).toBeVisible()
  await openMobileNavigation(page)
  await expect(page.getByRole('button', { name: 'Home', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Workflows', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Activity', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible()

  await openWorkspaceSection(page, 'Activity', 'Runs')
  await expect(page.getByRole('heading', { name: 'Runs', exact: true })).toBeVisible()

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(2)
})

test('mobile node setup can be reached from the canvas', async ({ page }) => {
  await page.goto('/')

  await openMobileNavigation(page)
  await openWorkspaceSection(page, 'Workflows', 'Build')
  // Onboarding is contextual to Recovery Center, so it cannot obscure this
  // canvas or its setup panel after navigation.
  await expect(page.getByTestId('onboarding-banner')).toHaveCount(0)
  await addCanvasStep(page, 'Call an API')

  await expect(page.getByRole('heading', { name: 'Build', exact: true })).toBeVisible()
  await expect(page.getByLabel('Request URL')).toBeVisible()
})

test('narrow desktop keeps contextual navigation readable without overflow', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 })
  await page.goto('/')

  await openWorkspaceSection(page, 'Settings', 'Connections')
  const sectionNav = page.getByTestId('workspace-section-nav')
  await expect(sectionNav).toHaveAttribute('data-destination', 'settings')
  await expect(sectionNav.getByRole('button', {
    name: 'Connections',
    exact: true,
  })).toHaveAttribute('aria-current', 'page')

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(2)
})
