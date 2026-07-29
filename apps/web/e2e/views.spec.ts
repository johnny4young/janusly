import { addCanvasStep, openWorkflowAiAction, openWorkspaceSection } from './_helpers/workspace-navigation'
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
  { destination: 'Home', selector: '.we-recovery-center-hero .section-kicker', text: 'Recovery Center' },
  { destination: 'Workflows', section: 'Build', text: 'Describe the outcome. Janusly builds the flow.', ai: true },
  { destination: 'Workflows', section: 'All workflows', heading: 'Flows' },
  { destination: 'Workflows', section: 'Build', heading: 'Build' },
  { destination: 'Activity', heading: 'Activity' },
  { destination: 'Settings', section: 'Team', heading: 'Team' },
  { destination: 'Workflows', section: 'Templates', heading: 'Templates' },
  { destination: 'Settings', section: 'Tools', heading: 'Tools' },
  { destination: 'Settings', section: 'Connections', heading: 'Connections' },
]

test('workspace views can be opened independently', async ({ page }) => {
  const browserErrors = installConsoleErrorGuards(page)

  await page.goto('/')

  for (const view of views) {
    if (view.ai) {
      await openWorkflowAiAction(page, 'Workflows')
    } else if (view.section) {
      await openWorkspaceSection(page, view.destination, view.section)
    } else {
      await page.locator('.builder-sidebar').getByRole('button', {
        name: view.destination,
        exact: true,
      }).click()
    }

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

test('expert multi-agent view remains directly accessible from the command palette', async ({ page }) => {
  const browserErrors = installConsoleErrorGuards(page)
  await page.goto('/')

  await page.getByRole('button', { name: 'Open quick-jump command palette' }).click()
  const palette = page.getByTestId('command-palette')
  await expect(palette).toBeVisible()
  await palette.getByRole('combobox').fill('multi-agent')
  await palette.getByRole('option', { name: 'Go to Multi-agent timeline' }).click()

  await expect(page.getByRole('heading', { name: 'Multi-agent timeline', exact: true })).toBeVisible()
  expect(browserErrors).toEqual([])
})

test('selecting a node opens quick setup controls', async ({ page }) => {
  await page.goto('/')
  await openWorkspaceSection(page, 'Workflows', 'Build')
  await addCanvasStep(page, 'Call an API')

  await expect(page.getByRole('heading', { name: 'Build', exact: true })).toBeVisible()
  await expect(page.getByLabel('Step kind')).toHaveValue('http')
  await expect(page.getByLabel('Request URL')).toHaveValue('https://api.github.com')
  await expect(page.getByText('Advanced JSON')).toBeVisible()
})
