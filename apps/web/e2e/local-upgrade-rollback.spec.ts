import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { expectNoBlockingAccessibilityViolations } from './_helpers/accessibility'

const enabled = process.env.JANUSLY_LOCAL_UPGRADE_E2E === '1'
const phase = process.env.JANUSLY_UPGRADE_PHASE
const evidenceDir = process.env.JANUSLY_EVIDENCE_DIR
const apiUrl = process.env.JANUSLY_UPGRADE_API_URL ?? 'http://127.0.0.1:7311'
const email = process.env.JANUSLY_UPGRADE_EMAIL ?? 'owner@upgrade.local'
const password = process.env.JANUSLY_UPGRADE_PASSWORD ?? 'Upgrade-identity-2026!'
const organizationName = process.env.JANUSLY_UPGRADE_ORG_NAME ?? 'Upgrade Lab'
const workflowId = process.env.JANUSLY_UPGRADE_WORKFLOW_ID ?? 'upgrade-workflow'
const workflowName = process.env.JANUSLY_UPGRADE_WORKFLOW_NAME ?? 'Upgrade workflow'

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

test('application data survives forward migration and previous-version rollback', async ({ page }) => {
  test.setTimeout(120_000)
  test.skip(
    !enabled || !['baseline', 'upgraded', 'rollback', 'rolled-forward'].includes(phase ?? ''),
    'requires the destructive local upgrade harness',
  )
  const browserErrors = guardBrowserErrors(page)
  await page.addInitScript(() => {
    if (!window.localStorage.getItem('janusly:locale')) {
      window.localStorage.setItem('janusly:locale', 'en')
    }
  })

  if (phase === 'baseline') {
    await page.goto('/')
    await page.getByRole('button', { name: 'Need an account? Sign up' }).click()
    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password').fill(password)
    await page.getByRole('button', { name: 'Sign up', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Set up your workspace' })).toBeVisible()
    await page.getByLabel('Your name').fill('Upgrade Owner')
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
    await openPersistedWorkflow(page)
    await expectHealthySurface(page, 'pre-upgrade application')
    await capture(page, 'upgrade-baseline-en')
  } else {
    await signIn(page)
    await expect(page.locator('.bottom-status-bar')).toContainText(organizationName)
    await openPersistedWorkflow(page)
    await expectHealthySurface(
      page,
      phase === 'upgraded'
        ? 'upgraded application'
        : phase === 'rollback'
          ? 'rolled-back application'
          : 'rolled-forward application',
    )
    await capture(
      page,
      phase === 'upgraded'
        ? 'upgrade-current-en'
        : phase === 'rollback'
          ? 'upgrade-rollback-en'
          : 'upgrade-rolled-forward-en',
    )

    if (phase === 'upgraded') {
      await page.evaluate(() => window.localStorage.setItem('janusly:locale', 'es'))
      await page.reload()
      await expect(page.getByTestId(`workflows-row-${workflowId}`)).toContainText(workflowName)
      await expectHealthySurface(page, 'upgraded application in Spanish')
      await capture(page, 'upgrade-current-es')
    }
  }

  expect(browserErrors).toEqual([])
})
