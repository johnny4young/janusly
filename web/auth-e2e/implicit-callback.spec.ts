import { expect, test, type Page } from '@playwright/test'

const AUTH_ORIGIN = 'http://127.0.0.1:54399'
const STORAGE_KEY = 'sb-127-auth-token'
const LINK_FAILED = 'This sign-in link is invalid or has expired. Request a new one.'
const ROUTE = /\/#\/[a-zA-Z-]+$/
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': '*',
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

const expiresAt = Math.floor(Date.now() / 1000) + 3600

function tokenFor(sub: string): string {
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub, exp: expiresAt })}.${encode('signature')}`
}

function linkFor(accessToken: string, refreshToken: string): string {
  return `/#access_token=${accessToken}&expires_in=3600&expires_at=${expiresAt}&refresh_token=${refreshToken}&token_type=bearer&type=invite`
}

const invited = { token: tokenFor('user-invited'), refresh: 'refresh-invited', email: 'invited@example.com' }
const other = { token: tokenFor('user-other'), refresh: 'refresh-other', email: 'other@example.com' }
const ended = { token: tokenFor('user-ended'), refresh: 'refresh-ended' }
const rejected = { token: tokenFor('user-rejected'), refresh: 'refresh-rejected' }

type Harness = {
  contextBearers: string[]
  userLookups: () => number
  leaks: string[]
  watch: (target: Page) => void
}

async function stubBackends(page: Page): Promise<Harness> {
  const contextBearers: string[] = []
  const leaks: string[] = []
  let lookups = 0
  const secrets = [invited, other, ended, rejected].flatMap(({ token, refresh }) => [token, refresh])
  const leaked = (text: string) => secrets.some((secret) => text.includes(secret))

  const watch = (target: Page) => {
    let openedLink = false
    target.on('request', (request) => {
      if (leaked(request.url()) || leaked(request.headers().referer ?? '')) leaks.push(`request ${request.url()}`)
    })
    target.on('console', (message) => {
      if (leaked(message.text())) leaks.push(`console ${message.type()}`)
    })
    // The navigation that opens the link necessarily carries it; nothing after may.
    target.on('framenavigated', (frame) => {
      if (!leaked(frame.url())) return
      if (openedLink) leaks.push(`navigated ${frame.url()}`)
      openedLink = true
    })
  }
  watch(page)

  const context = page.context()
  await context.route(`${AUTH_ORIGIN}/**`, async (route) => {
    const request = route.request()
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    if (!new URL(request.url()).pathname.endsWith('/auth/v1/user')) return route.fulfill({ status: 404, headers: CORS, json: {} })
    lookups += 1
    const bearer = request.headers().authorization
    if (bearer === `Bearer ${ended.token}`) {
      return route.fulfill({ status: 403, headers: CORS, json: { error_code: 'session_not_found', msg: 'Session not found' } })
    }
    const user = [invited, other].find(({ token }) => bearer === `Bearer ${token}`)
    if (!user) return route.fulfill({ status: 401, headers: CORS, json: { code: 401, msg: 'invalid JWT' } })
    return route.fulfill({
      headers: CORS,
      json: { id: user.email, aud: 'authenticated', email: user.email, app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' },
    })
  })
  await context.route('**/auth/session', (route) => route.fulfill({ status: 401, json: {} }))
  await context.route('**/auth/context', (route) => {
    contextBearers.push(route.request().headers().authorization ?? '')
    return route.fulfill({ json: { currentOrganizationId: null, organizations: [] } })
  })

  return { contextBearers, userLookups: () => lookups, leaks, watch }
}

async function browserStorage(page: Page) {
  return page.evaluate(() => {
    const dump = (storage: Storage) => Object.keys(storage).map((key) => [key, storage.getItem(key) ?? ''] as const)
    return [...dump(window.localStorage), ...dump(window.sessionStorage)]
  })
}

async function storageHolding(page: Page, ...secrets: string[]): Promise<string[]> {
  const entries = await browserStorage(page)
  return entries.filter(([, value]) => secrets.some((secret) => value.includes(secret))).map(([key]) => key)
}

const confirmation = (page: Page, email: string) => page.getByRole('heading', { name: `Continue as ${email}?` })
const continueButton = (page: Page) => page.getByRole('button', { name: 'Continue', exact: true })
const cancelButton = (page: Page) => page.getByRole('button', { name: 'Cancel', exact: true })

async function signIn(page: Page, harness: Harness, user: typeof invited): Promise<void> {
  await page.goto(linkFor(user.token, user.refresh))
  await confirmation(page, user.email).waitFor()
  await continueButton(page).click()
  await expect.poll(() => harness.contextBearers).toContain(`Bearer ${user.token}`)
  await expect(page).toHaveURL(ROUTE)
}

test('a sign-in link waits for consent, then signs in and leaves no token behind', async ({ page }) => {
  const harness = await stubBackends(page)

  await page.goto('/logomark.svg')
  await page.goto(linkFor(invited.token, invited.refresh))

  await expect(confirmation(page, invited.email)).toBeVisible()
  expect(page.url()).not.toContain(invited.token)
  expect(harness.contextBearers).toEqual([])
  expect(await storageHolding(page, invited.token, invited.refresh)).toEqual([])

  await continueButton(page).click()

  await expect.poll(() => harness.contextBearers).toContain(`Bearer ${invited.token}`)
  await expect(page.locator('#auth-email')).toHaveCount(0)
  await expect(page).toHaveURL(ROUTE)
  expect(await storageHolding(page, invited.token, invited.refresh)).toEqual([STORAGE_KEY])

  // A pushed entry would make Back land on the token URL instead of the page before it.
  const historyLength = await page.evaluate(() => window.history.length)
  await page.goBack()
  await expect(page).toHaveURL(/\/logomark\.svg$/)
  await page.goForward()
  await expect(page).toHaveURL(ROUTE)
  expect(await page.evaluate(() => window.history.length)).toBe(historyLength)

  const requestsBeforeReload = harness.contextBearers.length
  await page.reload()
  await expect.poll(() => harness.contextBearers.length).toBeGreaterThan(requestsBeforeReload)
  await expect(page.locator('#auth-email')).toHaveCount(0)
  expect(harness.leaks).toEqual([])
})

test('declining a link while signed out leaves no session', async ({ page }) => {
  const harness = await stubBackends(page)

  await page.goto(linkFor(invited.token, invited.refresh))
  await confirmation(page, invited.email).waitFor()
  await cancelButton(page).click()

  await expect(page.locator('#auth-email')).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page).toHaveURL(ROUTE)
  expect(harness.userLookups()).toBe(1)
  expect(harness.contextBearers).toEqual([])
  expect(await storageHolding(page, invited.token, invited.refresh)).toEqual([])
  expect(harness.leaks).toEqual([])
})

