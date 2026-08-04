import type { Page } from '@playwright/test'

export async function openWorkspaceDestination(
  page: Page,
  destination: string,
  force = false,
): Promise<void> {
  await page.locator('.app-shell').waitFor({ state: 'visible' })

  const sidebar = page.locator('#workspace-sidebar')
  let destinationButton = sidebar.getByRole('button', {
    name: destination,
    exact: true,
  })
  if (
    !force &&
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
    if (
      await sectionButton.count() === 0
      && (destination === 'Activity' || destination === 'Actividad')
    ) {
      if (section === 'Recover' || section === 'Recuperar') {
        if (await page.getByTestId('recovery-queue').isVisible().catch(() => false)) return
        await openWorkspaceDestination(page, destination, true)
        const recoveryTools = page.getByTestId('activity-open-recovery-tools')
        await recoveryTools.waitFor({ state: 'visible' })
        await recoveryTools.click()
        await page.getByTestId('recovery-queue').waitFor({ state: 'visible' })
      } else if (section === 'Runs' || section === 'Ejecuciones') {
        if (await page.getByTestId('activity-run-history').isVisible().catch(() => false)) return
        await openWorkspaceDestination(page, destination, true)
        const runHistory = page.getByTestId('activity-open-run-history')
        await runHistory.waitFor({ state: 'visible' })
        await runHistory.click()
        await page.getByTestId('activity-run-history').waitFor({ state: 'visible' })
      }
      return
    }
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
  const aiStudio = page.locator('.aiStudio-hero')
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
  if (await aiStudio.isVisible().catch(() => false)) {
    if (action !== 'generate') {
      await page.getByRole('button', { name: directLabels[action], exact: true }).click()
    }
    return
  }

  await openWorkspaceSection(page, destination, spanish ? 'Crear' : 'Build')
  if (await aiStudio.isVisible().catch(() => false)) {
    if (action !== 'generate') {
      await page.getByRole('button', { name: directLabels[action], exact: true }).click()
    }
    return
  }
  const labels = spanish
    ? { generate: 'Generar', explain: 'Explicar', review: 'Revisar', fix: 'Corregir' }
    : { generate: 'Generate', explain: 'Explain', review: 'Review', fix: 'Fix' }
  await page
    .locator('.workspace-panel')
    .getByRole('button', { name: labels[action], exact: true })
    .click()
}

export async function openWorkflowOperation(page: Page, label: string): Promise<void> {
  const operation = page
    .locator('.authoring-workflow-tools')
    .getByRole('button', { name: label, exact: true })
  await operation.waitFor({ state: 'visible' })
  if (await operation.getAttribute('aria-pressed') !== 'true') {
    await operation.click()
  }
}

export async function openWorkflowCreation(page: Page): Promise<void> {
  const trigger = page.locator('button[aria-controls="workflow-creation-choices"]')
  await trigger.waitFor({ state: 'visible' })
  if (await trigger.getAttribute('aria-expanded') !== 'true') {
    await trigger.click()
  }
  await page.getByTestId('workflow-creation-choices').waitFor({ state: 'visible' })
}

export async function openRecoveryAutomation(page: Page): Promise<void> {
  const automation = page.getByTestId('recovery-automation')
  const toggle = page.getByTestId('recovery-automation-toggle')
  await toggle.waitFor({ state: 'visible' })
  if (await toggle.getAttribute('aria-expanded') !== 'true') {
    await toggle.click()
  }
  await automation.locator('.we-recovery-automation__content').waitFor({ state: 'visible' })
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
