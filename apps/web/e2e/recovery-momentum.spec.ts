/**
 * Real-browser proof for recovery momentum and truthful replay feedback.
 * Each case uses a private dev-header org and the product's own demo-failure
 * injection, so all queue, heatmap, metrics, and replay states are
 * backed by the live API, worker, Postgres, and Redis stack.
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
  longestDowntime: RegExp
  queuedToast: string
}

const ENGLISH: LocaleContract = {
  locale: 'en',
  homeName: /^Home\b/,
  retryName: 'Retry',
  recoveringText: 'Recovering…',
  longestDowntime: /^Longest downtime:/,
  queuedToast: 'Replay queued',
}

const SPANISH: LocaleContract = {
  locale: 'es',
  homeName: /^Inicio\b/,
  retryName: 'Reintentar',
  recoveringText: 'Recuperando…',
  longestDowntime: /^Inactividad más larga:/,
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

async function injectDemoFailure(request: APIRequestContext, orgId: string): Promise<void> {
  const response = await request.post(`${API_URL}/solution-packs/failed-payment-recovery/inject-failure`, {
    headers: {
      'Content-Type': 'application/json',
      'x-org-id': orgId,
      'x-user-id': 'dev-user',
    },
    data: {},
  })
  expect(response.ok()).toBe(true)
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

  const demoButton = page.getByTestId('recovery-center-empty-cta-demo')
  await expect(demoButton).toBeVisible()
  await demoButton.click()

  const queue = page.getByTestId('recovery-queue')
  await expect(queue).toBeVisible()
  const row = queue.locator('[data-dead-letter-id]').first()
  await expect(row).toBeVisible()

  await page.getByRole('button', { name: contract.homeName }).click()
  const hero = page.locator('.we-recovery-center-hero')
  await expect(hero.getByTestId('recovery-center-longest-downtime')).toHaveText(contract.longestDowntime)
  await waitForHealthRingToSettle(hero)
  await hideUnrelatedOverlays(page)
  await captureElement(hero, `web-${contract.locale}-recovery-hero-action`)

  await hero.getByTestId('recovery-center-open-queue').click()
  await expect(queue).toBeVisible()
  const activeRow = queue.locator('[data-dead-letter-id]').first()
  await activeRow.click()
  const detail = queue.locator('.detail-box')
  const retry = detail.getByRole('button', { name: contract.retryName })
  await expect(retry).toBeVisible()

  let releaseReplay: (() => void) | undefined
  const replayGate = new Promise<void>((resolve) => { releaseReplay = resolve })
  await page.route('**/dlq/replay', async (route) => {
    await replayGate
    await route.continue()
  }, { times: 1 })

  try {
    await retry.click()
    const recovering = queue.locator('[data-testid^="dlq-recovering-"]')
    await expect(recovering).toHaveText(contract.recoveringText)
    await expect(retry).toBeDisabled()
    await expect(detail.getByRole('button', { name: /Resolve|Resolver/ })).toBeDisabled()
    await hideUnrelatedOverlays(page)
    await captureElement(detail, `web-${contract.locale}-recovery-queue-loading`, { finishAnimations: false })

    const replayResponse = page.waitForResponse((response) => (
      response.url().endsWith('/dlq/replay') && response.request().method() === 'POST'
    ))
    releaseReplay?.()
    expect((await replayResponse).ok()).toBe(true)
  } finally {
    releaseReplay?.()
    await page.unroute('**/dlq/replay')
  }

  const queuedToast = page.getByText(contract.queuedToast)
  await expect(queuedToast).toBeVisible()
  await captureElement(queuedToast.locator('..'), `web-${contract.locale}-recovery-toast-queued`)

  await page.getByRole('button', { name: contract.homeName }).click()
  await expect(hero).not.toHaveAttribute('data-all-clear', 'true')
  await expect(hero.getByTestId('celebration-burst')).toHaveCount(0)
  await expect(hero.getByTestId('recovery-center-all-clear-summary')).toHaveCount(0)
  await waitForHealthRingToSettle(hero)
  await hideUnrelatedOverlays(page)
  await captureElement(hero, `web-${contract.locale}-recovery-hero-replay-queued`, { finishAnimations: false })

  return { consoleErrors, pageErrors }
}

test.describe.configure({ mode: 'serial' })

test('English recovery momentum shows action, optimistic replay, and truthful queued feedback', async ({ page }) => {
  test.setTimeout(90_000)
  const errors = await runRecoveryCycle(page, ENGLISH, { reducedMotion: false })
  expect(errors.consoleErrors).toEqual([])
  expect(errors.pageErrors).toEqual([])
})

test('Spanish recovery momentum keeps queued feedback truthful with reduced motion', async ({ page }) => {
  test.setTimeout(90_000)
  const errors = await runRecoveryCycle(page, SPANISH, { reducedMotion: true })
  expect(errors.consoleErrors).toEqual([])
  expect(errors.pageErrors).toEqual([])
})

test('replaying one of two failures never publishes a false all-clear', async ({ page, request }) => {
  test.setTimeout(90_000)
  const orgId = await prepareIsolatedSession(page, 'en', false)
  await page.goto('/')

  await page.getByTestId('recovery-center-empty-cta-demo').click()
  await expect(page.getByTestId('recovery-queue')).toBeVisible()
  await injectDemoFailure(request, orgId)
  await page.reload()
  await page.getByRole('button', { name: 'Runs', exact: true }).click()

  const queue = page.getByTestId('recovery-queue')
  await expect(queue.locator('[data-dead-letter-id]')).toHaveCount(2)
  await queue.locator('[data-dead-letter-id]').first().click()
  await queue.locator('.detail-box').getByRole('button', { name: ENGLISH.retryName }).click()
  await expect(page.getByText(ENGLISH.queuedToast)).toBeVisible()

  await page.getByRole('button', { name: ENGLISH.homeName }).click()
  const hero = page.locator('.we-recovery-center-hero')
  // A retry can fail again and replace the claimed dead letter with a fresh
  // one. The truthful contract is that recovery work remains visible, not
  // that the transient open count must fall from two to exactly one.
  await expect(hero.getByTestId('recovery-center-greeting')).toContainText(/needs? recovery/)
  await expect(hero.getByTestId('celebration-burst')).toHaveCount(0)
})
