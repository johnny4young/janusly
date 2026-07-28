import type { Page } from '@playwright/test'

export async function openWorkspaceDestination(
  page: Page,
  destination: string,
): Promise<void> {
  await page.locator('.app-shell').waitFor({ state: 'visible' })

  const sidebar = page.locator('#workspace-sidebar')
  let destinationButton = sidebar.getByRole('button', {
    name: destination,
    exact: true,
  })
  if (
    await destinationButton.isVisible().catch(() => false)
    && await destinationButton.getAttribute('aria-current') === 'page'
  ) return

  const mobileTrigger = page.locator('.mobile-nav-trigger')
  if (!await destinationButton.isVisible().catch(() => false)) {
    await mobileTrigger.waitFor({ state: 'visible' })
    await mobileTrigger.click()
    await sidebar.locator('.builder-sidebar').waitFor({ state: 'visible' })
    destinationButton = sidebar.getByRole('button', {
      name: destination,
      exact: true,
    })
  }
  await destinationButton.waitFor({ state: 'visible' })
  await destinationButton.click()
}

export async function openWorkspaceSection(
  page: Page,
  destination: string,
  section: string,
): Promise<void> {
  const sectionNav = page.getByTestId('workspace-section-nav')
  let sectionButton = sectionNav.getByRole('button', {
    name: section,
    exact: true,
  })
  if (await sectionButton.count() === 0) {
    await openWorkspaceDestination(page, destination)
    sectionButton = sectionNav.getByRole('button', {
      name: section,
      exact: true,
    })
  }
  if (await sectionButton.getAttribute('aria-current') !== 'page') {
    await sectionButton.click()
  }
}
