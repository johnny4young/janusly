import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { expectNoBlockingAccessibilityViolations } from './_helpers/accessibility'

const enabled = process.env.JANUSLY_LOCAL_CLEAN_INSTALL_E2E === '1'
const evidenceDir = process.env.JANUSLY_EVIDENCE_DIR
const email = process.env.JANUSLY_CLEAN_INSTALL_EMAIL ?? 'clean-install@identity.local'
const password = process.env.JANUSLY_CLEAN_INSTALL_PASSWORD ?? 'Clean-install-2026!'

function guardBrowserErrors(page: Page) {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname
    if (response.status() >= 400) errors.push(`${response.status()} ${path}`)
  })
  return errors
}

async function capture(page: Page, name: string) {
  if (!evidenceDir) return
  await mkdir(evidenceDir, { recursive: true })
  await page.screenshot({ path: `${evidenceDir}/${name}.png`, fullPage: true })
}

async function expectHealthySurface(page: Page, context: string) {
  await expectNoBlockingAccessibilityViolations(page, context)
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(2)
}

async function setLocale(page: Page, locale: 'en' | 'es') {
  await page.evaluate((value) => window.localStorage.setItem('janusly:locale', value), locale)
  await page.reload()
}

test('a clean installation starts at real login and creates only the first identity', async ({ page }) => {
  test.setTimeout(120_000)
  test.skip(!enabled, 'requires a freshly reset local identity stack')
  const browserErrors = guardBrowserErrors(page)
  await page.addInitScript(() => {
    if (!window.localStorage.getItem('janusly:locale')) {
      window.localStorage.setItem('janusly:locale', 'en')
    }
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
  await expectHealthySurface(page, 'clean-install login in English')
  await capture(page, 'clean-install-login-en')

  await setLocale(page, 'es')
  await expect(page.getByRole('heading', { name: 'Bienvenido de nuevo' })).toBeVisible()
  await expectHealthySurface(page, 'clean-install login in Spanish')
  await capture(page, 'clean-install-login-es')

  await setLocale(page, 'en')
  await page.getByRole('button', { name: 'Need an account? Sign up' }).click()
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign up', exact: true }).click()

  await expect(page.getByRole('heading', { name: 'Set up your workspace' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Your organizations' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Pending invitations' })).toHaveCount(0)
  await expect(page.getByLabel('Your name')).toHaveAttribute('placeholder', 'e.g. Ada Operator')
  await expect(page.getByLabel('Organization name')).toHaveAttribute('placeholder', 'e.g. Acme Operations')
  await expectHealthySurface(page, 'clean-install onboarding in English')
  await capture(page, 'clean-install-onboarding-en')

  await setLocale(page, 'es')
  await expect(page.getByRole('heading', { name: 'Configura tu espacio de trabajo' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Tus organizaciones' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Invitaciones pendientes' })).toHaveCount(0)
  await expect(page.getByLabel('Tu nombre')).toHaveAttribute('placeholder', 'p. ej. Ada Operadora')
  await expect(page.getByLabel('Nombre de la organización')).toHaveAttribute(
    'placeholder',
    'p. ej. Operaciones Acme',
  )
  await expectHealthySurface(page, 'clean-install onboarding in Spanish')
  await capture(page, 'clean-install-onboarding-es')

  expect(browserErrors).toEqual([])
})
