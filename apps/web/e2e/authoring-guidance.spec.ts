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
  await page.getByRole('button', { name: /^AI Studio\b/ }).click()
  await page.getByRole('button', { name: 'Draft flow', exact: true }).click()
  await page.getByRole('button', { name: 'Review this flow', exact: true }).click()
  await page.locator('.workflow-node').filter({ hasText: 'Branch rule' }).click()

  await expect(page.getByTestId('authoring-problems')).toBeVisible()
  await expect(page.getByTestId('authoring-problem-branch_needs_context')).toContainText('AI review')
  const expression = page.getByLabel('Branch expression')
  await expect(expression).toHaveValue('context.fetch.output.ok === true')
  await page.getByRole('button', { name: 'Use context' }).click()
  await expect(page.getByRole('button', { name: 'Insert context.fetch.output.statusCode at the cursor' })).toBeVisible()
  await expect(page.getByText('context.isolated.output', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Insert context.input.amount at the cursor' })).toBeVisible()

  await expression.fill('process.exit()')
  await expect(page.getByTestId('authoring-problem-branch_needs_context')).toHaveCount(0)
  await expect(page.getByRole('alert')).toContainText('Unsupported expression token')
  await page.getByRole('button', { name: 'Run checks' }).click()
  const invalidProblem = page.getByTestId('authoring-problem-condition_invalid_expression')
  await expect(invalidProblem).toBeVisible()
  await invalidProblem.click()
  await expect(page.getByTestId('inspector-node-gate')).toBeFocused()

  await expression.fill('context.fetch.output.statusCode === 200')
  await expect(page.getByText('Expression matches the runtime grammar.')).toBeVisible()
  await expect(invalidProblem).toHaveCount(0)

  // A delayed structural response for an older expression must not repopulate
  // Problems after a newer semantic edit has invalidated that request.
  await page.route('**/validate', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 350))
    await route.continue()
  })
  await expression.fill('process.exit()')
  const staleValidationResponse = page.waitForResponse((response) => response.url().endsWith('/validate'))
  await page.getByRole('button', { name: 'Run checks' }).click()
  await expression.fill('context.fetch.output.statusCode === 201')
  await staleValidationResponse
  await expect(invalidProblem).toHaveCount(0)

  // The same revision guard applies to AI review findings that complete after
  // the operator has already changed the graph.
  await page.getByRole('button', { name: /^AI Studio\b/ }).click()
  const staleReviewResponse = page.waitForResponse((response) => response.url().endsWith('/ai/review-workflow'))
  await page.getByRole('button', { name: 'Review this flow', exact: true }).click()
  await page.locator('.workflow-node').filter({ hasText: 'Branch rule' }).click()
  await page.getByLabel('Branch expression').fill('context.fetch.output.statusCode === 202')
  await staleReviewResponse
  await expect(page.getByTestId('authoring-problem-branch_needs_context')).toHaveCount(0)
  expect(browserErrors).toEqual([])
})
