import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

const enabled = process.env.JANUSLY_LOCAL_IDENTITY_E2E === '1'
const persistenceOnly = process.env.JANUSLY_LOCAL_IDENTITY_PERSISTENCE_ONLY === '1'
const evidenceDir = process.env.JANUSLY_EVIDENCE_DIR
const ownerEmail = process.env.JANUSLY_IDENTITY_OWNER_EMAIL ?? 'owner@identity.local'
const memberEmail = process.env.JANUSLY_IDENTITY_MEMBER_EMAIL ?? 'member@identity.local'
const password = process.env.JANUSLY_IDENTITY_PASSWORD ?? 'Local-identity-2026!'
const organizationName = process.env.JANUSLY_IDENTITY_ORG_NAME ?? 'Identity Lab'
const secondaryOrganizationName = `${organizationName} Secondary`

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

async function signUp(page: Page, email: string) {
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
  await page.getByRole('button', { name: 'Need an account? Sign up' }).click()
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible()
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign up', exact: true }).click()
}

async function signIn(page: Page, email: string) {
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Log in', exact: true }).click()
}

async function openUserMenu(page: Page) {
  await page.getByRole('button', { name: 'Open user menu' }).click()
  await expect(page.getByRole('menu')).toBeVisible()
}

async function signOut(page: Page) {
  await openUserMenu(page)
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
}

async function openTeam(page: Page) {
  await openUserMenu(page)
  await page.getByRole('button', { name: 'Team & access' }).click()
  await expect(page.getByText('Invite member')).toBeVisible()
}

test('real local identity covers onboarding, organizations, roles, and truthful permission UX', async ({ page }) => {
  test.setTimeout(120_000)
  test.skip(!enabled || persistenceOnly, 'requires the persistent local Supabase identity profile')
  const browserErrors = guardBrowserErrors(page)
  await page.addInitScript(() => window.localStorage.setItem('janusly:locale', 'en'))

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
  await expect(page.locator('.auth-card__brand')).toHaveCSS('display', 'flex')
  await expect(page.locator('.auth-card__brand > div')).toHaveCSS('flex-direction', 'column')
  await capture(page, 'identity-login')
  await signUp(page, ownerEmail)
  await expect(page.getByRole('heading', { name: 'Set up your workspace' })).toBeVisible()
  await capture(page, 'identity-workspace-onboarding')
  await page.getByLabel('Your name').fill('Local Owner')
  await page.getByLabel('Organization name').fill(organizationName)
  await page.getByRole('button', { name: 'Create workspace' }).click()
  await expect(page.getByRole('button', { name: 'Open user menu' })).toBeVisible()
  await expect(page.locator('.bottom-status-bar')).toContainText(organizationName)
  await capture(page, 'identity-owner-workspace')

  await openUserMenu(page)
  await page.getByRole('button', { name: 'New workspace · invite' }).click()
  await page.getByLabel('Organization name').fill(secondaryOrganizationName)
  await page.getByRole('button', { name: 'Create workspace' }).click()
  await expect(page.locator('.bottom-status-bar')).toContainText(secondaryOrganizationName)
  await openUserMenu(page)
  await page.getByRole('button', { name: `Switch to ${organizationName}` }).click()
  await expect(page.locator('.bottom-status-bar')).toContainText(organizationName)

  await openTeam(page)
  await page.getByLabel('Email').fill(memberEmail)
  await page.getByRole('button', { name: 'Invite', exact: true }).click()
  await expect(page.getByText(`Invited ${memberEmail}`)).toBeVisible()
  await signOut(page)

  await signUp(page, memberEmail)
  await expect(page.getByRole('heading', { name: 'Set up your workspace' })).toBeVisible()
  await page.getByRole('button', { name: /Accept$/ }).click()
  await expect(page.getByRole('button', { name: 'Open user menu' })).toBeVisible()
  await expect(page.locator('.bottom-status-bar')).toContainText(organizationName)
  await expect(page.getByRole('button', { name: 'New', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeDisabled()
  await openTeam(page)
  await expect(page.getByRole('button', { name: 'Invite', exact: true })).toBeDisabled()
  await expect(page.getByLabel(`Role for ${memberEmail}`)).toBeDisabled()
  await capture(page, 'identity-viewer-permissions')
  await signOut(page)

  await signIn(page, ownerEmail)
  await expect(page.getByRole('button', { name: 'Open user menu' })).toBeVisible()
  await openTeam(page)
  await page.getByLabel(`Role for ${memberEmail}`).selectOption('editor')
  await expect(page.getByText('Role updated')).toBeVisible()
  await signOut(page)

  await signIn(page, memberEmail)
  await expect(page.getByRole('button', { name: 'New', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeEnabled()
  await openTeam(page)
  await expect(page.getByRole('button', { name: 'Invite', exact: true })).toBeDisabled()
  await capture(page, 'identity-editor-permissions')

  expect(browserErrors).toEqual([])
})

test('local identity and organization membership survive a complete stack restart', async ({ page }) => {
  test.skip(!enabled || !persistenceOnly, 'runs only after the local identity stack restart')
  const browserErrors = guardBrowserErrors(page)
  await page.addInitScript(() => window.localStorage.setItem('janusly:locale', 'en'))

  await page.goto('/')
  await signIn(page, memberEmail)
  await expect(page.getByRole('button', { name: 'Open user menu' })).toBeVisible()
  await expect(page.locator('.bottom-status-bar')).toContainText(organizationName)
  await expect(page.getByRole('button', { name: 'New', exact: true })).toBeEnabled()
  await capture(page, 'identity-persisted-after-restart')

  expect(browserErrors).toEqual([])
})
