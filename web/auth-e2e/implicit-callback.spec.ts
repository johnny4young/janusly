import { expect, test, type Page } from '@playwright/test'

const AUTH_ORIGIN = 'http://127.0.0.1:54399'
const STORAGE_KEY = 'sb-127-auth-token'
const LINK_FAILED = 'This sign-in link is invalid or has expired. Request a new one.'
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': '*',
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

const expiresAt = Math.floor(Date.now() / 1000) + 3600
const accessToken = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: 'user-invited', exp: expiresAt })}.${encode('signature')}`
const refreshToken = 'refresh-token-secret'
const callback = `#access_token=${accessToken}&expires_in=3600&expires_at=${expiresAt}&refresh_token=${refreshToken}&token_type=bearer&type=invite`

type Harness = {
  contextBearers: string[]
  userLookups: () => number
  leaks: string[]
}

async function stubBackends(page: Page, { acceptToken }: { acceptToken: boolean }): Promise<Harness> {
  const contextBearers: string[] = []
  const leaks: string[] = []
  let lookups = 0
  const leaked = (text: string) => text.includes(accessToken) || text.includes(refreshToken)

  page.on('request', (request) => {
    const referer = request.headers().referer ?? ''
    if (leaked(request.url()) || leaked(referer)) leaks.push(`request ${request.url()}`)
  })
  page.on('console', (message) => {
    if (leaked(message.text())) leaks.push(`console ${message.type()}`)
  })
  page.on('framenavigated', (frame) => {
    if (leaked(frame.url()) && frame.url() !== `${new URL(frame.url()).origin}/${callback}`) leaks.push(`navigated ${frame.url()}`)
  })

  await page.route(`${AUTH_ORIGIN}/**`, async (route) => {
    const request = route.request()
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    if (!new URL(request.url()).pathname.endsWith('/auth/v1/user')) return route.fulfill({ status: 404, headers: CORS, json: {} })
    lookups += 1
    const accepted = acceptToken && request.headers().authorization === `Bearer ${accessToken}`
    return route.fulfill({
      status: accepted ? 200 : 401,
      headers: CORS,
      json: accepted
        ? { id: 'user-invited', aud: 'authenticated', email: 'invited@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' }
        : { code: 401, msg: 'invalid JWT' },
    })
  })
  await page.route('**/auth/session', (route) => route.fulfill({ status: 401, json: {} }))
  await page.route('**/auth/context', (route) => {
    contextBearers.push(route.request().headers().authorization ?? '')
    return route.fulfill({ json: { currentOrganizationId: null, organizations: [] } })
  })

  return { contextBearers, userLookups: () => lookups, leaks }
}

async function browserStorage(page: Page) {
  return page.evaluate(() => {
    const dump = (storage: Storage) => Object.keys(storage).map((key) => [key, storage.getItem(key) ?? ''] as const)
    return { local: dump(window.localStorage), session: dump(window.sessionStorage) }
  })
}

test('an invite callback signs in and leaves no token in the URL or history', async ({ page }) => {
  const harness = await stubBackends(page, { acceptToken: true })

  await page.goto('/logomark.svg')
  await page.goto(`/${callback}`)

  await expect.poll(() => harness.contextBearers).toContain(`Bearer ${accessToken}`)
  await expect(page.locator('#auth-email')).toHaveCount(0)
  expect(harness.userLookups()).toBe(1)

  await expect(page).toHaveURL(/\/#\/[a-zA-Z-]+$/)
  const historyLength = await page.evaluate(() => window.history.length)
  expect(page.url()).not.toContain(accessToken)

  const { local, session } = await browserStorage(page)
  const holders = [...local, ...session].filter(([, value]) => value.includes(accessToken) || value.includes(refreshToken))
  expect(holders.map(([key]) => key)).toEqual([STORAGE_KEY])

  // A pushed entry would make Back land on the token URL instead of the page before it.
  await page.goBack()
  await expect(page).toHaveURL(/\/logomark\.svg$/)
  await page.goForward()
  await expect(page).toHaveURL(/\/#\/[a-zA-Z-]+$/)
  expect(await page.evaluate(() => window.history.length)).toBe(historyLength)

  await page.reload()
  await expect.poll(() => harness.contextBearers.length).toBeGreaterThan(1)
  await expect(page.locator('#auth-email')).toHaveCount(0)
  expect(harness.leaks).toEqual([])
})

test('a provider error shows the fixed message and never the link text', async ({ page }) => {
  const harness = await stubBackends(page, { acceptToken: true })

  await page.goto('/#error=access_denied&error_code=otp_expired&error_description=Call+this+number')

  await expect(page.getByRole('alert')).toHaveText(LINK_FAILED)
  await expect(page.getByText('Call this number')).toHaveCount(0)
  await expect(page).toHaveURL(/\/#\/[a-zA-Z-]+$/)
  expect(harness.userLookups()).toBe(0)
})

test('a token the auth server rejects is not stored and reports a failed link', async ({ page }) => {
  const harness = await stubBackends(page, { acceptToken: false })

  await page.goto(`/${callback}`)

  await expect(page.getByRole('alert')).toHaveText(LINK_FAILED)
  expect(harness.userLookups()).toBe(1)
  expect(harness.contextBearers).toEqual([])
  expect(page.url()).not.toContain(accessToken)
  const { local, session } = await browserStorage(page)
  expect([...local, ...session].filter(([, value]) => value.includes(accessToken))).toEqual([])
  expect(harness.leaks).toEqual([])
})

test('an ordinary route is untouched', async ({ page }) => {
  await stubBackends(page, { acceptToken: true })

  await page.goto('/#/runs/dlq')

  await expect(page.locator('#auth-email')).toBeVisible()
  await expect(page).toHaveURL(/\/#\/runs\/dlq$/)
})
