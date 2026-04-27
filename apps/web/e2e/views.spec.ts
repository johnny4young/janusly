import { expect, test } from '@playwright/test'

const views = [
  { button: 'AI Studio', text: 'Describe the outcome. Janusly builds the flow.' },
  { button: 'Flows', heading: 'Flows' },
  { button: 'Run timeline', heading: 'Run timeline' },
  { button: 'Step setup', heading: 'Step setup' },
  { button: 'Runs', heading: 'Runs' },
  { button: 'Team', heading: 'Team' },
  { button: 'Recipes', heading: 'Recipes' },
  { button: 'Tools', heading: 'Tools' },
  { button: 'Connections', heading: 'Connections' },
]

test('workspace views can be opened independently', async ({ page }) => {
  await page.goto('/')

  for (const view of views) {
    await page.getByRole('button', { name: view.button, exact: true }).click()

    if (view.heading) {
      await expect(page.getByRole('heading', { name: view.heading, exact: true })).toBeVisible()
    } else {
      await expect(page.getByText(view.text, { exact: true })).toBeVisible()
    }
  }
})

test('selecting a node opens quick setup controls', async ({ page }) => {
  await page.goto('/')
  await page.locator('.workflow-node').filter({ hasText: 'Call an API' }).click()

  await expect(page.getByRole('heading', { name: 'Step setup', exact: true })).toBeVisible()
  await expect(page.getByLabel('Step kind')).toHaveValue('http')
  await expect(page.getByLabel('Request URL')).toHaveValue('https://api.github.com')
  await expect(page.getByText('Advanced JSON')).toBeVisible()
})
