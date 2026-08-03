import { mkdir } from 'node:fs/promises'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { expectNoBlockingAccessibilityViolations } from './_helpers/accessibility'
import { openWorkspaceSection } from './_helpers/workspace-navigation'

const enabled = process.env.JANUSLY_LOCAL_SECURITY_E2E === '1'
const evidenceDir = process.env.JANUSLY_EVIDENCE_DIR
const apiUrl = process.env.JANUSLY_SECURITY_API_URL ?? 'http://127.0.0.1:7311'
const email = process.env.JANUSLY_SECURITY_EMAIL ?? 'security@identity.local'
const password = process.env.JANUSLY_SECURITY_PASSWORD ?? 'Security-identity-2026!'
const organizationName = process.env.JANUSLY_SECURITY_ORG_NAME ?? 'Security Lab'
const credentialName = process.env.JANUSLY_SECURITY_CREDENTIAL_NAME ?? 'security-managed-secret'
const secretValue = process.env.JANUSLY_SECURITY_SECRET_VALUE ?? 'security-secret-value'

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

async function sessionHeaders(page: Page) {
  return page.evaluate(() => {
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
    const orgId = window.localStorage.getItem('janusly:activeOrg')
    if (!orgId) throw new Error('Active organization is missing')
    return {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'x-org-id': orgId,
    }
  })
}

async function getJson(
  request: APIRequestContext,
  path: string,
  headers: Record<string, string>,
) {
  const response = await request.get(`${apiUrl}${path}`, { headers })
  const body = await response.text()
  expect(response.ok(), `${path} returned ${response.status()}: ${body}`).toBe(true)
  return JSON.parse(body) as unknown
}

test('local API rejects alternate auth paths and exposes only bounded public health', async ({
  page,
  request,
}) => {
  test.skip(!enabled, 'requires the local security qualification profile')
  const browserErrors = guardBrowserErrors(page)

  const unauthenticated = await request.get(`${apiUrl}/workflows`)
  expect(unauthenticated.status()).toBe(401)
  const devHeaders = await request.get(`${apiUrl}/workflows`, {
    headers: { 'x-org-id': 'default', 'x-user-id': 'dev-user' },
  })
  expect(devHeaders.status()).toBe(401)
  const invalidBearer = await request.get(`${apiUrl}/workflows`, {
    headers: { Authorization: 'Bearer invalid-local-token', 'x-org-id': 'default' },
  })
  expect(invalidBearer.status()).toBe(401)

  for (const origin of ['https://attacker.example', 'null']) {
    const response = await request.get(`${apiUrl}/health`, {
      headers: { Origin: origin },
    })
    expect(response.headers()['access-control-allow-origin']).toBeUndefined()
    expect(response.headers()['access-control-allow-credentials']).toBeUndefined()
  }
  const allowedOrigin = await request.get(`${apiUrl}/health`, {
    headers: { Origin: 'http://localhost:7310' },
  })
  expect(allowedOrigin.headers()['access-control-allow-origin']).toBe(
    'http://localhost:7310',
  )
  expect(allowedOrigin.headers()['access-control-allow-credentials']).toBe('true')

  const health = await allowedOrigin.json() as Record<string, unknown>
  expect(Object.keys(health).sort()).toEqual(['ok', 'queue', 'rateLimiter'])
  expect(JSON.stringify(health)).not.toMatch(
    /password|secret|redis|waitingJobs|activeJobs|oldestWaiting/iu,
  )
  const undeclaredAlias = await request.get(`${apiUrl}/v1/internal/security-probe`)
  expect(undeclaredAlias.status()).toBe(404)

  await page.addInitScript(() => window.localStorage.setItem('janusly:locale', 'en'))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
  await expectHealthySurface(page, 'security login boundary')
  await capture(page, 'security-login-en')
  expect(browserErrors).toEqual([])
})

test('managed credentials enter once, stay tenant-scoped, and never return to the UI', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000)
  test.skip(!enabled, 'requires the local security qualification profile')
  const browserErrors = guardBrowserErrors(page)
  await page.addInitScript(() => {
    if (!window.localStorage.getItem('janusly:locale')) {
      window.localStorage.setItem('janusly:locale', 'en')
    }
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Need an account? Sign up' }).click()
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign up', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Set up your workspace' })).toBeVisible()
  await page.getByLabel('Your name').fill('Security Owner')
  await page.getByLabel('Organization name').fill(organizationName)
  await page.getByRole('button', { name: 'Create workspace' }).click()
  await expect(page.getByRole('button', { name: 'Open user menu' })).toBeVisible()

  const headers = await sessionHeaders(page)
  const crossTenant = await request.get(`${apiUrl}/workflows`, {
    headers: { ...headers, 'x-org-id': 'ungranted-security-organization' },
  })
  expect(crossTenant.status()).toBe(401)

  const created = await request.post(`${apiUrl}/credentials`, {
    headers,
    data: {
      name: credentialName,
      kind: 'generic',
      secretValue,
    },
  })
  expect(created.status()).toBe(200)
  const createdText = await created.text()
  expect(createdText).not.toContain(secretValue)
  expect(Object.keys(JSON.parse(createdText) as Record<string, unknown>)).toEqual(['id'])

  const credentials = await getJson(request, '/credentials', headers)
  const health = await getJson(request, '/credentials/health', headers)
  const audit = await getJson(request, '/audit?action=credential.created', headers)
  for (const payload of [credentials, health, audit]) {
    const serialized = JSON.stringify(payload)
    expect(serialized).not.toContain(secretValue)
    expect(serialized).not.toContain('"secretRef":')
    expect(serialized).not.toContain('janusly-secret://')
  }
  expect(credentials).toEqual(expect.arrayContaining([
    expect.objectContaining({
      name: credentialName,
      storage: 'managed',
    }),
  ]))

  await page.reload()
  await expect(page.getByRole('button', { name: 'Open user menu' })).toBeVisible()
  await openWorkspaceSection(page, 'Settings', 'Connections')
  await expect(page.getByText(credentialName)).toBeVisible()
  await expect(page.locator('body')).not.toContainText(secretValue)
  await expectHealthySurface(page, 'managed connection inventory in English')
  await capture(page, 'security-connections-en')

  await page.evaluate(() => window.localStorage.setItem('janusly:locale', 'es'))
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Conexiones' })).toBeVisible()
  await expect(page.getByText(credentialName)).toBeVisible()
  await expect(page.locator('body')).not.toContainText(secretValue)
  await expectHealthySurface(page, 'managed connection inventory in Spanish')
  await capture(page, 'security-connections-es')

  expect(browserErrors).toEqual([])
})