test('a link for another account never replaces a session without consent', async ({ page, context }) => {
  const harness = await stubBackends(page)
  await signIn(page, harness, invited)

  const declined = await context.newPage()
  harness.watch(declined)
  harness.contextBearers.length = 0
  await declined.goto(linkFor(other.token, other.refresh))
  await expect(confirmation(declined, other.email)).toBeVisible()
  expect(harness.contextBearers).toEqual([])
  expect(await storageHolding(declined, other.token, other.refresh)).toEqual([])
  await expect(page.locator('#auth-email')).toHaveCount(0)

  await cancelButton(declined).click()
  await expect.poll(() => harness.contextBearers).toContain(`Bearer ${invited.token}`)
  expect(harness.contextBearers).not.toContain(`Bearer ${other.token}`)
  expect(await storageHolding(declined, other.token, other.refresh)).toEqual([])
  expect(await storageHolding(declined, invited.token)).toEqual([STORAGE_KEY])
  await declined.close()

  const accepted = await context.newPage()
  harness.watch(accepted)
  await signIn(accepted, harness, other)
  expect(await storageHolding(accepted, invited.token)).toEqual([])
  expect(await storageHolding(accepted, other.token)).toEqual([STORAGE_KEY])
  expect(harness.leaks).toEqual([])
})

test('a link whose session ended leaves the stored session alone', async ({ page, context }) => {
  const harness = await stubBackends(page)
  await signIn(page, harness, invited)

  const opened = await context.newPage()
  harness.watch(opened)
  harness.contextBearers.length = 0
  await opened.goto(linkFor(ended.token, ended.refresh))

  await expect.poll(() => harness.contextBearers).toContain(`Bearer ${invited.token}`)
  await expect(opened.locator('#auth-email')).toHaveCount(0)
  await expect(confirmation(opened, invited.email)).toHaveCount(0)
  expect(await storageHolding(opened, invited.token)).toEqual([STORAGE_KEY])
  expect(harness.leaks).toEqual([])
})

test('a provider error shows the fixed message and never the link text', async ({ page }) => {
  const harness = await stubBackends(page)

  await page.goto('/#error=access_denied&error_code=otp_expired&error_description=Call+this+number')

  await expect(page.getByRole('alert')).toHaveText(LINK_FAILED)
  await expect(page.getByText('Call this number')).toHaveCount(0)
  await expect(page).toHaveURL(ROUTE)
  expect(harness.userLookups()).toBe(0)
})

test('a token the auth server rejects is not stored and reports a failed link', async ({ page }) => {
  const harness = await stubBackends(page)

  await page.goto(linkFor(rejected.token, rejected.refresh))

  await expect(page.getByRole('alert')).toHaveText(LINK_FAILED)
  await expect(confirmation(page, invited.email)).toHaveCount(0)
  expect(harness.userLookups()).toBe(1)
  expect(harness.contextBearers).toEqual([])
  expect(page.url()).not.toContain(rejected.token)
  expect(await storageHolding(page, rejected.token, rejected.refresh)).toEqual([])
  expect(harness.leaks).toEqual([])
})

test('an ordinary route is untouched', async ({ page }) => {
  await stubBackends(page)

  await page.goto('/#/runs/dlq')

  await expect(page.locator('#auth-email')).toBeVisible()
  await expect(page).toHaveURL(/\/#\/runs\/dlq$/)
})
