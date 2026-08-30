import {
  addCanvasStep,
  openWorkflowCreation,
  openWorkspaceSection,
} from './_helpers/workspace-navigation'
import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

const enabled = process.env.JANUSLY_LOCAL_IDENTITY_E2E === '1'
const persistenceOnly = process.env.JANUSLY_LOCAL_IDENTITY_PERSISTENCE_ONLY === '1'
const evidenceDir = process.env.JANUSLY_EVIDENCE_DIR
const ownerEmail = process.env.JANUSLY_IDENTITY_OWNER_EMAIL ?? 'owner@identity.local'
const memberEmail = process.env.JANUSLY_IDENTITY_MEMBER_EMAIL ?? 'member@identity.local'
const invitedViewerEmail = process.env.JANUSLY_IDENTITY_VIEWER_EMAIL ?? 'viewer@identity.local'
const password = process.env.JANUSLY_IDENTITY_PASSWORD ?? 'Local-identity-2026!'
const organizationName = process.env.JANUSLY_IDENTITY_ORG_NAME ?? 'Identity Lab'
const secondaryOrganizationName = `${organizationName} Secondary`
const editorWorkflowName = 'Identity editor workflow'
const adminWorkflowName = 'Identity delegated admin workflow'

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
  await expect(
    page.getByRole('dialog', { name: 'Account and workspace controls' }),
  ).toBeVisible()
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

async function createAndRunWorkflow(page: Page, workflowName: string) {
  await page.getByRole('button', { name: 'Workflows', exact: true }).click()
  await openWorkflowCreation(page)
  await page.getByRole('button', { name: /^Start blank\b/ }).click()
  await page.getByRole('textbox', { name: 'Name' }).fill(workflowName)
  await addCanvasStep(page, 'Do nothing')
  await page.getByRole('button', { name: 'Validate', exact: true }).click()
  await expect(page.getByText('Flow is ready to run')).toBeVisible()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText(/Saved version \d+/)).toBeVisible()
  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.getByText(/Run started:/)).toBeVisible()
  await openWorkspaceSection(page, 'Workflows', 'Build')
  await expect(
    page.locator('.workflow-node').filter({ hasText: 'Do nothing' }).filter({ hasText: 'Done' }),
  ).toBeVisible({ timeout: 30_000 })
}

function memberRow(page: Page, email: string) {
  return page.locator('[data-testid^="members-row-"]').filter({ hasText: email })
}

