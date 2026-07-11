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
  await expect(page.getByRole('button', { name: /^AI Studio\b/ })).toBeVisible()
  // Connections (Credentials) now lives under the Run group, which is
  // default-open — no explicit group toggle needed.
  await expect(page.getByRole('button', { name: /^Connections\b/ })).toBeVisible()

  await page.getByRole('button', { name: 'Runs', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Runs', exact: true })).toBeVisible()

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(2)
})

test('mobile node setup can be reached from the canvas', async ({ page }) => {
  await page.goto('/')

  await openMobileNavigation(page)
  await page.getByRole('button', { name: /^AI Studio\b/ }).click()
  // The onboarding coach is unrelated to this canvas/panel geometry smoke.
  // Hide it so the test proves the changed surface rather than fighting a
  // fixed overlay that has its own dedicated coverage.
  await page.getByTestId('onboarding-banner').evaluateAll((nodes) => {
    for (const node of nodes) node.style.display = 'none'
  })
  await page.locator('.workflow-node').filter({ hasText: 'Call an API' }).click()

  await expect(page.getByRole('heading', { name: 'Step setup', exact: true })).toBeVisible()
  await expect(page.getByLabel('Request URL')).toBeVisible()
})
