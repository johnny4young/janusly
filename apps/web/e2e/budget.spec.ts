import { openWorkflowAiAction } from './_helpers/workspace-navigation'
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
  await page.route('**/recovery/home**', async route => {
    const scope = new URL(route.request().url()).searchParams.get('scope')
    const impact = {
      ledger: { status: 'unavailable' },
      wins: { status: 'unavailable' },
      queue: {
        status: 'ok',
        value: {
          counts: { total: 0, open: 0, replayed: 0, resolved: 0 },
          oldestOpen: null,
        },
      },
    }
    const metrics = {
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
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        scope: scope === 'impact' ? 'impact' : 'full',
        generatedAt: new Date().toISOString(),
        sections: scope === 'impact'
          ? impact
          : {
              metrics: { status: 'ok', value: metrics },
              clusters: {
                status: 'ok',
                value: {
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
                },
              },
              heatmap: { status: 'ok', value: { days: [], windowDays: 90 } },
              validation: { status: 'unavailable' },
              cases: { status: 'ok', value: { cases: [] } },
              ...impact,
            },
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
  await page.getByTestId('home-insights-toggle').click()

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
  await openWorkflowAiAction(page, 'Workflows')
  await page.getByRole('button', { name: 'Explain this flow', exact: true }).click()

  await expect(page.getByTestId('budget-blocked-banner')).toContainText('AI org budget exceeded')
  await page.getByTestId('budget-blocked-banner-cta').click()
  await expect(page.getByRole('heading', { name: 'Budget settings', exact: true })).toBeVisible()
  await expect(page.getByTestId('budget-blocked-banner')).toHaveCount(0)
})
