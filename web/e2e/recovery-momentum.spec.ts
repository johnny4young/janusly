import { openActivityRecoveryDetail } from './_helpers/workspace-navigation'
/**
 * Real-browser proof for validation-drill inspection and truthful replay feedback.
 * Each case uses a private dev-header org and the product's own demo-failure
 * injection, so exact evidence and replay states are backed by the live API,
 * worker, and Postgres stack without fabricating operator-queue work.
 */

import { mkdir } from 'node:fs/promises'
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'

const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR
const API_URL = process.env.E2E_API_URL ?? 'http://127.0.0.1:3001'

type LocaleContract = {
  locale: 'en' | 'es'
  homeName: RegExp
  retryName: string
  recoveringText: string
  cleanPosture: string
  queuedToast: string
}

const ENGLISH: LocaleContract = {
  locale: 'en',
  homeName: /^Home\b/,
  retryName: 'Retry',
  recoveringText: 'Replaying',
  cleanPosture: 'Recovery posture is clean',
  queuedToast: 'Replay queued',
}

const SPANISH: LocaleContract = {
  locale: 'es',
  homeName: /^Inicio\b/,
  retryName: 'Reintentar',
  recoveringText: 'Reintentando',
  cleanPosture: 'La postura de recuperación está limpia',
  queuedToast: 'Reintento en cola',
}

async function hideUnrelatedOverlays(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const selector of ['.toast', '.we-onboarding-banner', '.we-budget-banner', '[data-testid="command-palette"]']) {
      for (const element of document.querySelectorAll<HTMLElement>(selector)) element.style.display = 'none'
    }
  })
}

async function captureElement(
  locator: Locator,
  name: string,
  options: { finishAnimations?: boolean } = {},
): Promise<void> {
  await expect(locator).toBeVisible()
  if (!EVIDENCE_DIR) return
  await mkdir(EVIDENCE_DIR, { recursive: true })
  if (options.finishAnimations !== false) {
    await locator.evaluate((element) => {
      for (const animation of element.getAnimations({ subtree: true })) {
        const endTime = animation.effect?.getComputedTiming().endTime
        if (typeof endTime === 'number' && Number.isFinite(endTime)) animation.finish()
      }
    })
  }
  await locator.screenshot({ path: `${EVIDENCE_DIR}/${name}.png` })
}

async function waitForHealthRingToSettle(hero: Locator): Promise<void> {
  const ring = hero.locator('.we-recovery-center-ring')
  await expect(ring).toBeVisible()
  const score = (await ring.getAttribute('aria-label'))?.match(/\d+/)?.[0]
  if (score) await expect(ring.locator('.we-recovery-center-ring__value')).toHaveText(score)
}

