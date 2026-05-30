import { expect, test, type Page } from '@playwright/test'

function installConsoleErrorGuards(page: Page) {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

const views = [
  { button: /^Home\b/, selector: '.we-recovery-center-hero .section-kicker', text: 'Recovery Center' },
  { button: /^AI Studio\b/, text: 'Describe the outcome. Janusly builds the flow.' },
  { button: 'Flows', heading: 'Flows' },
  { button: 'Multi-agent timeline', heading: 'Multi-agent timeline' },
  { button: 'Step setup', heading: 'Step setup' },
  { button: 'Runs', heading: 'Runs' },
  { button: 'Team', heading: 'Team' },
  { button: 'Recipes', heading: 'Recipes' },
  { button: 'Packs', heading: 'Solution Packs' },
  { button: 'Tools', heading: 'Tools' },
  { button: 'Connections', heading: 'Connections' },
]

test('workspace views can be opened independently', async ({ page }) => {
  const browserErrors = installConsoleErrorGuards(page)

  await page.goto('/')

  // No explicit group expansion needed — the three sidebar groups
  // (Pinned / Build / Run) are all default-open on a fresh context,
  // and every nav item this spec touches lives under one of them.

  for (const view of views) {
    const button =
      typeof view.button === 'string'
        ? page.getByRole('button', { name: view.button, exact: true })
        : page.getByRole('button', { name: view.button })
    await button.click()

    if (view.heading) {
      await expect(page.getByRole('heading', { name: view.heading, exact: true })).toBeVisible()
    } else {
      const target = view.selector
        ? page.locator(view.selector, { hasText: view.text })
        : page.getByText(view.text, { exact: true })
      await expect(target).toBeVisible()
    }
  }

  expect(browserErrors).toEqual([])
})

test('selecting a node opens quick setup controls', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: /^AI Studio\b/ }).click()
  await page.locator('.workflow-node').filter({ hasText: 'Call an API' }).click()

  await expect(page.getByRole('heading', { name: 'Step setup', exact: true })).toBeVisible()
  await expect(page.getByLabel('Step kind')).toHaveValue('http')
  await expect(page.getByLabel('Request URL')).toHaveValue('https://api.github.com')
  await expect(page.getByText('Advanced JSON')).toBeVisible()
})
