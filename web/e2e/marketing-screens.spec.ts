/**
 * Product screenshots for the marketing site (website/public/screens).
 *
 * Opt-in: runs only when JANUSLY_MARKETING_SCREENS_DIR names an output
 * directory, against the seeded runtime stack (`scripts/test-e2e.sh` shape:
 * `JANUSLY_E2E_RUNTIME_BASE_URL`, `E2E_API_URL`). Every surface is the real
 * product over the seeded organization; the AI proposal is the one exception:
 * the runtime has no provider key in that stack, so the proposal endpoint is
 * answered with a representative workflow and the UI renders it for real.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { mockWorkflowProposal } from './_helpers/workflow-authoring'
import { openRecoveryAutomation, openWorkflowAiAction, openWorkspaceDestination } from './_helpers/workspace-navigation'

const OUT = process.env.JANUSLY_MARKETING_SCREENS_DIR

test.describe('marketing screens', () => {
  test.skip(!OUT, 'JANUSLY_MARKETING_SCREENS_DIR is not set')
  test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: 'light' })

  test.beforeAll(async () => {
    if (OUT) await mkdir(OUT, { recursive: true })
  })

  async function capture(page: Page, name: string) {
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(OUT!, `${name}.png`), fullPage: false })
  }

  test('recovery center with the seeded failure cluster', async ({ page }) => {
    await page.goto('/')
    await page.locator('.app-shell').waitFor({ state: 'visible' })
    // The header's recovery pill is the operator's own path into the queue.
    await page.getByRole('button', { name: /^Open recovery/ }).first().click()
    const tools = page.getByRole('button', { name: 'Recovery tools', exact: true })
    await tools.waitFor({ state: 'visible' })
    await tools.click()
    await page.getByTestId('recovery-queue').waitFor({ state: 'visible' })
    await openRecoveryAutomation(page)
    await expect(page.getByTestId('recovery-automation')).toBeVisible()
    await capture(page, 'recovery-center')
  })

  test('ai studio with a compiled brief and a proposal', async ({ page }) => {
    await page.route('**/ai/health', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ enabled: true, model: 'claude-haiku-4-5-20251001', timeoutMs: 30_000, maxRetries: 2 }),
    }))
    await mockWorkflowProposal(page, {
      dslVersion: '1.0',
      id: 'order-exceptions',
      name: 'Order exceptions to the on-call owner',
      nodes: [
        { id: 'fetch_order', type: 'http', config: { method: 'GET', url: 'https://erp.example.com/orders/latest' } },
        { id: 'classify', type: 'transform', config: { mapping: { exception: '{{context.fetch_order.output.status}}' } } },
        { id: 'owner_decision', type: 'approval', config: { message: 'An order needs a decision before it ships.' } },
        { id: 'notify_owner', type: 'http', config: { method: 'POST', url: 'https://hooks.example.com/orders-oncall' } },
        { id: 'done', type: 'noop', config: {} },
      ],
      edges: [
        { from: 'fetch_order', to: 'classify' },
        { from: 'classify', to: 'owner_decision' },
        { from: 'owner_decision', to: 'notify_owner' },
        { from: 'notify_owner', to: 'done' },
      ],
    }, {
      mode: 'ai',
      assumptions: ['The ERP exposes orders over HTTPS with the credential erp-api', 'Only exceptions reach the on-call owner'],
      risks: ['The on-call webhook writes to a shared channel: it runs only after the approval gate'],
    })
    await page.goto('/')
    await page.locator('.app-shell').waitFor({ state: 'visible' })
    // Open a seeded workflow first so the canvas shows a real graph next to
    // the proposal instead of an empty draft.
    await openWorkspaceDestination(page, 'Workflows')
    const pipelineRow = page.locator('.we-list-row').filter({ hasText: 'Demo · order pipeline' }).first()
    await pipelineRow.waitFor({ state: 'visible' })
    await pipelineRow.getByRole('button', { name: /^Open/ }).first().click()
    await expect(page.locator('.workflow-node').first()).toBeVisible({ timeout: 20_000 })
    await openWorkflowAiAction(page, 'Workflows')
    const brief = page.locator('.ai-studio-prompt')
    await brief.waitFor({ state: 'visible' })
    await brief.fill('When an order is created in the ERP, fetch it, and if it is an exception ask the on-call owner for a decision, notify them through the orders webhook and record it in the exceptions sheet.')
    await page.getByRole('button', { name: 'Compile intent brief', exact: true }).click()
    await page.getByTestId('intent-brief').waitFor({ state: 'visible' })
    await page.getByRole('button', { name: 'Build proposal', exact: true }).click()
    await page.getByTestId('workflow-proposal').waitFor({ state: 'visible' })
    await page.locator('.workspace-panel').first().evaluate((panel) => panel.scrollTo({ top: 0 }))
    await page.waitForTimeout(600)
    await capture(page, 'ai-studio')
  })

  test('home recovery center over the seeded organization', async ({ page }) => {
    await page.goto('/')
    await page.locator('.we-recovery-center-hero').waitFor({ state: 'visible' })
    await page.getByRole('button', { name: /Open recovery queue/ }).waitFor({ state: 'visible' })
    await page.waitForLoadState('networkidle')
    await capture(page, 'home')
  })
})
