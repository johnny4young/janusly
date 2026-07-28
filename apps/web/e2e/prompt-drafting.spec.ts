import { openWorkspaceSection } from './_helpers/workspace-navigation'
import { expect, test } from '@playwright/test'

test('AI Studio drafts a flow from a business prompt', async ({ page }) => {
  await page.route('**/ai/generate-workflow', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        mode: 'fallback',
        dslVersion: '1.0',
        id: 'approval-prompt-test',
        name: 'Approval prompt test',
        nodes: [
          { id: 'start', type: 'noop', config: {} },
          { id: 'approval', type: 'approval', config: { message: 'Approve the refund before sending the customer update.' } },
          { id: 'done', type: 'noop', config: {} },
        ],
        edges: [
          { from: 'start', to: 'approval' },
          { from: 'approval', to: 'done' },
        ],
      }),
    })
  })

  await page.goto('/')
  await openWorkspaceSection(page, 'Workflows', 'Build with AI')
  await page.getByPlaceholder('Example: when a customer asks for a refund, check policy, summarize risk, and ask for approval.').fill('When a refund is risky, pause for approval before notifying the customer.')
  await page.getByRole('button', { name: 'Draft flow', exact: true }).click()

  await expect(page.locator('.result-panel').getByText('Starter flow loaded locally')).toBeVisible()
  await expect(page.locator('.workflow-node').filter({ hasText: 'Ask approval' })).toBeVisible()
  await expect(page.locator('.workflow-node').filter({ hasText: 'Approve the refund before sending the customer update.' })).toBeVisible()
})

test('AI Studio explains the current flow from the panel', async ({ page }) => {
  await page.route('**/ai/explain-workflow', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        mode: 'fallback',
        explanation: 'This flow starts by calling an API, then coordinates an agent team for the next action.',
      }),
    })
  })

  await page.goto('/')
  await openWorkspaceSection(page, 'Workflows', 'Build with AI')
  await page.getByRole('button', { name: 'Explain this flow', exact: true }).click()

  await expect(page.getByText('Explanation for Untitled Workflow')).toBeVisible()
  await expect(page.getByText('This flow starts by calling an API, then coordinates an agent team for the next action.')).toBeVisible()
})
