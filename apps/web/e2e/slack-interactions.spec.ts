/**
 * Real-stack proof for signed Slack recovery actions and their admin UI.
 * Creates a genuine failed run, configures the connection through the English
 * desktop surface, verifies signed acknowledge/assign/idempotency callbacks,
 * then inspects the mapping in Spanish mobile.
 */

import { createHmac } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { db, orgMembers } from '../../../packages/db/src/index'

import {
  findDeadLetterForRun,
  loadTemplate,
  pollUntilTerminal,
  pollUntilWaitingOrTerminal,
  resumeWebhook,
  seedCredential,
  startRun,
} from './_helpers/demo-helpers'

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3001'
const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR
function authHeaders(orgId: string) {
  return {
    'Content-Type': 'application/json',
    'x-org-id': orgId,
    'x-user-id': 'dev-user',
  }
}
const SIGNING_SECRET = 'janusly-e2e-slack-signing-secret'
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

async function createRecoveryItem(request: APIRequestContext, orgId: string): Promise<string> {
  const workflow = await loadTemplate(request, 'failed-workflow-recovery', orgId)
  const payload = { customer: 'slack-operator@example.com', amountUsd: 77 }
  const { runId } = await startRun(request, workflow, payload, orgId)
  await pollUntilWaitingOrTerminal(request, runId, 'trigger', 30_000, orgId)
  await resumeWebhook(request, runId, 'trigger', payload, orgId)
  expect((await pollUntilTerminal(request, runId, 30_000, orgId)).status).toBe('failed')
  const deadLetter = await findDeadLetterForRun(request, runId, orgId)
  expect(deadLetter).not.toBeNull()
  let recoveryItemId = ''
  await expect.poll(async () => {
    const response = await request.get(`${API_URL}/recovery/items?limit=200`, { headers: authHeaders(orgId) })
    if (!response.ok()) return `http-${response.status()}`
    const body = await response.json() as { items?: Array<{ id: string; deadLetterId: string }> }
    recoveryItemId = body.items?.find((candidate) => candidate.deadLetterId === deadLetter!.id)?.id ?? ''
    return recoveryItemId
  }, {
    message: 'failed run must create a linked recovery item',
    timeout: 30_000,
  }).not.toBe('')
  return recoveryItemId
}

async function postSignedAction(
  request: APIRequestContext,
  connectionId: string,
  itemId: string,
  actionId: string,
  timestamp: number,
) {
  const rawBody = new URLSearchParams({
    payload: JSON.stringify({
      type: 'block_actions',
      team: { id: 'T-E2E' },
      user: { id: 'U-E2E' },
      actions: [{ action_id: actionId, value: itemId }],
    }),
  }).toString()
  const signature = `v0=${createHmac('sha256', SIGNING_SECRET)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest('hex')}`
  return request.post(`${API_URL}/webhooks/slack/interactions/${connectionId}`, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'x-slack-request-timestamp': String(timestamp),
      'x-slack-signature': signature,
    },
    data: rawBody,
  })
}

async function hideOverlays(page: Page): Promise<void> {
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
  await locator.screenshot({ path: `${EVIDENCE_DIR}/${name}.png`, animations: 'disabled', caret: 'hide' })
}

async function capturePage(page: Page, name: string): Promise<void> {
  if (!EVIDENCE_DIR) return
  await mkdir(EVIDENCE_DIR, { recursive: true })
  await page.screenshot({
    path: `${EVIDENCE_DIR}/${name}.png`,
    animations: 'disabled',
    caret: 'hide',
    fullPage: true,
  })
}

async function expectAccessible(page: Page, context: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()
  const blocking = results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({
      context,
      rule: violation.id,
      targets: violation.nodes.map((node) => node.target.map(String)),
    }))
  expect(blocking).toEqual([])
}

test.describe.configure({ mode: 'serial' })

