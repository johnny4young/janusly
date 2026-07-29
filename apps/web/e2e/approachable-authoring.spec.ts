import { mkdir } from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'

import {
  openCanvasStepPicker,
  openWorkspaceSection,
} from './_helpers/workspace-navigation'

const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR

const locales = {
  en: {
    workflows: 'Workflows',
    allWorkflows: 'All workflows',
    build: 'Build',
    newWorkflow: 'New workflow',
    creationTitle: 'How do you want to start?',
    creationChoices: ['Describe it', 'Start blank', 'Use a template'],
    addStep: 'Add step',
    searchSteps: 'Search steps…',
    httpStep: 'Call an API',
    httpUrl: 'Request URL',
    branchStep: 'Branch rule',
    branchExpression: 'Branch expression',
    stepScope: 'Step',
  },
  es: {
    workflows: 'Flujos',
    allWorkflows: 'Todos los flujos',
    build: 'Crear',
    newWorkflow: 'Nuevo flujo',
    creationTitle: '¿Cómo quieres empezar?',
    creationChoices: ['Descríbelo', 'Empezar vacío', 'Usar una plantilla'],
    addStep: 'Agregar paso',
    searchSteps: 'Buscar pasos…',
    httpStep: 'Llamar a una API',
    httpUrl: 'URL de la petición',
    branchStep: 'Regla de rama',
    branchExpression: 'Expresión de rama',
    stepScope: 'Paso',
  },
} as const

function installBrowserErrorGuards(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  return errors
}

async function captureViewport(page: Page, filename: string): Promise<void> {
  if (!EVIDENCE_DIR) return
  await mkdir(EVIDENCE_DIR, { recursive: true })
  await page.screenshot({
    path: `${EVIDENCE_DIR}/${filename}.png`,
    animations: 'disabled',
    caret: 'hide',
  })
}

async function expectReadablePrimaryText(locator: Locator): Promise<void> {
  const sizes = await locator.evaluateAll((elements) => elements
    .filter((element) => {
      const style = getComputedStyle(element)
      return style.display !== 'none' && style.visibility !== 'hidden'
    })
    .map((element) => ({
      text: element.textContent?.trim() ?? '',
      pixels: Number.parseFloat(getComputedStyle(element).fontSize),
    }))
    .filter(({ text }) => text.length > 0))
  expect(sizes.length).toBeGreaterThan(0)
  expect(sizes.filter(({ pixels }) => pixels < 12)).toEqual([])
}

test.describe.configure({ mode: 'serial' })

for (const locale of ['en', 'es'] as const) {
  const copy = locales[locale]

  test(`${locale} creates and configures a two-step workflow from one approachable builder`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 })
    const browserErrors = installBrowserErrorGuards(page)
    const orgId = `approachable-authoring-${locale}-${Date.now()}`
    await page.addInitScript(({ activeOrg, selectedLocale }) => {
      window.localStorage.setItem('janusly:activeOrg', activeOrg)
      window.localStorage.setItem('janusly:locale', selectedLocale)
      window.localStorage.removeItem('janusly:draft')
    }, { activeOrg: orgId, selectedLocale: locale })

    await page.goto('/')
    await openWorkspaceSection(page, copy.workflows, copy.allWorkflows)
    await page.locator('button[aria-controls="workflow-creation-choices"]').click()

    const creation = page.getByTestId('workflow-creation-choices')
    await expect(creation.getByRole('heading', { name: copy.creationTitle, exact: true })).toBeVisible()
    await expect(creation.locator('.workflow-creation__choices > button')).toHaveCount(3)
    for (const choice of copy.creationChoices) {
      await expect(creation.getByRole('button', { name: new RegExp(`^${choice}`) })).toBeVisible()
    }
    await expectReadablePrimaryText(creation.locator('.workflow-creation__choice strong, .workflow-creation__choice small'))
    await captureViewport(page, `web-${locale}-workflow-creation-paths`)

    const startBlank = creation.getByRole('button', {
      name: new RegExp(`^${copy.creationChoices[1]}`),
    })
    await startBlank.focus()
    await page.keyboard.press('Enter')

    await expect(page.getByRole('heading', { name: copy.build, exact: true })).toBeVisible()
    await expect(page.getByTestId('canvas-empty')).toBeVisible()
    await expect(page.locator('.canvas-step-picker')).toHaveCount(1)
    await expectReadablePrimaryText(page.locator('.authoring-scope-nav button'))

    await page.getByRole('button', { name: copy.addStep, exact: true }).click()
    const search = page.getByRole('searchbox', { name: copy.searchSteps, exact: true })
    await search.fill(copy.httpStep)
    await page.keyboard.press('Tab')
    await page.keyboard.press('Enter')

    const canvas = page.locator('.canvas-frame[data-mode="author"]')
    await expect(canvas.locator('.react-flow__node')).toHaveCount(1)
    const requestUrl = page.getByLabel(copy.httpUrl, { exact: true })
    await expect(requestUrl).toBeVisible()
    await requestUrl.fill('https://api.example.com/orders')

    await openCanvasStepPicker(page)
    await search.fill(copy.branchStep)
    await page.keyboard.press('Tab')
    await page.keyboard.press('Enter')

    await expect(canvas.locator('.react-flow__node')).toHaveCount(2)
    await expect(page.getByRole('button', { name: copy.stepScope, exact: true })).toHaveAttribute('aria-current', 'page')
    const branchExpression = page.getByLabel(copy.branchExpression, { exact: true })
    await expect(branchExpression).toBeVisible()
    await branchExpression.fill('context.input.approved === true')

    const canvasBounds = await page.getByTestId('workspace-canvas-wrapper').boundingBox()
    const panelBounds = await page.locator('.workspace-panel').boundingBox()
    if (!canvasBounds || !panelBounds) throw new Error('Authoring workspace columns are not measurable')
    const usableWidth = canvasBounds.width + panelBounds.width
    expect(canvasBounds.width / usableWidth).toBeGreaterThanOrEqual(0.6)

    const horizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )
    expect(horizontalOverflow).toBeLessThanOrEqual(2)
    await captureViewport(page, `web-${locale}-approachable-builder`)

    await page.setViewportSize({ width: 1024, height: 768 })
    await expect(page.locator('.canvas-step-picker')).toBeVisible()
    await expect(page.locator('.workspace-panel')).toBeVisible()
    const narrowOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )
    expect(narrowOverflow).toBeLessThanOrEqual(2)
    await captureViewport(page, `web-${locale}-approachable-builder-narrow`)

    expect(browserErrors).toEqual([])
  })
}
