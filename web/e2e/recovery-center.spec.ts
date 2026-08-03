import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { openWorkspaceSection } from './_helpers/workspace-navigation'

const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR

async function captureWorkspace(page: Page, filename: string): Promise<void> {
  const workspace = page.locator('.workspace-main')
  await expect(workspace).toBeVisible()
  if (!EVIDENCE_DIR) return
  await mkdir(EVIDENCE_DIR, { recursive: true })
  await workspace.screenshot({
    path: `${EVIDENCE_DIR}/${filename}.png`,
    animations: 'disabled',
    caret: 'hide',
  })
}

async function prepareEmptySession(page: Page): Promise<void> {
  const orgId = `home-layout-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await page.addInitScript((activeOrg) => {
    window.localStorage.setItem('janusly:activeOrg', activeOrg)
    window.localStorage.setItem('janusly:locale', 'en')
  }, orgId)
}

test('Home leads with priorities and active work', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await prepareEmptySession(page)
  await page.goto('/')

  await expect(page.locator('.we-home-header .section-kicker', { hasText: 'Home' })).toBeVisible()
  await expect(page.getByTestId('home-health-summary')).toBeVisible()
  await expect(page.getByTestId('home-priority-inbox')).toBeVisible()
  await expect(page.getByTestId('home-active-work')).toBeVisible()
  await expect(page.getByTestId('recovery-center-metric-strip')).toBeHidden()
  await captureWorkspace(page, 'web-en-home-caught-up')

  await page.getByTestId('home-active-work').getByRole('button', { name: 'Activity' }).click()
  await expect(page.getByRole('heading', { name: 'Activity', exact: true })).toBeVisible()

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(2)
})

test('Recovery Center exposes calibration health without blocking an empty workspace', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await prepareEmptySession(page)
  await page.goto('/')

  await page.getByTestId('home-insights-toggle').click()
  const calibration = page.getByTestId('recovery-center-tile-calibration')
  await expect(calibration).toBeVisible()
  await expect(calibration.getByRole('heading', { name: 'Model calibration' })).toBeVisible()
  await expect(calibration).toContainText(/No curve is ready yet|raw confidence/i)
  const box = await calibration.boundingBox()
  expect(box?.height ?? 0).toBeGreaterThan(0)
})

test('Recovery Center remains usable on mobile and the builder is one tap away', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await prepareEmptySession(page)
  await page.goto('/')

  const hero = page.locator('.we-recovery-center-hero')
  await expect(hero.locator('.section-kicker', { hasText: 'Home' })).toBeVisible()
  await expect(page.getByTestId('home-priority-inbox')).toBeVisible()
  await expect(page.getByTestId('home-active-work')).toBeVisible()
  const heroBox = await hero.boundingBox()
  expect(heroBox?.y ?? 9999).toBeLessThan(844)
  await captureWorkspace(page, 'web-en-home-mobile')

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
