import { openWorkspaceSection } from './_helpers/workspace-navigation'
/**
 * Real-browser proof for keyboard-first recovery triage, copy-ready failure
 * context, and fuzzy command-palette search. The test seeds two genuine DLQ
 * rows through the API so every keyboard action exercises production wiring.
 */

import { mkdir } from 'node:fs/promises'
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
const FAILURE_NODE_ID = 'operator-velocity-charge'

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

async function hideUnrelatedOverlays(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const selector of ['.toast', '.we-onboarding-banner', '.we-budget-banner']) {
      for (const element of document.querySelectorAll<HTMLElement>(selector)) element.style.display = 'none'
    }
  })
}

async function captureElement(locator: Locator, name: string): Promise<void> {
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
  await locator.screenshot({ path: `${EVIDENCE_DIR}/${name}.png` })
}

async function createFailedRecovery(
  request: APIRequestContext,
  workflow: WorkflowJson,
  sequence: number,
  orgId: string,
): Promise<{ id: string; runId: string }> {
  const payload = { customer: `operator-${sequence}@example.com`, amountUsd: 40 + sequence }
  const { runId } = await startRun(request, workflow, payload, orgId)
  await pollUntilWaitingOrTerminal(request, runId, 'trigger', 30_000, orgId)
  await resumeWebhook(request, runId, 'trigger', payload, orgId)
  const failed = await pollUntilTerminal(request, runId, 30_000, orgId)
  expect(failed.status).toBe('failed')
  const deadLetter = await findDeadLetterForRun(request, runId, orgId)
  expect(deadLetter).not.toBeNull()
  return { id: deadLetter!.id, runId }
}

test.describe.configure({ mode: 'serial' })

test('operator triages genuine failures by keyboard, copies context, and fuzzy-searches commands', async ({
  context,
  page,
  request,
}) => {
  test.setTimeout(120_000)
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))

  const orgId = `operator-velocity-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const workflow = scopeFailureNode(await loadTemplate(request, 'failed-workflow-recovery', orgId))
  const firstFailure = await createFailedRecovery(request, workflow, 1, orgId)
  const secondFailure = await createFailedRecovery(request, workflow, 2, orgId)
  const thirdFailure = await createFailedRecovery(request, workflow, 3, orgId)

  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.addInitScript(({ activeOrg }) => {
    window.localStorage.setItem('janusly:activeOrg', activeOrg)
  }, { activeOrg: orgId })
  await page.goto('/')
  await openWorkspaceSection(page, 'Activity', 'Recover')

  const queue = page.getByTestId('recovery-queue')
  await expect(queue).toBeVisible()
  await queue.getByTestId('dlq-search').fill(FAILURE_NODE_ID)
  await expect(queue.locator('[data-dead-letter-id]')).toHaveCount(3)
  const firstRow = queue.locator(`[data-dead-letter-id="${firstFailure.id}"]`)
  const secondRow = queue.locator(`[data-dead-letter-id="${secondFailure.id}"]`)
  const thirdRow = queue.locator(`[data-dead-letter-id="${thirdFailure.id}"]`)
  await expect(firstRow).toBeVisible()
  await expect(secondRow).toBeVisible()
  await expect(thirdRow).toBeVisible()

  await firstRow.click()
  const copyButton = queue.getByTestId('dlq-copy-error')
  await expect(copyButton).toBeVisible()
  const detail = queue.locator('.detail-box')
  await expect(detail.getByRole('button', { name: 'Retry' }).locator('kbd')).toHaveText('R')
  await expect(detail.getByRole('button', { name: 'Resolve' }).locator('kbd')).toHaveText('⌘/Ctrl ↵')
  await hideUnrelatedOverlays(page)
  await captureElement(detail, 'web-en-recovery-detail-default')

  await copyButton.click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain(firstFailure.runId)
  const copiedToast = page.getByText('Error summary copied')
  await expect(copiedToast).toBeVisible()
  await captureElement(copiedToast.locator('..'), 'web-en-recovery-copy-success')

  const visibleRows = queue.locator('[data-dead-letter-id]')
  const firstVisibleRow = visibleRows.nth(0)
  const secondVisibleRow = visibleRows.nth(1)
  await firstVisibleRow.focus()
  await page.keyboard.press('j')
  await expect(secondVisibleRow).toBeFocused()
  await captureElement(queue.getByTestId('dlq-virtual-list'), 'web-en-recovery-keyboard-next')
  await page.keyboard.press('k')
  await expect(firstVisibleRow).toBeFocused()

  await firstRow.focus()
  await page.keyboard.press('r')
  await expect(page.getByText('Replay queued')).toBeVisible()
  await expect(secondRow).toBeFocused()

  await page.keyboard.press('Control+Enter')
  await expect(page.getByText('Dead letter resolved')).toBeVisible()
  await expect(thirdRow).toBeFocused()

  await page.getByRole('button', { name: /command palette/i }).click()
  const palette = page.getByTestId('command-palette')
  await expect(palette).toBeVisible()
  await palette.getByRole('combobox').fill('gtrcv')
  const options = palette.getByRole('option')
  await expect(options.first()).toContainText('Go to Recover')
  expect(await options.count()).toBeLessThanOrEqual(5)
  await hideUnrelatedOverlays(page)
  await captureElement(palette.locator('.we-cmdk-dialog'), 'web-en-command-palette-fuzzy-result')

  await page.keyboard.press('Escape')
  await page.keyboard.press('?')
  const shortcuts = page.getByTestId('shortcuts-modal')
  await expect(shortcuts.getByText('Recovery queue')).toBeVisible()
  await captureElement(shortcuts.locator('.we-shortcuts-dialog'), 'web-en-shortcuts-recovery')
  await page.keyboard.press('Escape')

  await page.evaluate(() => window.localStorage.setItem('janusly:locale', 'es'))
  await page.reload()
  await openWorkspaceSection(page, 'Actividad', 'Recuperar')
  const spanishQueue = page.getByTestId('recovery-queue')
  const spanishRow = spanishQueue.locator('[data-dead-letter-id]').first()
  await expect(spanishRow).toBeVisible()
  await spanishRow.click()
  const spanishDetail = spanishQueue.locator('.detail-box')
  await expect(spanishDetail.getByRole('button', { name: 'Copiar error' })).toBeVisible()
  await hideUnrelatedOverlays(page)
  await captureElement(spanishDetail, 'web-es-recovery-detail-default')

  await spanishDetail.getByRole('button', { name: 'Copiar error' }).click()
  const spanishToast = page.getByText('Resumen del error copiado')
  await expect(spanishToast).toBeVisible()
  await captureElement(spanishToast.locator('..'), 'web-es-recovery-copy-success')

  await page.getByRole('button', { name: /paleta de comandos/i }).click()
  const spanishPalette = page.getByTestId('command-palette')
  await spanishPalette.getByRole('combobox').fill('irrecuperar')
  await expect(spanishPalette.getByRole('option').first()).toContainText('Ir a Recuperar')
  await hideUnrelatedOverlays(page)
  await captureElement(spanishPalette.locator('.we-cmdk-dialog'), 'web-es-command-palette-fuzzy-result')

  await page.keyboard.press('Escape')
  await page.keyboard.press('?')
  const spanishShortcuts = page.getByTestId('shortcuts-modal')
  await expect(spanishShortcuts.getByText('Cola de recuperación')).toBeVisible()
  await captureElement(spanishShortcuts.locator('.we-shortcuts-dialog'), 'web-es-shortcuts-recovery')

  expect(consoleErrors).toEqual([])
  expect(pageErrors).toEqual([])
})
