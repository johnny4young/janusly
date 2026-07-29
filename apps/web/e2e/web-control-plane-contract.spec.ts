import { mkdir } from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { addCanvasStep, openWorkflowAiAction, openWorkspaceSection } from './_helpers/workspace-navigation'

const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR

const locales = {
  en: {
    workflows: 'Workflows',
    settings: 'Settings',
    hero: 'Describe the outcome. Janusly builds the flow.',
    connections: 'Connections',
    name: 'Connection name',
    secretValue: 'Secret value',
    add: 'Add connection',
    runs: 'Runs',
    authoringNodes: ['Call an API', 'AI prompt', 'Branch rule'],
    restoreDraft: 'Restore draft',
    added: (name: string) => `Credential ${name} added`,
  },
  es: {
    workflows: 'Flujos',
    settings: 'Configuración',
    hero: 'Describe el resultado. Janusly arma el flujo.',
    connections: 'Conexiones',
    name: 'Nombre de la conexión',
    secretValue: 'Valor del secreto',
    add: 'Añadir conexión',
    runs: 'Ejecuciones',
    authoringNodes: ['Llamar a una API', 'Prompt de IA', 'Regla de rama'],
    restoreDraft: 'Restaurar borrador',
    added: (name: string) => `Credencial ${name} agregada`,
  },
} as const

function installBrowserErrorGuards(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      errors.push(`${message.type()}: ${message.text()}`)
    }
  })
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  return errors
}

async function capture(surface: Locator, filename: string): Promise<void> {
  await expect(surface).toBeVisible()
  if (!EVIDENCE_DIR) return
  await mkdir(EVIDENCE_DIR, { recursive: true })
  await surface.screenshot({
    path: `${EVIDENCE_DIR}/${filename}.png`,
    animations: 'disabled',
    caret: 'hide',
  })
}

async function waitForAuthoringCanvas(
  page: Page,
  labels: readonly [string, string, string],
): Promise<void> {
  const canvas = page.locator('.workspace-canvas-wrapper')
  const nodes = canvas.locator('.workflow-node')
  if (await nodes.count() === 0) {
    for (const label of labels) {
      await addCanvasStep(page, label)
    }
  }
  await expect(nodes).toHaveCount(3)
  await expect(nodes.first()).toBeVisible()
  await expect.poll(async () => canvas.evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    const cards = [...element.querySelectorAll<HTMLElement>('.workflow-node')]
    return cards.length === 3 && cards.every((card) => {
      const rect = card.getBoundingClientRect()
      return rect.width > 0
        && rect.height > 0
        && rect.left >= bounds.left - 2
        && rect.right <= bounds.right + 2
        && rect.top >= bounds.top - 2
        && rect.bottom <= bounds.bottom + 2
    })
  })).toBe(true)
}

test('grouped control-plane panels and shared mutations remain bilingual', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1440, height: 1000 })
  const browserErrors = installBrowserErrorGuards(page)
  const stamp = Date.now()

  await page.addInitScript(() => {
    if (!window.localStorage.getItem('janusly:locale')) {
      window.localStorage.setItem('janusly:locale', 'en')
    }
  })
  await page.goto('/')
  await expect(page.getByText('dev-user')).toBeVisible()

  for (const locale of ['en', 'es'] as const) {
    if (locale === 'es') {
      await page.evaluate(() => {
        window.localStorage.setItem('janusly:locale', 'es')
        window.localStorage.setItem('janusly:activeTab', 'inspector')
      })
      await page.reload()
      await expect(page.getByText('dev-user')).toBeVisible()
      await page.getByRole('button', { name: locales.es.restoreDraft, exact: true }).click()
      await expect(page.locator('.run-input-backdrop')).toHaveCount(0)
    }

    const copy = locales[locale]
    await openWorkflowAiAction(page, copy.workflows)
    await expect(page.getByText(copy.hero, { exact: true })).toBeVisible()
    await waitForAuthoringCanvas(page, copy.authoringNodes)
    await capture(page.locator('.workspace-grid'), `web-${locale}-control-plane-authoring-default`)

    await openWorkspaceSection(page, copy.settings, copy.connections)
    await expect(page.getByRole('heading', { name: copy.connections, exact: true })).toBeVisible()

    const connectionName = `control_plane_${locale}_${stamp}`
    await page.getByLabel(copy.name, { exact: true }).fill(connectionName)
    // Managed storage is the default: the form asks for the secret value
    // itself, which the API envelope-encrypts. The legacy environment-reference
    // mode stays reachable through the storage selector above this field.
    await page.getByLabel(copy.secretValue, { exact: true }).fill(`control-plane-${locale}-${stamp}`)
    await page.getByRole('button', { name: copy.add, exact: true }).click()

    const successToast = page.getByText(copy.added(connectionName), { exact: true })
    await expect(successToast).toBeVisible()
    await expect(page.locator('.list-card').filter({ hasText: connectionName })).toBeVisible()
    await expect(successToast).not.toBeVisible({ timeout: 8_000 })

    const main = page.locator('.workspace-main')
    const overflow = await main.evaluate((element) => element.scrollWidth - element.clientWidth)
    expect(overflow).toBeLessThanOrEqual(2)
    await capture(main, `web-${locale}-control-plane-connection-result`)

    await openWorkspaceSection(
      page,
      locale === 'en' ? 'Activity' : 'Actividad',
      copy.runs,
    )
    await expect(page.getByRole('heading', { name: copy.runs, exact: true })).toBeVisible()
    await expect(page.getByTestId('activity-run-history')).toBeVisible()
  }

  expect(browserErrors).toEqual([])
})
