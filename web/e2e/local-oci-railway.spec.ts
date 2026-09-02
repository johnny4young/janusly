import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { expectNoBlockingAccessibilityViolations } from './_helpers/accessibility'
import { openWorkflowAiAction } from './_helpers/workspace-navigation'
import { applyBuiltWorkflowProposal, buildWorkflowProposal } from './_helpers/workflow-authoring'

const enabled = process.env.JANUSLY_LOCAL_OCI_E2E === '1'
const evidenceDir = process.env.JANUSLY_EVIDENCE_DIR
const apiUrl = process.env.E2E_API_URL ?? 'http://127.0.0.1:7320'
const orgId = 'oci-browser-no-key'
const headers = { 'x-org-id': orgId, 'x-user-id': 'dev-user' }

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
  await page.screenshot({
    path: `${evidenceDir}/${name}.png`,
    fullPage: true,
    animations: 'disabled',
    caret: 'hide',
  })
}

async function expectHealthySurface(page: Page, context: string) {
  await expectNoBlockingAccessibilityViolations(page, context)
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(2)
}

async function changeLocale(page: Page, locale: 'en' | 'es') {
  const trigger = page.locator('.user-menu__trigger')
  await trigger.click()
  await page
    .getByLabel(/^(Change language|Cambiar idioma)$/)
    .selectOption(locale)
  await expect(page.locator('html')).toHaveAttribute('lang', locale)
  await trigger.click()
  await expect(page.locator('.user-menu__popover')).toBeHidden()
}

test('production OCI works without Anthropic and explains local mode in both locales', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000)
  test.skip(!enabled, 'requires the isolated production OCI qualification')
  const browserErrors = guardBrowserErrors(page)

  const aiHealth = await request.get(`${apiUrl}/ai/health`, { headers })
  expect(aiHealth.ok()).toBe(true)
  await expect(aiHealth.json()).resolves.toMatchObject({
    enabled: false,
    model: 'claude-haiku-4-5-20251001',
  })

  await page.addInitScript(({ activeOrg }) => {
    window.localStorage.setItem('janusly:activeOrg', activeOrg)
    window.localStorage.setItem('janusly:locale', 'en')
    window.localStorage.setItem('janusly:recovery:hideIntro', 'true')
  }, { activeOrg: orgId })
  await page.goto('/')
  await openWorkflowAiAction(page, 'Workflows')

  const hero = page.locator('.ai-studio-hero')
  await expect(hero).toContainText('Local mode is active')
  await expect(hero).toContainText('Configure ANTHROPIC_API_KEY for the API and worker')
  await expect(page.getByText('Root .env has ANTHROPIC_API_KEY')).toBeVisible()
  await page.locator('.ai-studio-prompt').fill('Create a flow with human approval before writing')
  const englishProposal = await buildWorkflowProposal(page)
  await expect(
    englishProposal.getByRole('status').filter({ hasText: 'Deterministic local proposal' }),
  ).toBeVisible()
  await applyBuiltWorkflowProposal(page)
  await expectHealthySurface(page, 'English production OCI AI Studio without provider')
  await capture(page, 'oci-no-key-ai-studio-en')

  // Use the product control rather than mutating storage behind the running
  // i18n store. This proves the operator-visible switch and preserves the
  // already-open AI Studio surface.
  await changeLocale(page, 'es')
  await expect(hero).toContainText('Modo local activo')
  await expect(hero).toContainText('Configura ANTHROPIC_API_KEY para la API y el worker')
  await expect(page.getByText('El archivo .env de la raíz contiene ANTHROPIC_API_KEY')).toBeVisible()
  await page.locator('.ai-studio-prompt').fill('Crea un flujo con aprobación humana antes de escribir')
  const spanishProposal = await buildWorkflowProposal(page, 'es')
  await expect(
    spanishProposal.getByRole('status').filter({ hasText: 'Propuesta local determinista' }),
  ).toBeVisible()
  await applyBuiltWorkflowProposal(page, 'es')
  await expectHealthySurface(page, 'Spanish production OCI AI Studio without provider')
  await capture(page, 'oci-no-key-ai-studio-es')

  expect(browserErrors).toEqual([])
})
