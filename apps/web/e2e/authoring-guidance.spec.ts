import { openWorkflowAiAction } from './_helpers/workspace-navigation'
import { expect, test, type Page } from '@playwright/test'

function captureBrowserErrors(page: Page) {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

test('Problems and graph context guide an author to a valid branch expression', async ({ page }) => {
  const browserErrors = captureBrowserErrors(page)
  let reviewRequestCount = 0
  await page.route('**/ai/generate-workflow', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        mode: 'fallback',
        id: 'guided-authoring-e2e',
        name: 'Guided authoring',
        inputs: {
          type: 'object',
          properties: { amount: { type: 'number' } },
        },
        nodes: [
          { id: 'start', type: 'noop', config: {} },
          {
            id: 'fetch',
            type: 'http',
            config: {
              url: 'https://example.com/data',
              timeoutMs: 5000,
              maxResponseBytes: 65536,
              retry: { maxAttempts: 2 },
            },
          },
          { id: 'gate', type: 'condition', config: { expression: 'context.fetch.output.ok === true' } },
          { id: 'isolated', type: 'noop', config: {} },
        ],
        edges: [
          { from: 'start', to: 'fetch' },
          { from: 'fetch', to: 'gate' },
        ],
      }),
    })
  })
  await page.route('**/ai/review-workflow', async (route) => {
    reviewRequestCount += 1
    if (reviewRequestCount > 1) await new Promise((resolve) => setTimeout(resolve, 350))
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        mode: 'ai',
        review: {
          status: 'warn',
          issues: [{
            code: 'branch_needs_context',
            severity: 'warn',
            message: 'Clarify which upstream response drives this branch.',
            nodeId: 'gate',
            rationale: 'The branch depends on a remote response.',
            suggestion: 'Use an explicit reachable output path.',
          }],
        },
      }),
    })
  })

  await page.goto('/')
  await openWorkflowAiAction(page, 'Workflows')
  await page.getByRole('button', { name: 'Draft flow', exact: true }).click()
  await page.getByRole('button', { name: 'Review this flow', exact: true }).click()
  await page.locator('.workflow-node').filter({ hasText: 'Branch rule' }).click()

  await page.getByRole('button', { name: /^Problems\b/ }).click()
  await expect(page.getByTestId('authoring-problems')).toBeVisible()
  const aiReviewProblem = page.getByTestId('authoring-problem-branch_needs_context')
  await expect(aiReviewProblem).toContainText('AI review')
  await aiReviewProblem.click()
  const branchMode = page.getByLabel('Run rule')
  await expect(branchMode).toHaveValue('simple')
  await expect(page.getByRole('option', { name: 'context.fetch.output.statusCode' })).toHaveCount(1)
  await expect(page.getByRole('option', { name: 'context.isolated.output' })).toHaveCount(0)
  await expect(page.getByRole('option', { name: 'context.input.amount' })).toHaveCount(1)
  await branchMode.selectOption('advanced')
  const expression = page.getByLabel('Branch expression')
  await expect(expression).toHaveValue('context.fetch.output.ok === true')

  await expression.fill('process.exit()')
  await expect(page.getByTestId('authoring-problem-branch_needs_context')).toHaveCount(0)
  await expect(page.getByRole('alert')).toContainText('does not match the supported runtime grammar')
  await page.getByRole('button', { name: /^Problems\b/ }).click()
  await page.getByRole('button', { name: 'Run checks' }).click()
  const invalidProblem = page.getByTestId('authoring-problem-condition_invalid_expression')
  await expect(invalidProblem).toBeVisible()
  await invalidProblem.click()
  await expect(page.getByTestId('inspector-node-gate')).toBeFocused()

  await expression.fill('context.fetch.output.statusCode === 200')
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(invalidProblem).toHaveCount(0)

  // A delayed structural response for an older expression must not repopulate
  // Problems after a newer semantic edit has invalidated that request.
  await page.route('**/validate', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 350))
    await route.continue()
  })
  await expression.fill('process.exit()')
  await page.getByRole('button', { name: /^Problems\b/ }).click()
  const staleValidationResponse = page.waitForResponse((response) => response.url().endsWith('/validate'))
  await page.getByRole('button', { name: 'Run checks' }).click()
  await page.getByRole('button', { name: 'Step', exact: true }).click()
  await expression.fill('context.fetch.output.statusCode === 201')
  await staleValidationResponse
  await page.getByRole('button', { name: /^Problems\b/ }).click()
  await expect(invalidProblem).toHaveCount(0)

  // The same revision guard applies to AI review findings that complete after
  // the operator has already changed the graph.
  await openWorkflowAiAction(page, 'Workflows')
  const staleReviewResponse = page.waitForResponse((response) => response.url().endsWith('/ai/review-workflow'))
  await page.getByRole('button', { name: 'Review this flow', exact: true }).click()
  await page.locator('.workflow-node').filter({ hasText: 'Branch rule' }).click()
  await page.getByLabel('Run rule').selectOption('advanced')
  await page.getByLabel('Branch expression').fill('context.fetch.output.statusCode === 202')
  await staleReviewResponse
  await page.getByRole('button', { name: /^Problems\b/ }).click()
  await expect(page.getByTestId('authoring-problem-branch_needs_context')).toHaveCount(0)
  expect(browserErrors).toEqual([])
})
