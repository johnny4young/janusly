/**
 * Real-stack proof for memory consent transparency, signed per-org form-link
 * expiry, scheduled deletion, bilingual UI, and the memory audit preset.
 */

import { mkdir } from 'node:fs/promises'
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3001'
const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR

type LocaleContract = {
  locale: 'en' | 'es'
  governanceHeading: string
  auditPreset: string
  ttlLabel: RegExp
}

const LOCALES: LocaleContract[] = [
  {
    locale: 'en',
    governanceHeading: 'Memory governance',
    auditPreset: 'Memory events',
    ttlLabel: /Human-form link TTL/i,
  },
  {
    locale: 'es',
    governanceHeading: 'Gobierno de la memoria',
    auditPreset: 'Eventos de memoria',
    ttlLabel: /Vigencia del enlace de formulario/i,
  },
]

function headers(orgId: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-org-id': orgId,
    'x-user-id': 'dev-user',
  }
}

async function getJson(request: APIRequestContext, orgId: string, path: string): Promise<Record<string, unknown>> {
  const response = await request.get(`${API_URL}${path}`, { headers: headers(orgId) })
  if (!response.ok()) throw new Error(`GET ${path} failed: ${response.status()} ${await response.text()}`)
  return response.json()
}

async function postJson(
  request: APIRequestContext,
  orgId: string,
  path: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await request.post(`${API_URL}${path}`, { headers: headers(orgId), data })
  if (!response.ok()) throw new Error(`POST ${path} failed: ${response.status()} ${await response.text()}`)
  return response.json()
}

async function setConfig(request: APIRequestContext, orgId: string, key: string, value: unknown): Promise<void> {
  await postJson(request, orgId, '/org/config', { key, value })
}

async function waitForHumanForm(request: APIRequestContext, orgId: string, runId: string): Promise<string> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < 30_000) {
    const snapshot = await getJson(request, orgId, `/run?runId=${encodeURIComponent(runId)}`)
    const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes as Array<Record<string, unknown>> : []
    const node = nodes.find((candidate) => candidate.nodeId === 'collect')
    if (node?.status === 'waiting') {
      const state = node.stateJson as { waiting?: { resumeToken?: unknown } } | null
      const token = state?.waiting?.resumeToken
      if (typeof token === 'string') return token
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error(`run ${runId} did not reach the human-form wait`)
}

function decodeToken(token: string): { issuedAt: number; expiresAt: number } {
  const encoded = token.split('.')[1]
  if (!encoded) throw new Error('resume token payload is missing')
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
}

function installErrorGuards(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

async function hideUnrelatedOverlays(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const selector of ['.toast-stack', '.toast', '.we-onboarding-banner', '.we-budget-banner', '[data-testid="command-palette"]']) {
      for (const element of document.querySelectorAll<HTMLElement>(selector)) element.style.display = 'none'
    }
  })
}

async function capture(locator: Locator, name: string): Promise<void> {
  await expect(locator).toBeVisible()
  if (!EVIDENCE_DIR) return
  await mkdir(EVIDENCE_DIR, { recursive: true })
  await locator.screenshot({ path: `${EVIDENCE_DIR}/${name}.png` })
}

test.describe.configure({ mode: 'serial' })

for (const contract of LOCALES) {
  test(`${contract.locale} exposes consent, purge, form-link expiry, and memory audit`, async ({ page, request }) => {
    test.setTimeout(90_000)
    const stamp = `${contract.locale}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const orgId = `memory-governance-${stamp}`
    const errors = installErrorGuards(page)

    await page.addInitScript(({ activeOrg, locale }) => {
      window.localStorage.setItem('janusly:activeOrg', activeOrg)
      window.localStorage.setItem('janusly:locale', locale)
    }, { activeOrg: orgId, locale: contract.locale })

    const processStatus = await getJson(request, orgId, '/memory/consent-status')
    test.skip(processStatus.processEnabled !== true, 'requires JANUSLY_MEMORY_ENABLED=true')

    await setConfig(request, orgId, 'memory.enabled', true)
    await expect.poll(async () => getJson(request, orgId, '/memory/consent-status')).toMatchObject({
      enabled: true,
      processEnabled: true,
      tenantEnabled: true,
      purge: { status: 'none', scheduledFor: null },
    })

    await setConfig(request, orgId, 'runs.humanFormResumeTtlSeconds', 900)
    const { runId } = await postJson(request, orgId, '/start', {
      id: `memory-governance-flow-${stamp}`,
      name: `Memory governance ${stamp}`,
      nodes: [{
        id: 'collect',
        type: 'human_form',
        config: {
          title: 'Review evidence',
          schema: { type: 'object', properties: { note: { type: 'string' } } },
        },
      }],
      edges: [],
    }) as { runId: string }
    const tokenPayload = decodeToken(await waitForHumanForm(request, orgId, runId))
    expect(tokenPayload.expiresAt - tokenPayload.issuedAt).toBe(900)

    await setConfig(request, orgId, 'memory.enabled', false)
    await expect.poll(async () => getJson(request, orgId, '/memory/consent-status')).toMatchObject({
      enabled: false,
      processEnabled: true,
      tenantEnabled: false,
      purge: { status: 'scheduled' },
    })
    const revokedStatus = await getJson(request, orgId, '/memory/consent-status')
    const scheduledFor = (revokedStatus.purge as { scheduledFor?: unknown } | undefined)?.scheduledFor
    expect(typeof scheduledFor).toBe('string')
    expect(Date.parse(scheduledFor as string)).toBeGreaterThan(Date.now())

    await page.goto('/')
    const countdown = page.getByTestId('memory-purge-countdown')
    await expect(countdown).toBeVisible()
    await hideUnrelatedOverlays(page)
    await capture(countdown, `web-${contract.locale}-memory-purge-hero-scheduled`)

    await countdown.getByRole('button').click()
    await expect(page.getByRole('heading', { name: contract.governanceHeading, exact: true })).toBeVisible()
    const governance = page.getByTestId('memory-governance-panel')
    await expect(governance).toContainText(contract.locale === 'en'
      ? 'Memory deletion is scheduled for'
      : 'La memoria se eliminará el')
    await hideUnrelatedOverlays(page)
    await capture(governance, `web-${contract.locale}-memory-governance-scheduled`)

    const ttlInput = page.getByRole('spinbutton', { name: contract.ttlLabel })
    await expect(ttlInput).toHaveValue('900')
    await capture(ttlInput.locator('..'), `web-${contract.locale}-human-form-link-ttl`)

    const audit = page.getByTestId('audit-log-panel')
    await audit.getByRole('button', { name: contract.auditPreset, exact: true }).click()
    await expect(audit).toContainText('memory.consent.revoked')
    await capture(audit, `web-${contract.locale}-memory-audit-filtered`)

    expect(errors).toEqual([])
  })
}
