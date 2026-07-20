/**
 * Real-stack coverage for draining trigger events that remain after a capped
 * workflow resume. Seeds durable buffered rows, verifies the active Flows row
 * exposes the continuation action, and proves the action clears both the
 * backlog count and its affordance through the live API and worker.
 */

import { mkdir } from 'node:fs/promises'
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { db, triggerEvents } from '../../../packages/db/src/index'

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3001'
const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR

const LOCALES = [
  {
    locale: 'en' as const,
    flows: 'Flows',
    action: 'Continue events',
    cleared: 'Buffered events cleared — 2 replayed',
  },
  {
    locale: 'es' as const,
    flows: 'Flujos',
    action: 'Continuar eventos',
    cleared: 'Se procesaron los eventos en espera: 2 ejecutados de nuevo',
  },
]

function headers(orgId: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-org-id': orgId,
    'x-user-id': 'dev-user',
  }
}

async function seedBufferedWorkflow(
  request: APIRequestContext,
  orgId: string,
  workflowId: string,
  workflowName: string,
): Promise<void> {
  const save = await request.post(`${API_URL}/workflows/save`, {
    headers: headers(orgId),
    data: {
      id: workflowId,
      name: workflowName,
      dslVersion: '1.0',
      nodes: [{ id: 'inbox', type: 'email_received', config: { aliasKey: `alias-${workflowId}` } }],
      edges: [],
    },
  })
  if (!save.ok()) throw new Error(`save ${workflowId} failed: ${save.status()} ${await save.text()}`)
  const { versionId } = await save.json() as { versionId: string }
  await db.insert(triggerEvents).values([0, 1].map(index => ({
    id: `buffered-${workflowId}-${index}`,
    orgId,
    triggerType: 'email_received',
    workflowId,
    workflowVersionId: versionId,
    nodeId: 'inbox',
    status: 'buffered',
    dedupeKey: `email:buffered-${workflowId}-${index}`,
    payloadJson: {
      event: {
        aliasKey: `alias-${workflowId}`,
        from: `sender-${index}@example.com`,
        body: `Buffered message ${index}`,
      },
    },
    skippedReason: 'paused_circuit_breaker',
  })))
}

function installConsoleErrorGuards(page: Page): string[] {
  const errors: string[] = []
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', error => errors.push(error.message))
  return errors
}

async function hideUnrelatedOverlays(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const selector of ['.toast', '.we-onboarding-banner', '.we-budget-banner', '[data-testid="command-palette"]']) {
      for (const element of document.querySelectorAll<HTMLElement>(selector)) element.style.display = 'none'
    }
  })
}

async function capture(surface: Locator, name: string): Promise<void> {
  await expect(surface).toBeVisible()
  await surface.scrollIntoViewIfNeeded()
  if (!EVIDENCE_DIR) return
  await mkdir(EVIDENCE_DIR, { recursive: true })
  await surface.screenshot({ path: `${EVIDENCE_DIR}/${name}.png` })
}

test.describe.configure({ mode: 'serial' })

for (const contract of LOCALES) {
  test(`${contract.locale} active workflow drains its buffered trigger events`, async ({ page, request }) => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const orgId = `buffered-events-${contract.locale}-${stamp}`
    const workflowId = `buffered-flow-${contract.locale}-${stamp}`
    const workflowName = `Buffered events ${contract.locale} ${stamp}`
    await seedBufferedWorkflow(request, orgId, workflowId, workflowName)
    const browserErrors = installConsoleErrorGuards(page)

    await page.addInitScript(({ activeOrg, locale }) => {
      window.localStorage.setItem('janusly:activeOrg', activeOrg)
      window.localStorage.setItem('janusly:locale', locale)
    }, { activeOrg: orgId, locale: contract.locale })

    await page.goto('/')
    await page.getByRole('button', { name: contract.flows, exact: true }).click()
    const row = page.getByTestId(`workflows-row-${workflowId}`)
    const action = page.getByTestId(`workflows-backfill-${workflowId}`)
    await expect(row).toContainText(workflowName)
    await expect(action).toHaveAccessibleName(contract.action)
    await hideUnrelatedOverlays(page)
    await capture(row, `web-${contract.locale}-buffered-events-ready`)

    const resumeResponse = page.waitForResponse(response => {
      return response.request().method() === 'POST'
        && new URL(response.url()).pathname === `/workflows/${workflowId}/resume`
    })
    await action.click()
    const response = await resumeResponse
    expect(response.ok()).toBe(true)
    await expect(response.json()).resolves.toMatchObject({ backfilled: 2, failed: 0, remaining: 0 })
    await expect(action).toHaveCount(0)
    const cleared = page.getByText(contract.cleared, { exact: true })
    await expect(cleared).toBeVisible()
    await capture(cleared.locator('..'), `web-${contract.locale}-buffered-events-cleared`)
    expect(browserErrors).toEqual([])
  })
}
