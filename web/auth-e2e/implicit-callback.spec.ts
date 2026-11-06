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

function linkFor(accessToken: string, refreshToken: string, type = 'magiclink'): string {
  return `/#access_token=${accessToken}&expires_in=3600&expires_at=${expiresAt}&refresh_token=${refreshToken}&token_type=bearer&type=${type}`
}

const invited = { token: tokenFor('user-invited'), refresh: 'refresh-invited', email: 'invited@example.com' }
const other = { token: tokenFor('user-other'), refresh: 'refresh-other', email: 'other@example.com' }
const ended = { token: tokenFor('user-ended'), refresh: 'refresh-ended' }
const rejected = { token: tokenFor('user-rejected'), refresh: 'refresh-rejected' }
const NEW_PASSWORD = 'correct horse battery'

type Harness = {
  contextBearers: string[]
  userLookups: () => number
  passwordUpdates: Array<{ bearer: string; password: unknown }>
  passwordFailures: Array<{ status: number; json: Record<string, unknown> }>
  signOuts: () => number
  leaks: string[]
  watch: (target: Page) => void
}

async function stubBackends(page: Page): Promise<Harness> {
  const contextBearers: string[] = []
  const leaks: string[] = []
  const passwordUpdates: Harness['passwordUpdates'] = []
  const passwordFailures: Harness['passwordFailures'] = []
  let lookups = 0
  let signOuts = 0
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
    const { pathname } = new URL(request.url())
    if (pathname.endsWith('/auth/v1/logout')) {
      signOuts += 1
      return route.fulfill({ status: 204, headers: CORS })
    }
    if (!pathname.endsWith('/auth/v1/user')) return route.fulfill({ status: 404, headers: CORS, json: {} })
    const bearer = request.headers().authorization
    if (request.method() === 'PUT') {
      const failure = passwordFailures.shift()
      if (failure) return route.fulfill({ ...failure, headers: CORS })
      passwordUpdates.push({ bearer, password: request.postDataJSON().password })
    } else {
      lookups += 1
    }
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

  return { contextBearers, userLookups: () => lookups, passwordUpdates, passwordFailures, signOuts: () => signOuts, leaks, watch }
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
const setPasswordHeading = (page: Page) => page.getByRole('heading', { name: 'Set a password' })
const saveButton = (page: Page) => page.getByRole('button', { name: 'Save password', exact: true })

async function enterPassword(page: Page, password = NEW_PASSWORD): Promise<void> {
  await page.getByLabel('New password').fill(password)
  await page.getByLabel('Confirm password').fill(password)
}

async function openSetPassword(page: Page, type: string): Promise<void> {
  await page.goto(linkFor(invited.token, invited.refresh, type))
  await confirmation(page, invited.email).waitFor()
  await continueButton(page).click()
  await setPasswordHeading(page).waitFor()
  await expect(page.getByText(invited.email)).toBeVisible()
}

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

for (const type of ['recovery', 'invite']) {
  test(`a ${type} link sets a password before the workspace, across a reload`, async ({ page }) => {
    const harness = await stubBackends(page)

    await openSetPassword(page, type)
    expect(page.url()).not.toContain(invited.token)
    expect(await storageHolding(page, invited.token)).toEqual([STORAGE_KEY])
    expect(harness.contextBearers).toEqual([])

    await page.reload()
    await expect(setPasswordHeading(page)).toBeVisible()
    expect(harness.contextBearers).toEqual([])

    await enterPassword(page)
    await saveButton(page).click()

    await expect.poll(() => harness.contextBearers).toContain(`Bearer ${invited.token}`)
    await expect(setPasswordHeading(page)).toHaveCount(0)
    await expect(page).toHaveURL(ROUTE)
    expect(harness.passwordUpdates).toEqual([{ bearer: `Bearer ${invited.token}`, password: NEW_PASSWORD }])
    expect(await storageHolding(page, NEW_PASSWORD)).toEqual([])

    const requestsBeforeReload = harness.contextBearers.length
    await page.reload()
    await expect.poll(() => harness.contextBearers.length).toBeGreaterThan(requestsBeforeReload)
    await expect(setPasswordHeading(page)).toHaveCount(0)
    expect(harness.leaks).toEqual([])
  })

  test(`a failed ${type} save reports, keeps the session and can be retried`, async ({ page }) => {
    const harness = await stubBackends(page)
    harness.passwordFailures.push(
      { status: 422, json: { error_code: 'weak_password', msg: 'Raw server text', weak_password: { reasons: ['length'] } } },
      { status: 422, json: { error_code: 'same_password', msg: 'Raw server text' } },
      { status: 400, json: { error_code: 'reauthentication_needed', msg: 'Raw server text' } },
      { status: 500, json: { msg: 'Raw server text' } },
    )
    await openSetPassword(page, type)
    await enterPassword(page)

    for (const message of [
      'That password is too weak. Use a longer one or add numbers and symbols.',
      'Choose a password different from your current one.',
      "This session can't change the password. Sign out and request a new link.",
      "Your password wasn't changed. Try again.",
    ]) {
      await saveButton(page).click()
      await expect(page.getByRole('alert')).toHaveText(message)
      await expect(saveButton(page)).toBeEnabled()
      expect(await storageHolding(page, invited.token)).toEqual([STORAGE_KEY])
      expect(harness.contextBearers).toEqual([])
    }

    await saveButton(page).click()
    await expect.poll(() => harness.contextBearers).toContain(`Bearer ${invited.token}`)
    expect(harness.passwordUpdates).toHaveLength(1)
    expect(harness.leaks).toEqual([])
  })
}

test('mismatched passwords never reach the auth server', async ({ page }) => {
  const harness = await stubBackends(page)
  await openSetPassword(page, 'invite')

  await page.getByLabel('New password').fill(NEW_PASSWORD)
  await page.getByLabel('Confirm password').fill('correct horse battery staple')
  await saveButton(page).click()

  await expect(page.getByRole('alert')).toHaveText("The passwords don't match.")
  expect(harness.passwordUpdates).toEqual([])
})

test('signing out of the step ends the session and the step', async ({ page }) => {
  const harness = await stubBackends(page)
  await openSetPassword(page, 'recovery')

  await page.getByRole('button', { name: 'Sign out', exact: true }).click()

  await expect(page.locator('#auth-email')).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(harness.signOuts()).toBe(1)
  expect(harness.passwordUpdates).toEqual([])
  expect(await storageHolding(page, invited.token, invited.refresh)).toEqual([])

  await page.reload()
  await expect(page.locator('#auth-email')).toBeVisible()
  await expect(setPasswordHeading(page)).toHaveCount(0)
})

test('declining a recovery link owes no password', async ({ page }) => {
  const harness = await stubBackends(page)

  await page.goto(linkFor(invited.token, invited.refresh, 'recovery'))
  await confirmation(page, invited.email).waitFor()
  await cancelButton(page).click()

  await expect(page.locator('#auth-email')).toBeVisible()
  await page.reload()
  await expect(page.locator('#auth-email')).toBeVisible()
  await expect(setPasswordHeading(page)).toHaveCount(0)
  expect(harness.passwordUpdates).toEqual([])
})

test('a recovery link for another account replaces the session only with its new password owed', async ({ page, context }) => {
  const harness = await stubBackends(page)
  await signIn(page, harness, other)

  const opened = await context.newPage()
  harness.watch(opened)
  await openSetPassword(opened, 'recovery')
  expect(await storageHolding(opened, other.token)).toEqual([])

  await enterPassword(opened)
  await saveButton(opened).click()
  await expect.poll(() => harness.passwordUpdates).toEqual([{ bearer: `Bearer ${invited.token}`, password: NEW_PASSWORD }])
  expect(harness.leaks).toEqual([])
})

test.describe('in Spanish', () => {
  test.use({ locale: 'es-ES' })

  test('the step and its errors are translated', async ({ page }) => {
    const harness = await stubBackends(page)
    harness.passwordFailures.push({ status: 422, json: { error_code: 'same_password', msg: 'Raw server text' } })

    await page.goto(linkFor(invited.token, invited.refresh, 'recovery'))
    await page.getByRole('button', { name: 'Continuar', exact: true }).click()

    await expect(page.getByRole('heading', { name: 'Define una contraseña' })).toBeVisible()
    await page.getByLabel('Contraseña nueva').fill(NEW_PASSWORD)
    await page.getByLabel('Confirma la contraseña').fill(NEW_PASSWORD)
    await page.getByRole('button', { name: 'Guardar contraseña', exact: true }).click()
    await expect(page.getByRole('alert')).toHaveText('Elige una contraseña distinta de la actual.')
  })
})