test('configures and executes signed recovery actions in English and Spanish', async ({ page, request }) => {
  test.setTimeout(180_000)
  const orgId = `slack-interactions-${Date.now()}`
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await db.insert(orgMembers).values({
    id: `slack-member-${Date.now()}`,
    orgId,
    userId: 'dev-user',
    email: 'dev-user@janusly.local',
    role: 'admin',
  }).onConflictDoNothing()
  await seedCredential(request, {
    name: 'e2e-slack-signing',
    kind: 'slack_signing_secret',
    secretRef: 'JANUSLY_E2E_SLACK_SIGNING_SECRET',
  }, orgId)
  const recoveryItemId = await createRecoveryItem(request, orgId)

  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.addInitScript((activeOrg) => {
    window.localStorage.setItem('janusly:activeOrg', activeOrg)
    if (!window.localStorage.getItem('janusly:locale')) window.localStorage.setItem('janusly:locale', 'en')
    window.localStorage.setItem('janusly:operations:section', 'integrations')
  }, orgId)
  await page.goto('/')
  await page.getByRole('button', { name: 'Operations', exact: true }).click()
  const panel = page.locator('.we-slack-interactions')
  await expect(panel).toBeVisible()
  await panel.getByRole('button', { name: 'New connection' }).click()
  const form = panel.getByTestId('slack-interaction-form')
  await form.getByLabel('Connection name').fill('Recovery operations')
  await form.getByLabel('Slack team ID').fill('T-E2E')
  await form.getByLabel('Signing-secret credential').selectOption('e2e-slack-signing')
  await form.getByLabel('Slack user ID, mapping 1').fill('U-E2E')
  await form.getByLabel('Janusly member, mapping 1').selectOption('dev-user')
  await hideOverlays(page)
  await expectAccessible(page, 'Slack interaction setup')
  await capture(panel, 'web-en-slack-interaction-setup')
  await form.getByRole('button', { name: 'Create connection' }).click()
  const connection = panel.locator('[data-testid^="slack-interaction-"]').first()
  await expect(connection).toContainText('Recovery operations')
  await expect(connection).toContainText('1 mapped operator')
  const callback = await connection.locator('code').textContent()
  expect(callback).toContain('/webhooks/slack/interactions/')
  const connectionId = callback!.split('/').at(-1)!
  await hideOverlays(page)
  await capture(panel, 'web-en-slack-interaction-ready')

  const timestamp = Math.floor(Date.now() / 1000)
  const acknowledged = await postSignedAction(
    request,
    connectionId,
    recoveryItemId,
    'janusly_recovery_acknowledge',
    timestamp,
  )
  expect(acknowledged.ok()).toBe(true)
  const duplicate = await postSignedAction(
    request,
    connectionId,
    recoveryItemId,
    'janusly_recovery_acknowledge',
    timestamp,
  )
  expect(await duplicate.json()).toMatchObject({ ok: true, duplicate: true })
  const assigned = await postSignedAction(
    request,
    connectionId,
    recoveryItemId,
    'janusly_recovery_assign_to_me',
    timestamp,
  )
  expect(assigned.ok()).toBe(true)
  const itemResponse = await request.get(`${API_URL}/recovery/items/${recoveryItemId}`, { headers: authHeaders(orgId) })
  expect(itemResponse.ok()).toBe(true)
  expect(await itemResponse.json()).toMatchObject({
    item: { status: 'acknowledged', owner: 'dev-user' },
  })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.evaluate(() => window.localStorage.setItem('janusly:locale', 'es'))
  await page.reload()
  const spanishPanel = page.locator('.we-slack-interactions')
  await expect(spanishPanel).toContainText('Acciones interactivas de recuperación')
  await spanishPanel.getByRole('button', { name: 'Editar', exact: true }).click()
  await expect(spanishPanel.getByLabel('Id del usuario de Slack, vínculo 1')).toHaveValue('U-E2E')
  await hideOverlays(page)
  await expectAccessible(page, 'Configuración interactiva de Slack')
  await capturePage(page, 'web-es-slack-interaction-mobile')

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(2)
  expect(consoleErrors).toEqual([])
  expect(pageErrors).toEqual([])
})
