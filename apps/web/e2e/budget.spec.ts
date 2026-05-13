import { expect, test } from '@playwright/test'

const budgetEnvelope = {
  allowed: false,
  monthlyUsdSpent: 12,
  monthlyUsdLimit: 10,
  policy: 'block',
  warningPercent: 80,
  warningThresholdCrossed: true,
  exceededAt: 'org',
  resolvedScope: 'org',
}

test('Recovery Center budget tile opens budget settings', async ({ page }) => {
  await page.route('**/recovery/metrics**', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        successRate: { value: 92, display: '92%', severity: 'healthy', rationale: 'Recent runs are mostly healthy.' },
        mttr: { value: 180, display: '3m', severity: 'healthy', rationale: 'Fast recovery.' },
        p95Latency: { value: 4000, display: '4.0s', severity: 'healthy', rationale: 'Recent p95.' },
        approvalsPending: { value: 0, display: '0', severity: 'healthy', rationale: 'No human action waiting.' },
        replayRate: { value: 80, display: '80%', severity: 'healthy', rationale: 'Recent replays.' },
        costThisWindow: {
          value: 12,
          display: '$12.00',
          severity: 'neutral',
          rationale: 'Across AI providers.',
          providers: [],
        },
        windowDays: 30,
        terminalRuns: 3,
      }),
    })
  })
  await page.route('**/dlq/clusters**', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        clusters: [{
          signature: 'http_500',
          label: 'HTTP 500',
          frequency: 2,
          affectedWorkflows: 1,
          latestAt: new Date().toISOString(),
          sampleDeadLetterIds: [],
        }],
        totalSamples: 2,
        windowDays: 30,
      }),
    })
  })
  await page.route('**/billing/budget**', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...budgetEnvelope, allowed: true, exceededAt: 'org', resolvedScope: 'org' }),
    })
  })

  await page.goto('/')

  await expect(page.getByTestId('recovery-center-tile-budget')).toContainText('AI budget')
  await expect(page.getByTestId('recovery-center-budget-bar')).toContainText('$12.00 / $10.00')
  await page.getByTestId('recovery-center-budget-open-settings').click()
  await expect(page.getByRole('heading', { name: 'Budget settings', exact: true })).toBeVisible()
})

test('AI Studio budget block shows a dismissible Operations CTA', async ({ page }) => {
  await page.route('**/ai/explain-workflow', async route => {
    await route.fulfill({
      status: 402,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'budget_exceeded', budget: budgetEnvelope }),
    })
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'AI Studio', exact: true }).click()
  await page.getByRole('button', { name: 'Explain this flow', exact: true }).click()

  await expect(page.getByTestId('budget-blocked-banner')).toContainText('AI org budget exceeded')
  await page.getByTestId('budget-blocked-banner-cta').click()
  await expect(page.getByRole('heading', { name: 'Budget settings', exact: true })).toBeVisible()
  await expect(page.getByTestId('budget-blocked-banner')).toHaveCount(0)
})
