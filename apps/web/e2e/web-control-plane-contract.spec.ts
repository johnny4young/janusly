import { mkdir } from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'

const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR

const locales = {
  en: {
    aiStudio: 'AI Studio',
    hero: 'Describe the outcome. Janusly builds the flow.',
    connections: 'Connections',
    name: 'Connection name',
    env: 'Environment variable',
    add: 'Add connection',
    runs: 'Runs',
    added: (name: string) => `Credential ${name} added`,
  },
  es: {
    aiStudio: 'AI Studio',
    hero: 'Describe el resultado. Janusly arma el flujo.',
    connections: 'Conexiones',
    name: 'Nombre de la conexión',
    env: 'Variable de entorno',
    add: 'Añadir conexión',
    runs: 'Ejecuciones',
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

async function waitForAuthoringCanvas(page: Page): Promise<void> {
  const canvas = page.locator('.workspace-canvas-wrapper')
  const nodes = canvas.locator('.workflow-node')
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
      await page.evaluate(() => window.localStorage.setItem('janusly:locale', 'es'))
      await page.reload()
      await expect(page.getByText('dev-user')).toBeVisible()
    }

    const copy = locales[locale]
    await page.getByRole('button', { name: new RegExp(`^${copy.aiStudio}\\b`) }).click()
    await expect(page.getByText(copy.hero, { exact: true })).toBeVisible()
    await waitForAuthoringCanvas(page)
    await capture(page.locator('.workspace-grid'), `web-${locale}-control-plane-authoring-default`)

    await page.getByRole('button', { name: copy.connections, exact: true }).click()
    await expect(page.getByRole('heading', { name: copy.connections, exact: true })).toBeVisible()

    const connectionName = `control_plane_${locale}_${stamp}`
    await page.getByLabel(copy.name, { exact: true }).fill(connectionName)
    await page.getByLabel(copy.env, { exact: true }).fill(`CONTROL_PLANE_${locale.toUpperCase()}_${stamp}`)
    await page.getByRole('button', { name: copy.add, exact: true }).click()

    const successToast = page.getByText(copy.added(connectionName), { exact: true })
    await expect(successToast).toBeVisible()
    await expect(page.locator('.list-card').filter({ hasText: connectionName })).toBeVisible()
    await expect(successToast).not.toBeVisible({ timeout: 8_000 })

    const main = page.locator('.workspace-main')
    const overflow = await main.evaluate((element) => element.scrollWidth - element.clientWidth)
    expect(overflow).toBeLessThanOrEqual(2)
    await capture(main, `web-${locale}-control-plane-connection-result`)

    await page.getByRole('button', { name: copy.runs, exact: true }).click()
    await expect(page.getByRole('heading', { name: copy.runs, exact: true })).toBeVisible()
  }

  expect(browserErrors).toEqual([])
})
