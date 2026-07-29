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

export async function openWorkflowAiAction(
  page: Page,
  destination: 'Workflows' | 'Flujos',
  action: 'generate' | 'explain' | 'review' | 'fix' = 'generate',
): Promise<void> {
  const spanish = destination === 'Flujos'
  await page.locator('.app-shell').waitFor({ state: 'visible' })
  const copilot = page.locator('.copilot-hero')
  const directLabels = spanish
    ? {
        generate: 'Crear borrador',
        explain: 'Explicar este flujo',
        review: 'Revisar este flujo',
        fix: 'Sugerir una corrección',
      }
    : {
        generate: 'Draft flow',
        explain: 'Explain this flow',
        review: 'Review this flow',
        fix: 'Suggest a fix',
      }
  if (await copilot.isVisible().catch(() => false)) {
    if (action !== 'generate') {
      await page.getByRole('button', { name: directLabels[action], exact: true }).click()
    }
    return
  }

  await openWorkspaceSection(page, destination, spanish ? 'Crear' : 'Build')
  const labels = spanish
    ? { generate: 'Generar', explain: 'Explicar', review: 'Revisar', fix: 'Corregir' }
    : { generate: 'Generate', explain: 'Explain', review: 'Review', fix: 'Fix' }
  await page
    .locator('.workspace-panel')
    .getByRole('button', { name: labels[action], exact: true })
    .click()
}

export async function openCanvasStepPicker(page: Page): Promise<void> {
  const picker = page.locator('.canvas-step-picker')
  const menu = picker.locator('.canvas-step-picker__menu')
  if (!await menu.isVisible().catch(() => false)) {
    await picker.locator('.canvas-step-picker__trigger').click()
  }
  await menu.waitFor({ state: 'visible' })
}

export async function addCanvasStep(page: Page, label: string): Promise<void> {
  await openCanvasStepPicker(page)
  await page
    .locator('.canvas-step-picker__menu')
    .getByRole('button', { name: new RegExp(`^${escapeRegex(label)}(?:\\s|$)`) })
    .click()
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
