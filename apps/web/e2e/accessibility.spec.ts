import { openWorkspaceSection } from './_helpers/workspace-navigation'
/**
 * Automated accessibility floor for the highest-value operator journeys.
 *
 * The suite runs against the real E2E stack and scans settled UI states with
 * axe-core. Serious and critical violations fail with rule, selector, and
 * remediation details; keyboard/focus behavior remains covered by the focused
 * Playwright specs that exercise each interaction.
 */

import { mkdir } from 'node:fs/promises'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page } from '@playwright/test'

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']
const BLOCKING_IMPACTS = new Set(['serious', 'critical'])
const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR

type BlockingViolation = {
  context: string
  impact: string
  rule: string
  help: string
  nodes: Array<{
    target: string[]
    summary: string
  }>
}

async function expectNoBlockingAccessibilityViolations(page: Page, context: string): Promise<void> {
  await page.locator('html').evaluate((root) => {
    for (const animation of root.getAnimations({ subtree: true })) {
      const endTime = animation.effect?.getComputedTiming().endTime
      if (typeof endTime === 'number' && Number.isFinite(endTime)) animation.finish()
    }
  })

  const results = await new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    .analyze()

  const violations: BlockingViolation[] = results.violations
    .filter((violation) => violation.impact && BLOCKING_IMPACTS.has(violation.impact))
    .map((violation) => ({
      context,
      impact: violation.impact ?? 'unknown',
      rule: violation.id,
      help: violation.help,
      nodes: violation.nodes.map((node) => ({
        target: node.target.map(String),
        summary: node.failureSummary ?? node.html,
      })),
    }))

  expect(violations, `${context} must have no serious or critical axe violations`).toEqual([])
}

function installBrowserErrorGuards(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  return errors
}

async function capture(surface: Locator, filename: string): Promise<void> {
  await expect(surface).toBeVisible()
  if (!EVIDENCE_DIR) return
  await mkdir(EVIDENCE_DIR, { recursive: true })
  await surface.screenshot({
    path: `${EVIDENCE_DIR}/${filename}.png`,
    animations: 'disabled',
    caret: 'hide',
  })
}

test('Recovery Center and its primary queue path meet the accessibility floor', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = installBrowserErrorGuards(page)
  await page.goto('/')

  const hero = page.locator('.we-recovery-center-hero')
  await expect(hero).toBeVisible()
  await expectNoBlockingAccessibilityViolations(page, 'Recovery Center home')
  await capture(page.locator('.workspace-main'), 'accessibility-en-recovery-center')

  await page.getByTestId('recovery-center-queue-open-all').click()
  const queue = page.getByTestId('recovery-queue')
  await expect(queue).toBeFocused()
  await expectNoBlockingAccessibilityViolations(page, 'Recovery queue')
  await capture(queue, 'accessibility-en-recovery-queue')
  expect(errors).toEqual([])
})

test('workflow builder and command palette meet the accessibility floor', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = installBrowserErrorGuards(page)
  await page.goto('/')

  await openWorkspaceSection(page, 'Workflows', 'Build')
  const studio = page.locator('.workspace-main')
  await expect(studio.locator('.react-flow')).toBeVisible()
  await expectNoBlockingAccessibilityViolations(page, 'Workflow builder')
  await capture(studio, 'accessibility-en-ai-studio')

  await page.keyboard.press('ControlOrMeta+K')
  const palette = page.getByTestId('command-palette')
  await expect(palette).toBeVisible()
  await expectNoBlockingAccessibilityViolations(page, 'Command palette')
  await capture(palette, 'accessibility-en-command-palette')
  expect(errors).toEqual([])
})

test('Solution Packs recovery-drill selection meets the accessibility floor', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = installBrowserErrorGuards(page)
  await page.goto('/')

  await openWorkspaceSection(page, 'Workflows', 'Templates')
  const pack = page.getByTestId('solution-pack-incident-triage')
  await expect(pack).toBeVisible()
  await pack.getByLabel('Failure scenario').selectOption('worker_interrupted_during_page')
  await expect(pack.getByText('Real reaper path')).toBeVisible()

  await expectNoBlockingAccessibilityViolations(page, 'Solution Packs recovery drill')
  await capture(pack, 'accessibility-en-solution-pack-drill')
  expect(errors).toEqual([])
})

test('mobile navigation meets the accessibility floor while open', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const errors = installBrowserErrorGuards(page)
  await page.goto('/')

  const navTrigger = page.getByRole('button', { name: 'Navigation' })
  await navTrigger.click()
  await expect(page.locator('#workspace-sidebar')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Close navigation' })).toBeFocused()
  await expectNoBlockingAccessibilityViolations(page, 'Mobile navigation')
  await capture(page.locator('.app-shell'), 'accessibility-en-mobile-navigation')
  expect(errors).toEqual([])
})

test('Spanish dark-mode Recovery Center and command palette meet the accessibility floor', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = installBrowserErrorGuards(page)
  await page.addInitScript(() => {
    window.localStorage.setItem('janusly:locale', 'es')
    window.localStorage.setItem('janusly:theme', 'dark')
  })
  await page.goto('/')

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  const hero = page.locator('.we-recovery-center-hero')
  await expect(hero).toBeVisible()
  await expectNoBlockingAccessibilityViolations(page, 'Spanish dark-mode Recovery Center')
  await capture(page.locator('.workspace-main'), 'accessibility-es-dark-recovery-center')

  await page.keyboard.press('ControlOrMeta+K')
  const palette = page.getByTestId('command-palette')
  await expect(palette).toBeVisible()
  await expectNoBlockingAccessibilityViolations(page, 'Spanish dark-mode command palette')
  await capture(palette, 'accessibility-es-dark-command-palette')
  expect(errors).toEqual([])
})
