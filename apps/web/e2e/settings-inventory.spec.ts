import { mkdir } from 'node:fs/promises'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Locator, type Page } from '@playwright/test'

import { openWorkspaceSection } from './_helpers/workspace-navigation'

const API_URL = process.env.E2E_API_URL ?? 'http://127.0.0.1:3001'
const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

type Locale = 'en' | 'es'

const copy = {
  en: {
    settings: 'Settings',
    workspace: 'Workspace',
    connections: 'Connections',
    indexTitle: 'Find a setting',
    search: 'Find provider, credential, member, alert, queue…',
    queue: 'queue',
    infrastructure: 'Infrastructure',
    connectionSearch: 'Search by name, type, or owner…',
    create: 'Add connection',
    createTitle: 'Register a protected secret',
    secret: 'Secret value',
  },
  es: {
    settings: 'Configuración',
    workspace: 'Espacio de trabajo',
    connections: 'Conexiones',
    indexTitle: 'Buscar configuración',
    search: 'Buscar proveedor, credencial, miembro, alerta, cola…',
    queue: 'cola',
    infrastructure: 'Infraestructura',
    connectionSearch: 'Buscar por nombre, tipo o propietario…',
    create: 'Añadir conexión',
    createTitle: 'Registrar un secreto protegido',
    secret: 'Valor del secreto',
  },
} as const

function headers(orgId: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-org-id': orgId,
    'x-user-id': 'settings-owner@example.com',
  }
}

async function createCredential(
  page: Page,
  orgId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const response = await page.request.post(`${API_URL}/credentials`, {
    headers: headers(orgId),
    data: body,
  })
  if (!response.ok()) {
    throw new Error(`Credential seed failed: ${response.status()} ${await response.text()}`)
  }
}

async function capture(surface: Locator, name: string): Promise<void> {
  await expect(surface).toBeVisible()
  if (!EVIDENCE_DIR) return
  await mkdir(EVIDENCE_DIR, { recursive: true })
  await surface.screenshot({
    path: `${EVIDENCE_DIR}/${name}.png`,
    animations: 'disabled',
    caret: 'hide',
  })
}

async function expectAccessible(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()
  expect(
    results.violations.filter((violation) =>
      violation.impact === 'critical' || violation.impact === 'serious'),
  ).toEqual([])
}

async function hideUnrelatedOverlays(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const selector of ['.toast-stack', '.we-onboarding-banner', '.we-budget-banner']) {
      for (const element of document.querySelectorAll<HTMLElement>(selector)) {
        element.style.display = 'none'
      }
    }
  })
}

test('a fresh workspace shows a truthful Connections empty state', async ({ page }) => {
  test.setTimeout(45_000)
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 1280, height: 720 })

  const orgId = `settings-empty-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await page.addInitScript((activeOrg) => {
    window.localStorage.setItem('janusly:activeOrg', activeOrg)
    window.localStorage.setItem('janusly:locale', 'en')
    window.localStorage.setItem('janusly:operations:section', 'overview')
  }, orgId)
  await page.goto('/')
  await hideUnrelatedOverlays(page)

  await openWorkspaceSection(page, copy.en.settings, copy.en.workspace)
  await page.getByTestId('settings-index-integrations').click()
  await page.locator('.we-operations-page__content')
    .getByRole('button', { name: copy.en.connections, exact: true })
    .click()
  await expect(
    page.getByRole('region', { name: copy.en.connections })
      .getByText('No connections yet', { exact: true }),
  ).toBeVisible()
  await expect(page.getByTestId('connections-virtual-list')).toHaveCount(0)
  await expectAccessible(page)
  await capture(page.locator('.app-shell'), 'web-en-connections-empty')

  expect(errors).toEqual([])
})

test('Settings and Connections are inventory-first in English and Spanish', async ({ page }) => {
  test.setTimeout(90_000)
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 1280, height: 720 })

  for (const locale of ['en', 'es'] as const satisfies readonly Locale[]) {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const orgId = `settings-inventory-${locale}-${stamp}`
    const managedName = `pagerduty-${stamp}`
    const environmentName = `slack-${stamp}`
    await createCredential(page, orgId, {
      name: managedName,
      kind: 'pagerduty_api_token',
      secretValue: `pd-${stamp}`,
      expiresAt: '2099-08-01T00:00:00.000Z',
    })
    await createCredential(page, orgId, {
      name: environmentName,
      kind: 'slack_webhook',
      secretRef: `JANUSLY_E2E_MISSING_${stamp.replaceAll('-', '_').toUpperCase()}`,
    })

    await page.addInitScript(({ activeOrg, selectedLocale }) => {
      window.localStorage.setItem('janusly:activeOrg', activeOrg)
      window.localStorage.setItem('janusly:locale', selectedLocale)
      window.localStorage.setItem('janusly:operations:section', 'overview')
    }, { activeOrg: orgId, selectedLocale: locale })
    await page.goto('/')
    await hideUnrelatedOverlays(page)

    await openWorkspaceSection(page, copy[locale].settings, copy[locale].workspace)
    await expect(page.getByRole('heading', { name: copy[locale].indexTitle })).toBeVisible()
    const settingsSearch = page.getByLabel(copy[locale].search)
    await settingsSearch.fill(copy[locale].queue)
    await expect(page.getByTestId('settings-index-infrastructure')).toContainText(
      copy[locale].infrastructure,
    )
    await expect(page.getByTestId('settings-index-reliability')).toHaveCount(0)
    await settingsSearch.fill('')
    await expectAccessible(page)
    await capture(page.locator('.app-shell'), `web-${locale}-settings-index`)

    await page.getByTestId('settings-index-integrations').click()
    await page.locator('.we-operations-page__content')
      .getByRole('button', { name: copy[locale].connections, exact: true })
      .click()
    const inventory = page.getByTestId('connections-virtual-list')
    await expect(inventory).toContainText(managedName)
    await expect(inventory).toContainText(environmentName)
    await expect(inventory).toContainText('settings-owner@example.com')
    await expect(page.getByLabel(copy[locale].secret)).toHaveCount(0)

    const connectionSearch = page.getByLabel(copy[locale].connectionSearch)
    await connectionSearch.fill('pagerduty')
    await expect(inventory).toContainText(managedName)
    await expect(inventory).not.toContainText(environmentName)
    await connectionSearch.fill('')
    await expectAccessible(page)
    await capture(page.locator('.app-shell'), `web-${locale}-connections-inventory`)

    await page.getByRole('button', { name: copy[locale].create }).first().click()
    const dialog = page.getByRole('dialog', { name: copy[locale].createTitle })
    await expect(dialog).toBeVisible()
    await expect(page.getByLabel(copy[locale].secret)).toHaveAttribute('type', 'password')
    await expect(page.getByLabel(locale === 'en' ? 'Connection name' : 'Nombre de la conexión')).toBeFocused()
    await expectAccessible(page)
    await capture(dialog, `web-${locale}-connection-create`)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    if (locale === 'es') {
      await page.setViewportSize({ width: 390, height: 844 })
      const shell = page.locator('.app-shell')
      const overflow = await shell.evaluate((element) => element.scrollWidth - element.clientWidth)
      expect(overflow).toBeLessThanOrEqual(1)
      await capture(shell, 'web-es-connections-mobile')
    }
  }

  expect(consoleErrors).toEqual([])
  expect(pageErrors).toEqual([])
})
