import { mkdir } from 'node:fs/promises'
import { expect, test, type APIRequestContext, type APIResponse, type Page } from '@playwright/test'
import { expectNoBlockingAccessibilityViolations } from './_helpers/accessibility'
import { openWorkspaceSection } from './_helpers/workspace-navigation'

const enabled = process.env.JANUSLY_LOCAL_TENANT_ISOLATION_E2E === '1'
const evidenceDir = process.env.JANUSLY_EVIDENCE_DIR
const apiUrl = process.env.JANUSLY_TENANT_API_URL ?? 'http://127.0.0.1:7311'
const ownerEmail = process.env.JANUSLY_TENANT_OWNER_EMAIL ?? 'owner@tenant.local'
const memberEmail = process.env.JANUSLY_TENANT_MEMBER_EMAIL ?? 'member@tenant.local'
const password = process.env.JANUSLY_TENANT_PASSWORD ?? 'Tenant-identity-2026!'
const alphaName = process.env.JANUSLY_TENANT_ALPHA_NAME ?? 'Tenant Alpha'
const betaName = process.env.JANUSLY_TENANT_BETA_NAME ?? 'Tenant Beta'
const alphaWorkflowId = process.env.JANUSLY_TENANT_ALPHA_WORKFLOW_ID ?? 'tenant-alpha-workflow'
const betaWorkflowId = process.env.JANUSLY_TENANT_BETA_WORKFLOW_ID ?? 'tenant-beta-workflow'
const alphaWorkflowName = process.env.JANUSLY_TENANT_ALPHA_WORKFLOW_NAME ?? 'Alpha workflow'
const betaWorkflowName = process.env.JANUSLY_TENANT_BETA_WORKFLOW_NAME ?? 'Beta workflow'
const alphaCredentialName = process.env.JANUSLY_TENANT_ALPHA_CREDENTIAL ?? 'alpha-credential'
const betaCredentialName = process.env.JANUSLY_TENANT_BETA_CREDENTIAL ?? 'beta-credential'
const alphaSecret = process.env.JANUSLY_TENANT_ALPHA_SECRET ?? 'alpha-secret'
const betaSecret = process.env.JANUSLY_TENANT_BETA_SECRET ?? 'beta-secret'
const betaInviteEmail = process.env.JANUSLY_TENANT_BETA_INVITE_EMAIL ?? 'beta-only@tenant.local'

type AuthHeaders = Record<string, string>

type TenantSeed = {
  orgId: string
  workflowId: string
  workflowName: string
  credentialName: string
  runId: string
  invitationId: string
  inviteEmail: string
  timeoutMs: number
}

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

async function signUp(page: Page, email: string) {
  await page.getByRole('button', { name: 'Need an account? Sign up' }).click()
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign up', exact: true }).click()
}

async function openUserMenu(page: Page) {
  const popover = page.locator('.user-menu__popover')
  if (await popover.isVisible().catch(() => false)) return
  await page.locator('.user-menu__trigger').click()
  await expect(popover).toBeVisible()
}

async function signOut(page: Page) {
  await openUserMenu(page)
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible()
}

async function changeLocale(page: Page, locale: 'en' | 'es') {
  await page.locator('.user-menu__trigger').click()
  await page
    .getByLabel(/^(Change language|Cambiar idioma)$/)
    .selectOption(locale)
  await expect(page.locator('html')).toHaveAttribute('lang', locale)
  await page.locator('.user-menu__trigger').click()
  await expect(page.locator('.user-menu__popover')).toBeHidden()
}