test('real local identity covers onboarding, organizations, roles, and truthful permission UX', async ({ page }) => {
  test.setTimeout(240_000)
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
  await openWorkspaceSection(page, 'Workflows', 'Build')
  await expect(page.getByTestId('canvas-empty')).toBeVisible()
  await expect(page.locator('.react-flow__node')).toHaveCount(0)
  await expect(page.locator('.top-bar-breadcrumb')).toContainText('Untitled Workflow')
  await capture(page, 'identity-empty-workflow')

  await openUserMenu(page)
  await page.getByRole('button', { name: 'New workspace · invite' }).click()
  await page.getByLabel('Organization name').fill(secondaryOrganizationName)
  await page.getByRole('button', { name: 'Create workspace' }).click()
  await expect(page.locator('.bottom-status-bar')).toContainText(secondaryOrganizationName)
  await openUserMenu(page)
  await page.getByRole('button', { name: `Switch to ${organizationName}` }).click()
  await expect(page.locator('.bottom-status-bar')).toContainText(organizationName)

  await openTeam(page)
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(memberEmail)
  await page.getByRole('button', { name: 'Invite', exact: true }).click()
  await expect(page.getByText(`Invited ${memberEmail}`)).toBeVisible()
  await signOut(page)

  await signUp(page, memberEmail)
  await expect(page.getByRole('heading', { name: 'Set up your workspace' })).toBeVisible()
  await page.getByRole('button', { name: /Accept$/ }).click()
  await expect(page.getByRole('button', { name: 'Open user menu' })).toBeVisible()
  await expect(page.locator('.bottom-status-bar')).toContainText(organizationName)
  await page.getByRole('button', { name: 'Workflows', exact: true }).click()
  await expect(page.getByRole('button', { name: 'New workflow', exact: true }).first()).toBeDisabled()
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
  await page.getByRole('button', { name: 'Workflows', exact: true }).click()
  await expect(page.getByRole('button', { name: 'New workflow', exact: true }).first()).toBeEnabled()
  await createAndRunWorkflow(page, editorWorkflowName)
  await openTeam(page)
  await expect(page.getByRole('button', { name: 'Invite', exact: true })).toBeDisabled()
  await capture(page, 'identity-editor-permissions')
  await signOut(page)

  await signIn(page, ownerEmail)
  await openTeam(page)
  const ownerRow = memberRow(page, ownerEmail)
  await expect(ownerRow.getByText('Owner', { exact: true })).toBeVisible()
  await expect(page.getByLabel(`Role for ${ownerEmail}`)).toBeDisabled()
  await expect(page.getByLabel(`Remove ${ownerEmail}`)).toHaveCount(0)
  await page.getByLabel(`Role for ${memberEmail}`).selectOption('admin')
  await expect(page.getByText('Role updated')).toBeVisible()
  await signOut(page)

  await signIn(page, memberEmail)
  await openTeam(page)
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(invitedViewerEmail)
  await page.getByRole('button', { name: 'Invite', exact: true }).click()
  await expect(page.getByText(`Invited ${invitedViewerEmail}`)).toBeVisible()
  await expect(page.getByLabel(`Role for ${ownerEmail}`)).toBeDisabled()
  await expect(page.getByLabel(`Remove ${ownerEmail}`)).toHaveCount(0)
  await createAndRunWorkflow(page, adminWorkflowName)
  await capture(page, 'identity-admin-workflow')
  await signOut(page)

  await signIn(page, ownerEmail)
  await openTeam(page)
  await page.getByLabel(`Transfer ownership to ${memberEmail}`).click()
  await expect(page.getByText(`Make ${memberEmail} the organization owner?`)).toBeVisible()
  await page.getByRole('button', { name: 'Transfer ownership', exact: true }).click()
  await expect(page.getByText('Organization ownership transferred')).toBeVisible()
  await expect(memberRow(page, memberEmail).getByText('Owner', { exact: true })).toBeVisible()
  await expect(page.getByLabel(`Role for ${memberEmail}`)).toBeDisabled()
  await expect(page.getByLabel(`Remove ${memberEmail}`)).toHaveCount(0)
  await expect(page.getByLabel(`Transfer ownership to ${ownerEmail}`)).toHaveCount(0)
  await capture(page, 'identity-owner-transferred')
  await signOut(page)

  await signIn(page, memberEmail)
  await openTeam(page)
  await expect(memberRow(page, memberEmail).getByText('Owner', { exact: true })).toBeVisible()
  await capture(page, 'identity-delegated-owner')

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
  await openTeam(page)
  await expect(memberRow(page, memberEmail).getByText('Owner', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Workflows', exact: true }).click()
  await expect(page.getByRole('button', { name: 'New workflow', exact: true }).first()).toBeEnabled()
  await expect(page.locator('[data-testid^="workflows-row-"]').filter({ hasText: editorWorkflowName })).toBeVisible()
  await expect(page.locator('[data-testid^="workflows-row-"]').filter({ hasText: adminWorkflowName })).toBeVisible()
  await openWorkspaceSection(page, 'Activity', 'Runs')
  const history = page.getByTestId('runs-history-virtual-list')
  for (const workflowName of [editorWorkflowName, adminWorkflowName]) {
    const run = history.getByRole('article').filter({ hasText: workflowName }).first()
    await expect(run).toBeVisible({ timeout: 30_000 })
    await expect(run.locator('[data-status="succeeded"]')).toBeVisible()
  }
  await capture(page, 'identity-persisted-after-restart')

  expect(browserErrors).toEqual([])
})