async function prepareIsolatedSession(page: Page, locale: 'en' | 'es', reducedMotion: boolean): Promise<string> {
  const orgId = `recovery-momentum-${locale}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  await page.emulateMedia({ reducedMotion: reducedMotion ? 'reduce' : 'no-preference' })
  await page.addInitScript(({ activeOrg, selectedLocale }) => {
    window.localStorage.setItem('janusly:activeOrg', activeOrg)
    window.localStorage.setItem('janusly:locale', selectedLocale)
    window.localStorage.removeItem('janusly:recovery:hideIntro')
  }, { activeOrg: orgId, selectedLocale: locale })
  return orgId
}

async function injectDemoFailure(request: APIRequestContext, orgId: string): Promise<string> {
  const response = await request.post(`${API_URL}/solution-packs/failed-payment-recovery/inject-failure`, {
    headers: {
      'Content-Type': 'application/json',
      'x-org-id': orgId,
      'x-user-id': 'dev-user',
    },
    data: {},
  })
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { deadLetterId: string }).deadLetterId
}

async function runRecoveryCycle(
  page: Page,
  contract: LocaleContract,
  options: { reducedMotion: boolean },
): Promise<{ consoleErrors: string[]; pageErrors: string[] }> {
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await prepareIsolatedSession(page, contract.locale, options.reducedMotion)
  await page.goto('/')
  await page.getByTestId('home-insights-toggle').click()

  const drillButton = page.getByTestId('recovery-center-empty-cta-drill')
  await expect(drillButton).toBeVisible()
  const drillResponsePromise = page.waitForResponse((response) => (
    response.url().includes('/solution-packs/')
    && response.url().endsWith('/inject-failure')
    && response.request().method() === 'POST'
  ))
  await drillButton.click()
  const drillResponse = await drillResponsePromise
  expect(drillResponse.ok()).toBe(true)
  const drill = await drillResponse.json() as { deadLetterId: string }
  let detail = page.getByTestId('activity-recovery-detail')
  await expect(detail).toHaveAttribute('data-dead-letter-id', drill.deadLetterId, { timeout: 30_000 })
  await expect(detail.getByTestId('dlq-recovery-drill-context')).toBeVisible()

  await page.getByRole('button', { name: contract.homeName }).click()
  const hero = page.locator('.we-recovery-center-hero')
  await waitForHealthRingToSettle(hero)
  await expect(hero).toContainText(contract.cleanPosture)
  await expect(page.getByTestId('recovery-center-action-triage_failures')).toHaveCount(0)
  await hideUnrelatedOverlays(page)
  await captureElement(hero, `web-${contract.locale}-recovery-hero-drill-isolated`)
  await captureElement(page.locator('.workspace-main'), `web-${contract.locale}-home-drill-isolated-workspace`)

  detail = await openActivityRecoveryDetail(page, drill.deadLetterId)
  const retry = detail.getByRole('button', { name: contract.retryName, exact: true })
  await expect(retry).toBeVisible()

  let releaseReplay: (() => void) | undefined
  const replayGate = new Promise<void>((resolve) => { releaseReplay = resolve })
  await page.route('**/dlq/replay', async (route) => {
    await replayGate
    await route.continue()
  }, { times: 1 })

  const replayResponse = page.waitForResponse((response) => (
    response.url().endsWith('/dlq/replay') && response.request().method() === 'POST'
  ))
  let replayRequested = false
  try {
    await retry.click()
    replayRequested = true
    const recovering = detail.locator('.status-pill')
    await expect(recovering).toHaveText(contract.recoveringText)
    await expect(retry).toBeDisabled()
    await expect(detail.getByRole('button', { name: /Resolve|Resolver/ })).toBeDisabled()
    await hideUnrelatedOverlays(page)
    await captureElement(detail, `web-${contract.locale}-activity-recovery-loading`, { finishAnimations: false })

    releaseReplay?.()
    expect((await replayResponse).ok()).toBe(true)
  } finally {
    releaseReplay?.()
    if (replayRequested) await replayResponse.catch(() => undefined)
    await page.unroute('**/dlq/replay')
  }

  const queuedToast = page.getByText(contract.queuedToast)
  await expect(queuedToast).toBeVisible()
  await captureElement(queuedToast.locator('..'), `web-${contract.locale}-recovery-toast-queued`)

  await page.getByRole('button', { name: contract.homeName }).click()
  await expect(hero).toContainText(contract.cleanPosture)
  await expect(page.getByTestId('recovery-center-action-triage_failures')).toHaveCount(0)
  await waitForHealthRingToSettle(hero)
  await hideUnrelatedOverlays(page)
  await captureElement(hero, `web-${contract.locale}-recovery-hero-drill-replayed`, { finishAnimations: false })

  return { consoleErrors, pageErrors }
}

test.describe.configure({ mode: 'serial' })

test('English validation drill keeps optimistic replay and queue isolation truthful', async ({ page }) => {
  test.setTimeout(90_000)
  const errors = await runRecoveryCycle(page, ENGLISH, { reducedMotion: false })
  expect(errors.consoleErrors).toEqual([])
  expect(errors.pageErrors).toEqual([])
})

test('Spanish validation drill keeps queued feedback truthful with reduced motion', async ({ page }) => {
  test.setTimeout(90_000)
  const errors = await runRecoveryCycle(page, SPANISH, { reducedMotion: true })
  expect(errors.consoleErrors).toEqual([])
  expect(errors.pageErrors).toEqual([])
})

test('two validation drills stay inspectable without fabricating operator work', async ({ page, request }) => {
  test.setTimeout(90_000)
  const orgId = await prepareIsolatedSession(page, 'en', false)
  await page.goto('/')

  await page.getByTestId('home-insights-toggle').click()
  const firstDrillResponse = page.waitForResponse((response) => (
    response.url().includes('/solution-packs/')
    && response.url().endsWith('/inject-failure')
    && response.request().method() === 'POST'
  ))
  await page.getByTestId('recovery-center-empty-cta-drill').click()
  const firstId = ((await (await firstDrillResponse).json()) as { deadLetterId: string }).deadLetterId
  const secondId = await injectDemoFailure(request, orgId)

  const countsResponse = await request.get(`${API_URL}/dlq/counts`, {
    headers: { 'x-org-id': orgId, 'x-user-id': 'dev-user' },
  })
  expect(countsResponse.ok()).toBe(true)
  await expect(countsResponse.json()).resolves.toMatchObject({ total: 0, open: 0 })

  const firstDetail = await openActivityRecoveryDetail(page, firstId)
  await firstDetail.getByRole('button', { name: ENGLISH.retryName, exact: true }).click()
  await expect(page.getByText(ENGLISH.queuedToast)).toBeVisible()

  const secondDetail = await openActivityRecoveryDetail(page, secondId)
  await expect(secondDetail.getByTestId('dlq-recovery-drill-context')).toBeVisible()

  await page.getByRole('button', { name: ENGLISH.homeName }).click()
  const hero = page.locator('.we-recovery-center-hero')
  await expect(hero).toContainText(ENGLISH.cleanPosture)
  await expect(page.getByTestId('recovery-center-action-triage_failures')).toHaveCount(0)
})
