import { openWorkflowAiAction, openWorkspaceSection } from './_helpers/workspace-navigation'
import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

const enabled = process.env.JANUSLY_LOCAL_STACK_E2E === '1'
const evidenceDir = process.env.JANUSLY_EVIDENCE_DIR

function guardBrowserErrors(page: Page) {
  const errors: string[] = []
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => {
    if (response.status() >= 400) errors.push(`${response.status()} ${new URL(response.url()).pathname}`)
  })
  return errors
}

test('a prompt creates the deterministic PagerDuty flow in the normal editor', async ({ page }) => {
  test.skip(!enabled, 'requires the persistent local Docker stack')
  const browserErrors = guardBrowserErrors(page)
  await page.addInitScript(() => {
    window.localStorage.setItem('janusly:activeOrg', 'default')
    window.localStorage.setItem('janusly:locale', 'en')
  })

  await page.goto('/')
  await openWorkflowAiAction(page, 'Workflows')
  await page.getByPlaceholder(
    'Example: when a customer asks for a refund, check policy, summarize risk, and ask for approval.',
  ).fill(
    'When PagerDuty alerts user PLOCALUSER outside working hours 09:00 to 17:00 in America/Bogota, acknowledge it and snooze it for 12 hours. Use API credential pagerduty-api and webhook credential pagerduty-webhook for operator@example.com.',
  )
  await page.getByRole('button', { name: 'Draft flow', exact: true }).click()

  await expect(page.getByText('Starter flow loaded locally').first()).toBeVisible()
  await expect(page.getByText(/PagerDuty off-hours incident handling is now on the canvas/)).toBeVisible()

  await openWorkspaceSection(page, 'Workflows', 'Build')
  const canvas = page.locator('.canvas-frame')
  await expect(canvas.locator('.react-flow__node')).toHaveCount(7)
  await expect(canvas.locator('.react-flow__node[data-id="on_pagerduty"]')).toBeVisible()
  await expect(canvas.locator('.react-flow__node[data-id="evaluate_policy"]')).toBeVisible()
  await expect(canvas.locator('.react-flow__node[data-id="acknowledge_incident"]')).toBeVisible()
  await expect(canvas.locator('.react-flow__node[data-id="snooze_incident"]')).toBeVisible()
  await expect(canvas.locator('.react-flow__node[data-id="summarize_action"]')).toHaveCount(0)
  await expect(page.getByRole('button', {
    name: /^Production readiness: (?:Production Ready|\d+ warnings?)$/u,
  })).toBeVisible()
  await expect(page.getByRole('button', {
    name: /^Production readiness: \d+ blockers?$/u,
  })).toHaveCount(0)
  await expect(page.getByText('Readiness is being checked…', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Working...', { exact: true })).toHaveCount(0)

  if (evidenceDir) {
    await mkdir(evidenceDir, { recursive: true })
    await page.screenshot({
      path: `${evidenceDir}/pagerduty-prompt-generated-flow.png`,
      fullPage: true,
    })
  }

  await canvas.locator('.react-flow__node[data-id="on_pagerduty"] .workflow-node').click()
  await expect(page.getByLabel('Webhook signing credential')).toHaveValue('pagerduty-webhook')
  const callbackUrl = page.getByLabel('PagerDuty callback URL')
  await expect(callbackUrl).toHaveValue(
    /\/webhooks\/pagerduty\/pagerduty_off_hours_[a-f0-9]{8}\/on_pagerduty$/u,
  )
  await expect(page.getByText(/signature is verified before an event or run is persisted/i)).toBeVisible()

  if (evidenceDir) {
    await callbackUrl.scrollIntoViewIfNeeded()
    await page.screenshot({
      path: `${evidenceDir}/pagerduty-prompt-trigger-config.png`,
      fullPage: true,
    })
  }
  expect(browserErrors).toEqual([])
})