async function sessionHeaders(page: Page): Promise<AuthHeaders> {
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

async function parseJson<T>(response: APIResponse, context: string): Promise<T> {
  const text = await response.text()
  expect(response.ok(), `${context} returned ${response.status()}: ${text}`).toBe(true)
  return JSON.parse(text) as T
}

async function getJson<T>(
  request: APIRequestContext,
  path: string,
  headers: AuthHeaders,
): Promise<T> {
  return parseJson<T>(
    await request.get(`${apiUrl}${path}`, { headers }),
    `GET ${path}`,
  )
}

async function postJson<T>(
  request: APIRequestContext,
  path: string,
  headers: AuthHeaders,
  data: unknown,
): Promise<T> {
  return parseJson<T>(
    await request.post(`${apiUrl}${path}`, { headers, data }),
    `POST ${path}`,
  )
}

async function seedTenant(
  request: APIRequestContext,
  headers: AuthHeaders,
  input: {
    workflowId: string
    workflowName: string
    credentialName: string
    secret: string
    inviteEmail: string
    timeoutMs: number
  },
): Promise<TenantSeed> {
  const workflow = {
    dslVersion: '1.0',
    id: input.workflowId,
    name: input.workflowName,
    nodes: [{ id: 'complete', type: 'noop', config: {} }],
    edges: [],
  }
  await postJson(request, '/workflows/save', headers, workflow)
  const started = await postJson<{ runId: string }>(
    request,
    '/start',
    headers,
    workflow,
  )
  await expect.poll(async () => {
    const status = await getJson<{ run: { status: string } }>(
      request,
      `/status?runId=${encodeURIComponent(started.runId)}`,
      headers,
    )
    return status.run.status
  }, { timeout: 30_000 }).toBe('succeeded')

  await postJson<{ id: string }>(request, '/credentials', headers, {
    name: input.credentialName,
    kind: 'generic',
    secretValue: input.secret,
  })
  await postJson(request, '/org/config', headers, {
    key: 'http.timeoutMs',
    value: input.timeoutMs,
  })
  const invitation = await postJson<{ id: string }>(
    request,
    '/members/invite',
    headers,
    { email: input.inviteEmail, role: 'viewer' },
  )

  return {
    orgId: headers['x-org-id'],
    workflowId: input.workflowId,
    workflowName: input.workflowName,
    credentialName: input.credentialName,
    runId: started.runId,
    invitationId: invitation.id,
    inviteEmail: input.inviteEmail,
    timeoutMs: input.timeoutMs,
  }
}

function expectOnlyOrg<T extends { orgId: string }>(rows: T[], orgId: string) {
  expect(rows.length).toBeGreaterThan(0)
  expect([...new Set(rows.map((row) => row.orgId))]).toEqual([orgId])
}

async function assertTenantLists(
  request: APIRequestContext,
  headers: AuthHeaders,
  expected: TenantSeed,
  absent: TenantSeed,
) {
  const workflows = await getJson<Array<{ id: string; orgId: string }>>(
    request,
    '/workflows?limit=200',
    headers,
  )
  expectOnlyOrg(workflows, expected.orgId)
  expect(workflows.map(({ id }) => id)).toContain(expected.workflowId)
  expect(workflows.map(({ id }) => id)).not.toContain(absent.workflowId)

  const runs = await getJson<Array<{ id: string; orgId: string }>>(
    request,
    '/runs?limit=200',
    headers,
  )
  expectOnlyOrg(runs, expected.orgId)
  expect(runs.map(({ id }) => id)).toContain(expected.runId)
  expect(runs.map(({ id }) => id)).not.toContain(absent.runId)

  const credentials = await getJson<Array<{ name: string; orgId: string }>>(
    request,
    '/credentials',
    headers,
  )
  expectOnlyOrg(credentials, expected.orgId)
  expect(credentials.map(({ name }) => name)).toContain(expected.credentialName)
  expect(credentials.map(({ name }) => name)).not.toContain(absent.credentialName)

  const invitationResponse = await getJson<{
    invitations: Array<{ id: string; orgId: string }>
  }>(
    request,
    '/members/invitations',
    headers,
  )
  const { invitations } = invitationResponse
  expectOnlyOrg(invitations, expected.orgId)
  expect(invitations.map(({ id }) => id)).toContain(expected.invitationId)
  expect(invitations.map(({ id }) => id)).not.toContain(absent.invitationId)

  const members = await getJson<Array<{ orgId: string }>>(
    request,
    '/members',
    headers,
  )
  expectOnlyOrg(members, expected.orgId)

  const audit = await getJson<{
    rows: Array<{ orgId: string }>
  }>(request, '/audit?limit=200', headers)
  expectOnlyOrg(audit.rows, expected.orgId)

  const config = await getJson<{
    config: Array<{ key: string; orgId: string; value: unknown }>
  }>(request, '/org/config', headers)
  expect(config.config.every((entry) => entry.orgId === expected.orgId)).toBe(true)
  expect(config.config.find(({ key }) => key === 'http.timeoutMs')?.value).toBe(
    expected.timeoutMs,
  )
}

async function assertCrossTenantIdsStayInvisible(
  request: APIRequestContext,
  alphaHeaders: AuthHeaders,
  beta: TenantSeed,
) {
  const latest = await request.get(
    `${apiUrl}/workflows/latest?workflowId=${encodeURIComponent(beta.workflowId)}`,
    { headers: alphaHeaders },
  )
  expect(latest.status()).toBe(404)

  const run = await request.get(
    `${apiUrl}/run?runId=${encodeURIComponent(beta.runId)}`,
    { headers: alphaHeaders },
  )
  expect(run.status()).toBe(403)

  const workflowDelete = await request.delete(
    `${apiUrl}/workflows/${encodeURIComponent(beta.workflowId)}`,
    { headers: alphaHeaders },
  )
  expect(workflowDelete.status()).toBe(404)

  const credentialDelete = await request.delete(
    `${apiUrl}/credentials/${encodeURIComponent(beta.credentialName)}`,
    { headers: alphaHeaders },
  )
  expect(credentialDelete.status()).toBe(404)

  const invitationRevoke = await request.post(
    `${apiUrl}/members/invitations/${encodeURIComponent(beta.invitationId)}/revoke`,
    { headers: alphaHeaders },
  )
  expect(invitationRevoke.status()).toBe(404)
}

test('real identities keep tenant data, direct identifiers, and workspace UI isolated', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000)
  test.skip(!enabled, 'requires the local tenant-isolation qualification profile')
  const browserErrors = guardBrowserErrors(page)
  await page.addInitScript(() => window.localStorage.setItem('janusly:locale', 'en'))

  await page.goto('/')
  await signUp(page, ownerEmail)
  await expect(page.getByRole('heading', { name: 'Set up your workspace' })).toBeVisible()
  await page.getByLabel('Your name').fill('Tenant Owner')
  await page.getByLabel('Organization name').fill(alphaName)
  await page.getByRole('button', { name: 'Create workspace' }).click()
  await expect(page.getByRole('button', { name: 'Open user menu' })).toBeVisible()

  const alphaHeaders = await sessionHeaders(page)
  const alpha = await seedTenant(request, alphaHeaders, {
    workflowId: alphaWorkflowId,
    workflowName: alphaWorkflowName,
    credentialName: alphaCredentialName,
    secret: alphaSecret,
    inviteEmail: memberEmail,
    timeoutMs: 4_100,
  })

  await openUserMenu(page)
  await page.getByRole('button', { name: 'New workspace · invite' }).click()
  await page.getByLabel('Organization name').fill(betaName)
  await page.getByRole('button', { name: 'Create workspace' }).click()
  await expect(page.locator('.bottom-status-bar')).toContainText(betaName)

  const betaHeaders = await sessionHeaders(page)
  const beta = await seedTenant(request, betaHeaders, {
    workflowId: betaWorkflowId,
    workflowName: betaWorkflowName,
    credentialName: betaCredentialName,
    secret: betaSecret,
    inviteEmail: betaInviteEmail,
    timeoutMs: 5_200,
  })

  await assertTenantLists(request, alphaHeaders, alpha, beta)
  await assertTenantLists(request, betaHeaders, beta, alpha)
  await assertCrossTenantIdsStayInvisible(request, alphaHeaders, beta)
  await assertTenantLists(request, betaHeaders, beta, alpha)

  await changeLocale(page, 'es')
  await page.getByRole('button', { name: 'Flujos', exact: true }).click()
  await expect(page.getByTestId(`workflows-row-${beta.workflowId}`)).toContainText(
    beta.workflowName,
  )
  await expect(page.getByTestId(`workflows-row-${alpha.workflowId}`)).toHaveCount(0)
  await expectHealthySurface(page, 'beta workflow inventory in Spanish')
  await capture(page, 'tenant-owner-beta-workflows-es')

  await changeLocale(page, 'en')
  await openUserMenu(page)
  await page.getByRole('button', { name: `Switch to ${alphaName}` }).click()
  await expect(page.locator('.bottom-status-bar')).toContainText(alphaName)
  await page.getByRole('button', { name: 'Workflows', exact: true }).click()
  await expect(page.getByTestId(`workflows-row-${alpha.workflowId}`)).toContainText(
    alpha.workflowName,
  )
  await expect(page.getByTestId(`workflows-row-${beta.workflowId}`)).toHaveCount(0)
  await expectHealthySurface(page, 'alpha workflow inventory in English')
  await capture(page, 'tenant-owner-alpha-workflows-en')

  await openWorkspaceSection(page, 'Settings', 'Connections')
  await expect(page.getByText(alpha.credentialName)).toBeVisible()
  await expect(page.getByText(beta.credentialName)).toHaveCount(0)
  await expectHealthySurface(page, 'alpha connection inventory in English')
  await capture(page, 'tenant-owner-alpha-connections-en')

  await signOut(page)
  await signUp(page, memberEmail)
  await expect(page.getByRole('heading', { name: 'Set up your workspace' })).toBeVisible()
  await page.getByRole('button', { name: /Accept$/ }).click()
  await expect(page.locator('.bottom-status-bar')).toContainText(alphaName)

  const memberHeaders = await sessionHeaders(page)
  const memberContext = await getJson<{
    organizations: Array<{ id: string; name: string }>
  }>(request, '/auth/context', memberHeaders)
  expect(memberContext.organizations).toEqual([
    expect.objectContaining({ id: alpha.orgId, name: alphaName }),
  ])
  expect(memberContext.organizations).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ id: beta.orgId })]),
  )

  const forgedBetaScope = await request.get(`${apiUrl}/workflows`, {
    headers: { ...memberHeaders, 'x-org-id': beta.orgId },
  })
  expect(forgedBetaScope.status()).toBe(401)

  await page.getByRole('button', { name: 'Workflows', exact: true }).click()
  await expect(page.getByTestId(`workflows-row-${alpha.workflowId}`)).toContainText(
    alpha.workflowName,
  )
  await expect(page.getByTestId(`workflows-row-${beta.workflowId}`)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'New workflow', exact: true }).first())
    .toBeDisabled()
  await openUserMenu(page)
  await expect(page.getByRole('button', { name: `Switch to ${betaName}` })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expectHealthySurface(page, 'single-tenant viewer workspace')
  await capture(page, 'tenant-member-alpha-workflows-en')

  expect(browserErrors).toEqual([])
})
