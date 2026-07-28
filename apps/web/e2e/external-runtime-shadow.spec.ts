import { openWorkspaceSection } from './_helpers/workspace-navigation'
/**
 * Real-stack proof for signed, idempotent, monotonic external-runtime shadow
 * ingestion and its observer-only Operations surface.
 */

import { createHmac } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3001'
const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR
const SIGNING_SECRET = 'janusly-e2e-external-runtime-secret'
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

function authHeaders(orgId: string) {
  return {
    'Content-Type': 'application/json',
    'x-org-id': orgId,
    'x-user-id': 'dev-user',
  }
}

function event(input: {
  id: string
  runId: string
  stepId: string
  sequence: number
  status: 'failed' | 'succeeded'
}) {
  return {
    specversion: '1.0',
    id: input.id,
    source: 'urn:temporal:payments',
    type: 'io.janusly.external.step.observed',
    time: new Date().toISOString(),
    data: {
      externalWorkflowId: 'payment-reconciliation',
      externalRunId: input.runId,
      externalStepId: input.stepId,
      name: input.stepId === 'charge' ? 'Charge customer' : 'Notify finance',
      sequence: input.sequence,
      status: input.status,
      evidence: [{
        kind: 'trace',
        label: 'Open trace',
        locator: `trace-${input.runId}-${input.stepId}-${input.sequence}`,
      }],
    },
  }
}

async function postSignedEvent(
  request: APIRequestContext,
  callbackUrl: string,
  payload: ReturnType<typeof event>,
) {
  const rawBody = JSON.stringify(payload)
  const timestamp = Math.floor(Date.now() / 1_000)
  const signature = createHmac('sha256', SIGNING_SECRET)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex')
  return request.post(`${API_URL}${callbackUrl}`, {
    headers: {
      'content-type': 'application/json',
      'x-janusly-signature': `t=${timestamp},v1=${signature}`,
    },
    data: rawBody,
  })
}

async function capture(locator: Locator, name: string): Promise<void> {
  await expect(locator).toBeVisible()
  if (!EVIDENCE_DIR) return
  await mkdir(EVIDENCE_DIR, { recursive: true })
  await locator.screenshot({
    path: `${EVIDENCE_DIR}/${name}.png`,
    animations: 'disabled',
    caret: 'hide',
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

test('observes external failures and recovery without remote control authority', async ({ page, request }) => {
  test.setTimeout(180_000)
  const orgId = `external-shadow-${Date.now()}`
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))

  const credentialResponse = await request.post(`${API_URL}/credentials`, {
    headers: authHeaders(orgId),
    data: {
      name: 'temporal-observer',
      kind: 'external_runtime_signing_secret',
      secretValue: SIGNING_SECRET,
    },
  })
  expect(credentialResponse.ok()).toBe(true)

  await page.setViewportSize({ width: 1440, height: 1200 })
  await page.addInitScript((activeOrg) => {
    window.localStorage.setItem('janusly:activeOrg', activeOrg)
    if (!window.localStorage.getItem('janusly:locale')) {
      window.localStorage.setItem('janusly:locale', 'en')
    }
    window.localStorage.setItem('janusly:operations:section', 'integrations')
  }, orgId)
  await page.goto('/')
  await openWorkspaceSection(page, 'Settings', 'Workspace')
  const panel = page.locator('.we-external-runtime')
  await expect(panel).toBeVisible()
  await panel.getByRole('button', { name: 'New observer' }).click()
  const form = panel.getByTestId('external-runtime-form')
  await form.getByLabel('Connection name').fill('Temporal production')
  await form.getByLabel('Runtime key').fill('temporal-prod')
  await form.getByLabel('Signing-secret credential').selectOption('temporal-observer')
  await form.getByRole('button', { name: 'Create observer' }).click()

  const connection = panel.getByTestId(/external-runtime-/).filter({ hasText: 'Temporal production' })
  await expect(connection).toContainText('Listening')
  const callbackUrl = await connection.locator('code').textContent()
  expect(callbackUrl).toMatch(/^\/webhooks\/external-runtimes\//)

  const recoveredFailure = event({
    id: `charge-failed-${orgId}`,
    runId: 'run-recovered',
    stepId: 'charge',
    sequence: 2,
    status: 'failed',
  })
  const accepted = await postSignedEvent(request, callbackUrl!, recoveredFailure)
  expect(accepted.status()).toBe(202)
  expect(await accepted.json()).toMatchObject({
    accepted: true,
    duplicate: false,
    projectionState: 'applied',
  })
  const duplicate = await postSignedEvent(request, callbackUrl!, recoveredFailure)
  expect(await duplicate.json()).toMatchObject({
    accepted: true,
    duplicate: true,
    projectionState: 'applied',
  })
  const recovered = await postSignedEvent(request, callbackUrl!, event({
    id: `charge-recovered-${orgId}`,
    runId: 'run-recovered',
    stepId: 'charge',
    sequence: 3,
    status: 'succeeded',
  }))
  expect(await recovered.json()).toMatchObject({ projectionState: 'applied' })

  await postSignedEvent(request, callbackUrl!, event({
    id: `notify-failed-${orgId}`,
    runId: 'run-open',
    stepId: 'notify',
    sequence: 4,
    status: 'failed',
  }))
  const stale = await postSignedEvent(request, callbackUrl!, event({
    id: `notify-stale-success-${orgId}`,
    runId: 'run-open',
    stepId: 'notify',
    sequence: 3,
    status: 'succeeded',
  }))
  expect(await stale.json()).toMatchObject({ projectionState: 'stale' })

  await page.reload()
  const refreshed = page.locator('.we-external-runtime')
  await expect(refreshed.getByText('Read-only by design')).toBeVisible()
  const summary = refreshed.getByLabel('External runtime summary')
  await expect(summary.getByText('Failures detected').locator('..').getByText('1')).toBeVisible()
  await expect(summary.getByText('Observed recovered').locator('..').getByText('1')).toBeVisible()
  const cases = refreshed.getByRole('list', { name: 'External runtime recovery cases' })
  await expect(cases.getByText('Observed recovered', { exact: true })).toBeVisible()
  await expect(cases.getByText('Detected', { exact: true })).toBeVisible()
  expect(await refreshed.getByRole('button').allTextContents()).not.toEqual(
    expect.arrayContaining([expect.stringMatching(/retry|resume|cancel run/i)]),
  )
  await expectAccessible(page, 'External runtime shadow')
  await capture(refreshed, 'web-en-external-runtime-shadow')

  await page.evaluate(() => window.localStorage.setItem('janusly:locale', 'es'))
  await page.reload()
  const spanish = page.locator('.we-external-runtime')
  await expect(spanish.getByText('Solo lectura por diseño')).toBeVisible()
  const spanishCases = spanish.getByRole('list', { name: 'Casos de recuperación de runtimes externos' })
  await expect(spanishCases.getByText('Recuperación observada', { exact: true })).toBeVisible()
  await expect(spanishCases.getByText('Detectado', { exact: true })).toBeVisible()
  await expectAccessible(page, 'Modo sombra de runtime externo')
  await capture(spanish, 'web-es-external-runtime-shadow')

  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
    .toBeLessThanOrEqual(2)
  expect(consoleErrors).toEqual([])
  expect(pageErrors).toEqual([])
})
