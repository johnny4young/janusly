import { openWorkflowAiAction } from './_helpers/workspace-navigation'
import {
  applyBuiltWorkflowProposal,
  buildWorkflowProposal,
  mockWorkflowProposal,
} from './_helpers/workflow-authoring'
import { expect, test } from '@playwright/test'

test('AI Studio drafts a flow from a business prompt', async ({ page }) => {
  await mockWorkflowProposal(page, {
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
  })

  await page.goto('/')
  await openWorkflowAiAction(page, 'Workflows')
  await page.getByPlaceholder('Example: when a customer asks for a refund, check policy, summarize risk, and ask for approval.').fill('When a refund is risky, pause for approval before notifying the customer.')
  const proposal = await buildWorkflowProposal(page)
  await expect(
    proposal.getByRole('status').filter({ hasText: 'Deterministic local proposal' }),
  ).toBeVisible()
  await applyBuiltWorkflowProposal(page)
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
  await openWorkflowAiAction(page, 'Workflows', 'explain')

  await expect(page.getByText('Explanation for Untitled Workflow')).toBeVisible()
  await expect(page.getByText('This flow starts by calling an API, then coordinates an agent team for the next action.')).toBeVisible()
})
