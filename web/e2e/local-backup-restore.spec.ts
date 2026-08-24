import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { expectNoBlockingAccessibilityViolations } from './_helpers/accessibility'
import { openWorkspaceSection } from './_helpers/workspace-navigation'

const enabled = process.env.JANUSLY_LOCAL_BACKUP_RESTORE_E2E === '1'
const phase = process.env.JANUSLY_BACKUP_RESTORE_PHASE
const evidenceDir = process.env.JANUSLY_EVIDENCE_DIR
const apiUrl = process.env.JANUSLY_BACKUP_RESTORE_API_URL ?? 'http://127.0.0.1:7310'
const email = process.env.JANUSLY_BACKUP_RESTORE_EMAIL ?? 'owner@recovery.local'
const password = process.env.JANUSLY_BACKUP_RESTORE_PASSWORD ?? 'Recovery-identity-2026!'
const organizationName = process.env.JANUSLY_BACKUP_RESTORE_ORG_NAME ?? 'Recovery Lab'
const workflowId = process.env.JANUSLY_BACKUP_RESTORE_WORKFLOW_ID ?? 'recovery-workflow'
const workflowName = process.env.JANUSLY_BACKUP_RESTORE_WORKFLOW_NAME ?? 'Recovered workflow'
const credentialName = process.env.JANUSLY_BACKUP_RESTORE_CREDENTIAL_NAME ?? 'recovered-credential'
const credentialSecret = process.env.JANUSLY_BACKUP_RESTORE_SECRET ?? 'recovery-secret-value'

function guardBrowserErrors(page: Page) {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('response', (response) => {
    if (response.status() >= 400) {
      errors.push(`${response.status()} ${new URL(response.url()).pathname}`)
    }
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

async function signIn(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Log in', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Open user menu' })).toBeVisible()
}

async function postFromSession(page: Page, path: string, body: unknown) {
  const result = await page.evaluate(
    async ({ baseUrl, requestPath, payload }) => {
      const accessToken = Object.keys(window.localStorage)
        .filter((key) => key.startsWith('sb-') && key.endsWith('-auth-token'))
        .map((key) => {
          try {
            const stored = JSON.parse(window.localStorage.getItem(key) ?? 'null') as {
              access_token?: unknown
              currentSession?: { access_token?: unknown }
            } | null
            const candidate = stored?.access_token ?? stored?.currentSession?.access_token
            return typeof candidate === 'string' ? candidate : null
          } catch {
            return null
          }
        })
        .find((candidate): candidate is string => candidate !== null)
      if (!accessToken) throw new Error('Supabase access token is missing')
      const response = await fetch(`${baseUrl}${requestPath}`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'x-org-id': window.localStorage.getItem('janusly:activeOrg') ?? 'default',
          'x-janusly-csrf': '1',
        },
        body: JSON.stringify(payload),
      })
      return {
        ok: response.ok,
        status: response.status,
        body: await response.text(),
      }
    },
    { baseUrl: apiUrl, requestPath: path, payload: body },
  )
  expect(result.ok, `${path} returned ${result.status}: ${result.body}`).toBe(true)
  return JSON.parse(result.body) as Record<string, unknown>
}

async function openPersistedWorkflow(page: Page) {
  await page
    .locator('#workspace-sidebar')
    .getByRole('button', { name: /^(Flows|Workflows)$/ })
    .click()
  const row = page.getByTestId(`workflows-row-${workflowId}`)
  await expect(row).toBeVisible()
  await expect(row).toContainText(workflowName)
}

async function openPersistedCredential(page: Page) {
  await openWorkspaceSection(page, 'Settings', 'Connections')
  await expect(page.getByText(credentialName)).toBeVisible()
  await expect(page.locator('body')).not.toContainText(credentialSecret)
}

test('application data and managed credential metadata survive a guarded PostgreSQL restore', async ({ page }) => {
  test.setTimeout(120_000)
  test.skip(
    !enabled || !['seed', 'restored'].includes(phase ?? ''),
    'requires the destructive local backup/restore harness',
  )
  const browserErrors = guardBrowserErrors(page)
  await page.addInitScript(() => {
    if (!window.localStorage.getItem('janusly:locale')) {
      window.localStorage.setItem('janusly:locale', 'en')
    }
  })

  if (phase === 'seed') {
    await page.goto('/')
    await page.getByRole('button', { name: 'Need an account? Sign up' }).click()
    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password').fill(password)
    await page.getByRole('button', { name: 'Sign up', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Set up your workspace' })).toBeVisible()
    await page.getByLabel('Your name').fill('Recovery Owner')
    await page.getByLabel('Organization name').fill(organizationName)
    await page.getByRole('button', { name: 'Create workspace' }).click()
    await expect(page.getByRole('button', { name: 'Open user menu' })).toBeVisible()

    const workflow = {
      dslVersion: '1.0',
      id: workflowId,
      name: workflowName,
      nodes: [{ id: 'complete', type: 'noop', config: {} }],
      edges: [],
    }
    await postFromSession(page, '/workflows/save', workflow)
    await postFromSession(page, '/start', workflow)
    await postFromSession(page, '/credentials', {
      name: credentialName,
      kind: 'generic',
      secretValue: credentialSecret,
    })
    // These setup writes intentionally bypass the shell's mutation commands,
    // so reload once to obtain a fresh server snapshot before capturing the
    // pre-backup evidence.
    await page.reload()
    await expect(page.getByRole('button', { name: 'Open user menu' })).toBeVisible()
    await openPersistedWorkflow(page)
    await openPersistedCredential(page)
    await expectHealthySurface(page, 'application before PostgreSQL backup')
    await capture(page, 'backup-seed-en')
  } else {
    await signIn(page)
    await expect(page.locator('.bottom-status-bar')).toContainText(organizationName)
    await openPersistedWorkflow(page)
    await openPersistedCredential(page)
    await expectHealthySurface(page, 'application after PostgreSQL restore')
    await capture(page, 'backup-restored-en')

    await page.evaluate(() => window.localStorage.setItem('janusly:locale', 'es'))
    await page.reload()
    await page.getByRole('button', { name: 'Flujos', exact: true }).click()
    await expect(page.getByTestId(`workflows-row-${workflowId}`)).toContainText(workflowName)
    await expect(page.locator('body')).not.toContainText(credentialSecret)
    await expectHealthySurface(page, 'restored application in Spanish')
    await capture(page, 'backup-restored-es')
  }

  expect(browserErrors).toEqual([])
})
