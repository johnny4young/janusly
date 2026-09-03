/**
 * Automated accessibility floor for the highest-value operator journeys.
 *
 * The suite runs against the real E2E stack and scans settled UI states with
 * axe-core. Serious and critical violations fail with rule, selector, and
 * remediation details; keyboard/focus behavior remains covered by the focused
 * Playwright specs that exercise each interaction.
 */

import { mkdir } from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'

import { expectNoBlockingAccessibilityViolations } from './_helpers/accessibility'
import {
  addCanvasStep,
  openWorkflowAiAction,
  openWorkspaceSection,
} from './_helpers/workspace-navigation'
import {
  applyBuiltWorkflowProposal,
  buildWorkflowProposal,
  mockWorkflowProposal,
} from './_helpers/workflow-authoring'

const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR

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

async function prepareIsolatedSession(page: Page, locale: 'en' | 'es'): Promise<void> {
  const orgId = `accessibility-${locale}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await page.addInitScript(({ activeOrg, selectedLocale }) => {
    window.localStorage.setItem('janusly:activeOrg', activeOrg)
    window.localStorage.setItem('janusly:locale', selectedLocale)
  }, { activeOrg: orgId, selectedLocale: locale })
}

test('Home and its primary Activity path meet the accessibility floor', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = installBrowserErrorGuards(page)
  await prepareIsolatedSession(page, 'en')
  await page.goto('/')

  const hero = page.locator('.we-recovery-center-hero')
  await expect(hero).toBeVisible()
  await expectNoBlockingAccessibilityViolations(page, 'Home')
  await capture(page.locator('.workspace-main'), 'accessibility-en-home')

  await page.getByTestId('home-active-work').getByRole('button', { name: 'Activity' }).click()
  await expect(page.getByRole('heading', { name: 'Activity', exact: true })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Recent activity' })).toBeVisible()
  await expectNoBlockingAccessibilityViolations(page, 'Activity')
  await capture(page.locator('.workspace-main'), 'accessibility-en-activity')
  expect(errors).toEqual([])
})

test('workflow builder and command palette meet the accessibility floor', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = installBrowserErrorGuards(page)
  await page.goto('/')

  await openWorkspaceSection(page, 'Workflows', 'Build')
  const studio = page.locator('.workspace-main')
  await expect(studio.locator('.react-flow')).toBeVisible()
  await addCanvasStep(page, 'Call an API')
  await page.getByLabel('HTTP method', { exact: true }).selectOption('POST')
  await page.getByText('Request & response options', { exact: true }).click()
  await expect(page.getByLabel('JSON body', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Headers (JSON)', { exact: true })).toBeVisible()
  await expectNoBlockingAccessibilityViolations(page, 'Workflow HTTP setup')
  await capture(studio, 'accessibility-en-http-step-setup')

  await page.keyboard.press('ControlOrMeta+K')
  const palette = page.getByTestId('command-palette')
  await expect(palette).toBeVisible()
  await expectNoBlockingAccessibilityViolations(page, 'Command palette')
  await capture(palette, 'accessibility-en-command-palette')
  expect(errors).toEqual([])
})

test('AI-generated workflow result meets the accessibility floor', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = installBrowserErrorGuards(page)
  await prepareIsolatedSession(page, 'en')
  await mockWorkflowProposal(page, {
    dslVersion: '1.0',
    id: 'accessible-generated-flow',
    name: 'Accessible approval flow',
    nodes: [
      {
        id: 'fetch',
        type: 'http',
        config: { method: 'GET', url: 'https://api.github.com' },
      },
      {
        id: 'approval',
        type: 'approval',
        config: { message: 'Review the API result.' },
      },
    ],
    edges: [{ from: 'fetch', to: 'approval' }],
  }, { mode: 'ai' })
  await page.goto('/')

  await openWorkflowAiAction(page, 'Workflows')
  await page.locator('.ai-studio-prompt').fill('Draft an API flow with human approval.')
  const proposal = await buildWorkflowProposal(page)
  await expect(proposal.getByTestId('workflow-assurance-summary').locator('.mode-pill-ai')).toHaveCount(3)
  await applyBuiltWorkflowProposal(page)
  await expect(page.locator('.workflow-node').filter({ hasText: 'Ask approval' })).toBeVisible()
  await expectNoBlockingAccessibilityViolations(page, 'AI-generated workflow result')
  await capture(page.locator('.app-shell'), 'accessibility-en-ai-generated-result')
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
  await prepareIsolatedSession(page, 'es')
  await page.addInitScript(() => {
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
