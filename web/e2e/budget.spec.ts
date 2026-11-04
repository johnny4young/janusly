import { openReports, openWorkflowAiAction } from './_helpers/workspace-navigation'
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

test('Reports AI spend tile opens budget settings', async ({ page }) => {
  await page.route('**/billing/budget**', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ...budgetEnvelope, allowed: true, exceededAt: 'org', resolvedScope: 'org' }),
    })
  })

  await openReports(page)

  await expect(page.getByTestId('recovery-center-tile-budget')).toContainText('AI spend')
  await expect(page.getByTestId('recovery-center-budget-bar')).toContainText('$12.00 / $10.00')
  await page.getByTestId('recovery-center-budget-open-settings').click()
  await expect(page.getByRole('heading', { name: 'Budget settings', exact: true })).toBeVisible()
})

test('Home raises an AI budget banner only at the warning threshold', async ({ page }) => {
  let envelope = { ...budgetEnvelope, monthlyUsdSpent: 1, warningThresholdCrossed: false }
  await page.route('**/billing/budget**', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(envelope) })
  })

  const budgetRead = page.waitForResponse('**/billing/budget**')
  await page.goto('/')
  await budgetRead
  await expect(page.getByTestId('home-today')).toBeVisible()
  await expect(page.getByTestId('home-budget-banner')).toHaveCount(0)

  envelope = budgetEnvelope
  await page.reload()
  await expect(page.getByTestId('home-budget-banner')).toContainText('$12.00 / $10.00')
  await page.getByTestId('home-budget-banner-open-settings').click()
  await expect(page.getByRole('heading', { name: 'Budget settings', exact: true })).toBeVisible()
})

test('AI Studio budget block shows a dismissible Settings CTA', async ({ page }) => {
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
