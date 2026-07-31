import {
  openRecoveryAutomation,
  openWorkspaceSection,
} from './_helpers/workspace-navigation'
/**
 * Real-stack proof for paced replay campaigns: genuine failed runs form one
 * server-verified cohort, the operator creates a durable campaign in English,
 * observes paced progress, then stops it from the Spanish mobile surface.
 */

import { mkdir } from 'node:fs/promises'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'

import {
  findDeadLetterForRun,
  loadTemplate,
  pollUntilTerminal,
  pollUntilWaitingOrTerminal,
  resumeWebhook,
  startRun,
} from './_helpers/demo-helpers'

type WorkflowJson = Record<string, unknown>
const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR
const FAILURE_NODE_ID = 'campaign-payment-charge'
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

function scopeFailureNode(workflow: WorkflowJson): WorkflowJson {
  const scoped = structuredClone(workflow)
  if (Array.isArray(scoped.nodes)) {
    for (const node of scoped.nodes) {
      if (!node || typeof node !== 'object') continue
      const record = node as Record<string, unknown>
      if (record.id === 'charge') record.id = FAILURE_NODE_ID
    }
  }
  if (Array.isArray(scoped.edges)) {
    for (const edge of scoped.edges) {
      if (!edge || typeof edge !== 'object') continue
      const record = edge as Record<string, unknown>
      if (record.from === 'charge') record.from = FAILURE_NODE_ID
      if (record.to === 'charge') record.to = FAILURE_NODE_ID
      if (record.source === 'charge') record.source = FAILURE_NODE_ID
      if (record.target === 'charge') record.target = FAILURE_NODE_ID
    }
  }
  return scoped
}

async function createFailedRecovery(
  request: APIRequestContext,
  workflow: WorkflowJson,
  sequence: number,
): Promise<string> {
  const payload = { customer: `campaign-${sequence}@example.com`, amountUsd: 100 + sequence }
  const { runId } = await startRun(request, workflow, payload)
  await pollUntilWaitingOrTerminal(request, runId, 'trigger')
  await resumeWebhook(request, runId, 'trigger', payload)
  const failed = await pollUntilTerminal(request, runId)
  expect(failed.status).toBe('failed')
  const deadLetter = await findDeadLetterForRun(request, runId)
  expect(deadLetter).not.toBeNull()
  return deadLetter!.id
}

async function hideUnrelatedOverlays(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const selector of ['.toast', '.we-onboarding-banner', '.we-budget-banner']) {
      for (const element of document.querySelectorAll<HTMLElement>(selector)) element.style.display = 'none'
    }
  })
}

async function capture(locator: Locator, name: string): Promise<void> {
  await expect(locator).toBeVisible()
  if (!EVIDENCE_DIR) return
  await mkdir(EVIDENCE_DIR, { recursive: true })
  await locator.evaluate((element) => {
    const surface = element.closest('[role="dialog"]') ?? element
    for (const animation of surface.getAnimations({ subtree: true })) {
      const endTime = animation.effect?.getComputedTiming().endTime
      if (typeof endTime === 'number' && Number.isFinite(endTime)) animation.finish()
    }
  })
  await locator.screenshot({ path: `${EVIDENCE_DIR}/${name}.png`, animations: 'disabled', caret: 'hide' })
}

async function expectAccessible(page: Page, context: string): Promise<void> {
  await page.locator('html').evaluate((root) => {
    for (const animation of root.getAnimations({ subtree: true })) {
      const endTime = animation.effect?.getComputedTiming().endTime
      if (typeof endTime === 'number' && Number.isFinite(endTime)) animation.finish()
    }
  })
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()
  const blocking = results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({
      context,
      rule: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target.map(String)),
    }))
  expect(blocking, `${context} must have no serious or critical axe violations`).toEqual([])
}

test.describe.configure({ mode: 'serial' })

test('creates, observes, and stops a paced campaign in English and Spanish', async ({ page, request }) => {
  test.setTimeout(180_000)
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))

  const workflow = scopeFailureNode(await loadTemplate(request, 'failed-workflow-recovery'))
  const deadLetterIds: string[] = []
  for (let index = 0; index < 4; index += 1) {
    deadLetterIds.push(await createFailedRecovery(request, workflow, index + 1))
  }

  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.addInitScript(() => {
    window.localStorage.setItem('janusly:activeOrg', 'default')
    if (!window.localStorage.getItem('janusly:locale')) {
      window.localStorage.setItem('janusly:locale', 'en')
    }
  })
  await page.goto('/')
  await openWorkspaceSection(page, 'Activity', 'Recover')
  await openRecoveryAutomation(page)

  const queue = page.getByTestId('recovery-queue')
  await expect(queue).toBeVisible()
  await queue.getByTestId('dlq-search').fill(FAILURE_NODE_ID)
  await expect(queue.locator('[data-dead-letter-id]')).toHaveCount(4)
  await queue.getByTestId('dlq-select-toggle').click()
  for (const deadLetterId of deadLetterIds) {
    await queue.getByTestId(`dlq-select-row-${deadLetterId}`).click()
  }
  await expect(queue.getByTestId('dlq-create-replay-campaign')).toBeEnabled()
  await queue.getByTestId('dlq-create-replay-campaign').click()

  const dialog = page.getByTestId('replay-campaign-dialog')
  await expect(dialog).toContainText('4 of 4 eligible')
  await expect(dialog).toContainText('One failure cluster')
  await dialog.getByTestId('replay-campaign-name').fill('Payments recovery')
  await dialog.getByTestId('replay-campaign-pace').selectOption('60000')
  await hideUnrelatedOverlays(page)
  await expectAccessible(page, 'Replay campaign preview')
  await capture(dialog, 'web-en-replay-campaign-preview')
  await dialog.getByTestId('replay-campaign-create').click()

  const campaign = page.locator('[data-testid^="replay-campaign-"]', { hasText: 'Payments recovery' }).first()
  await expect(campaign).toBeVisible()
  await expect(campaign).toContainText('Running')
  await expect(campaign).toContainText(/1 of 4 settled/, { timeout: 30_000 })
  await hideUnrelatedOverlays(page)
  await expectAccessible(page, 'Running replay campaign')
  await capture(page.getByTestId('replay-campaigns-card'), 'web-en-replay-campaign-running')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => window.localStorage.setItem('janusly:locale', 'es'))
  await page.reload()
  await openWorkspaceSection(page, 'Actividad', 'Recuperar')
  await openRecoveryAutomation(page)
  const spanishCard = page.getByTestId('replay-campaigns-card')
  await expect(spanishCard).toContainText('Payments recovery')
  await expect(spanishCard).toContainText('En curso')
  await spanishCard.getByRole('button', { name: 'Detener campaña', exact: true }).click()
  await expect(spanishCard).toContainText('¿Dejar de tomar nuevos fallos?')
  await hideUnrelatedOverlays(page)
  await expectAccessible(page, 'Confirmación de campaña de reintentos')
  await capture(spanishCard, 'web-es-replay-campaign-cancel-confirm')
  await spanishCard.getByRole('button', { name: 'Detener campaña', exact: true }).click()
  await expect(spanishCard).toContainText('Detenida')
  await expect(spanishCard).toContainText('Reintentados: 1 · Fallidos: 0')
  await hideUnrelatedOverlays(page)
  await expectAccessible(page, 'Campaña de reintentos detenida')
  await capture(spanishCard, 'web-es-replay-campaign-stopped')

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(2)
  expect(consoleErrors).toEqual([])
  expect(pageErrors).toEqual([])
})
