import { expect, test, type Page } from '@playwright/test'

const AUTH_ORIGIN = 'http://127.0.0.1:54399'
const EMAIL = 'someone@example.com'
const SENT = 'If that email has an account, we sent a reset link. You can request another in a minute.'
const FAILED = "Couldn't send the link. Try again in a minute."
const RAW = 'Raw server text'
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': '*',
}
// The shape real GoTrue sends the client, with the version header readable or hidden by CORS.
const VERSIONED = { 'x-supabase-api-version': '2024-01-01', 'Access-Control-Expose-Headers': 'x-supabase-api-version' }
const VERSION_HIDDEN = { 'x-supabase-api-version': '2024-01-01' }

type Answer = { status: number; json: Record<string, unknown>; headers?: Record<string, string> } | 'network'
type Recover = { email: unknown; redirectTo: string | null }

async function stubAuth(page: Page, answers: Answer[] = []): Promise<Recover[]> {
  const requests: Recover[] = []
  await page.context().route('**/auth/session', (route) => route.fulfill({ status: 401, json: {} }))
  await page.context().route(`${AUTH_ORIGIN}/**`, async (route) => {
    const request = route.request()
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS })
    const url = new URL(request.url())
    if (!url.pathname.endsWith('/auth/v1/recover')) return route.fulfill({ status: 404, headers: CORS, json: {} })
    requests.push({ email: request.postDataJSON().email, redirectTo: url.searchParams.get('redirect_to') })
    const answer = answers.shift() ?? { status: 200, json: {} }
    if (answer === 'network') return route.abort()
    return route.fulfill({ ...answer, headers: { ...CORS, ...answer.headers } })
  })
  return requests
}

const sendButton = (page: Page) => page.getByRole('button', { name: 'Send reset link', exact: true })

async function openReset(page: Page): Promise<void> {
  await page.goto('/')
  await page.locator('#auth-email').fill(EMAIL)
  await page.getByRole('button', { name: 'Forgot password?', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Forgot password?' })).toBeVisible()
}

test('a request keeps the typed email and returns to this origin', async ({ page, baseURL }) => {
  const requests = await stubAuth(page)
  await openReset(page)

  await expect(page.locator('#auth-email')).toHaveValue(EMAIL)
  await expect(page.locator('#auth-email')).toBeFocused()
  await expect(page.locator('#auth-password')).toHaveCount(0)
  await expect(page.locator('#auth-sso-org')).toHaveCount(0)

  await sendButton(page).click()

  await expect(page.getByRole('status')).toHaveText(SENT)
  expect(requests).toEqual([{ email: EMAIL, redirectTo: baseURL }])
})

test('an email rate limit reads exactly like a sent link', async ({ page }) => {
  const emailLimit = { code: 'over_email_send_rate_limit', message: RAW }
  const requests = await stubAuth(page, [
    { status: 200, json: {} },
    { status: 429, json: { code: 429, error_code: 'over_email_send_rate_limit', msg: RAW } },
    { status: 429, json: emailLimit, headers: VERSIONED },
    { status: 429, json: emailLimit, headers: VERSION_HIDDEN },
  ])
  await openReset(page)

  for (const count of [1, 2, 3, 4]) {
    await sendButton(page).click()
    await expect.poll(() => requests.length).toBe(count)
    await expect(page.getByRole('status')).toHaveText(SENT)
    await expect(page.getByRole('alert')).toHaveCount(0)
    await expect(page.getByText(RAW)).toHaveCount(0)
  }
})

test('other failures report a fixed message and can be retried', async ({ page }) => {
  const requests = await stubAuth(page, [
    { status: 429, json: { code: 429, error_code: 'over_request_rate_limit', msg: RAW } },
    { status: 429, json: { code: 'over_request_rate_limit', message: RAW }, headers: VERSIONED },
    { status: 400, json: { code: 400, error_code: 'validation_failed', msg: RAW } },
    { status: 500, json: { code: 500, msg: RAW } },
    'network',
  ])
  await openReset(page)

  for (const count of [1, 2, 3, 4, 5]) {
    await sendButton(page).click()
    await expect.poll(() => requests.length).toBe(count)
    await expect(page.getByRole('alert')).toHaveText(FAILED)
    await expect(page.getByRole('status')).toHaveCount(0)
    await expect(page.getByText(RAW)).toHaveCount(0)
  }

  await sendButton(page).click()
  await expect(page.getByRole('status')).toHaveText(SENT)
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('Back returns to the login form with the email kept', async ({ page }) => {
  await stubAuth(page)
  await openReset(page)
  await sendButton(page).click()
  await page.getByRole('status').waitFor()

  await page.getByRole('button', { name: 'Back', exact: true }).click()

  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
  await expect(page.locator('#auth-email')).toHaveValue(EMAIL)
  await expect(page.locator('#auth-email')).toBeFocused()
  await expect(page.locator('#auth-password')).toBeVisible()
  await expect(page.getByRole('status')).toHaveCount(0)
})

test('signup mode does not offer a reset', async ({ page }) => {
  await stubAuth(page)
  await page.goto('/')
  await page.getByRole('button', { name: 'Need an account? Sign up', exact: true }).click()

  await expect(page.getByRole('button', { name: 'Forgot password?', exact: true })).toHaveCount(0)
})

test.describe('in Spanish', () => {
  test.use({ locale: 'es-ES' })

  test('the request and its failure are translated', async ({ page }) => {
    await stubAuth(page, [{ status: 500, json: { msg: RAW } }])
    await page.goto('/')
    await page.locator('#auth-email').fill(EMAIL)
    await page.getByRole('button', { name: '¿Olvidaste tu contraseña?', exact: true }).click()
    await expect(page.getByRole('heading', { name: '¿Olvidaste tu contraseña?' })).toBeVisible()

    const send = page.getByRole('button', { name: 'Enviar enlace', exact: true })
    await send.click()
    await expect(page.getByRole('alert')).toHaveText('No se pudo enviar el enlace. Inténtalo de nuevo en un minuto.')

    await send.click()
    await expect(page.getByRole('status')).toHaveText('Si ese correo tiene una cuenta, te enviamos un enlace. Puedes pedir otro en un minuto.')
  })
})
