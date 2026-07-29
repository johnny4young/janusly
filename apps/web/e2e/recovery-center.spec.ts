import { expect, test } from '@playwright/test'
import { openWorkspaceSection } from './_helpers/workspace-navigation'

test('Recovery Center is the authenticated desktop home', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')

  await expect(page.locator('.we-recovery-center-hero .section-kicker', { hasText: 'Recovery Center' })).toBeVisible()
  await expect(page.getByTestId('recovery-center-metric-failures')).toBeVisible()
  await expect(page.getByTestId('recovery-center-metric-verified-recovery')).toBeVisible()

  await page.getByTestId('recovery-center-queue-open-all').click()
  const queue = page.getByTestId('recovery-queue')
  await expect(queue).toBeFocused()
  const queueLandedInMain = await queue.evaluate((node) => {
    const main = node.closest('.workspace-main')
    if (!main) return false
    const target = node.getBoundingClientRect()
    const viewport = main.getBoundingClientRect()
    return target.top >= viewport.top - 2 && target.top < viewport.bottom - 2
  })
  expect(queueLandedInMain).toBe(true)

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(2)
})

test('Recovery Center exposes calibration health without blocking an empty workspace', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/')

  const calibration = page.getByTestId('recovery-center-tile-calibration')
  await expect(calibration).toBeVisible()
  await expect(calibration.getByRole('heading', { name: 'Model calibration' })).toBeVisible()
  await expect(calibration).toContainText(/No curve is ready yet|raw confidence/i)
  const box = await calibration.boundingBox()
  expect(box?.height ?? 0).toBeGreaterThan(0)
})

test('Recovery Center remains usable on mobile and the builder is one tap away', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')

  const hero = page.locator('.we-recovery-center-hero')
  await expect(hero.locator('.section-kicker', { hasText: 'Recovery Center' })).toBeVisible()
  const heroBox = await hero.boundingBox()
  expect(heroBox?.y ?? 9999).toBeLessThan(844)

  const drawer = page.locator('#workspace-sidebar')
  await expect(drawer).toBeHidden()
  const navTrigger = page.getByRole('button', { name: 'Navigation' })
  await navTrigger.click()
  await expect(drawer).toBeVisible()
  await expect(page.getByRole('button', { name: 'Close navigation' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()
  await expect(navTrigger).toBeFocused()

  await openWorkspaceSection(page, 'Workflows', 'Build')
  await expect(drawer).toBeHidden()
  await expect(page.getByTestId('canvas-empty')).toBeVisible()
  await expect(page.locator('.workspace-main .workflow-node')).toHaveCount(0)

  const overflow = await page.locator('.workspace-main').evaluate((main) => main.scrollWidth - main.clientWidth)
  expect(overflow).toBeLessThanOrEqual(2)
})
