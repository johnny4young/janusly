import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { expectNoBlockingAccessibilityViolations } from './_helpers/accessibility'
import {
  openWorkflowAiAction,
  openWorkspaceSection,
} from './_helpers/workspace-navigation'
import {
  REAL_MODEL,
  REAL_PROVIDER,
  validateGenerationCase,
} from '../../../scripts/real-provider-policy.mjs'

const enabled = process.env.JANUSLY_REAL_PROVIDER_E2E === '1'
const evidenceDir = process.env.JANUSLY_EVIDENCE_DIR
const apiUrl = process.env.E2E_API_URL ?? 'http://127.0.0.1:7311'
const orgId = process.env.JANUSLY_LOCAL_ORG_ID ?? 'default'
const datasetPath = new URL('../../../evals/provider-qualification.json', import.meta.url)
const headers = {
  'content-type': 'application/json',
  'x-org-id': orgId,
  'x-user-id': 'local-real-provider',
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
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
  const path = `${evidenceDir}/${name}.png`
  await page.screenshot({
    path,
    fullPage: true,
    animations: 'disabled',
    caret: 'hide',
  })
  await chmod(path, 0o600)
}

async function writeEvidence(name: string, value: unknown) {
  if (!evidenceDir) return
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 })
  await writeFile(
    `${evidenceDir}/${name}.json`,
    `${JSON.stringify(value, null, 2)}\n`,
    { mode: 0o600 },
  )
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

test('real Anthropic generation remains observable in AI Studio and Usage', async ({
  page,
  request,
}) => {
  test.setTimeout(240_000)
  test.skip(!enabled, 'requires explicit real-provider qualification')
  expect(evidenceDir).toBeTruthy()
  const browserErrors = guardBrowserErrors(page)
  const dataset = JSON.parse(await readFile(datasetPath, 'utf8')) as {
    generationCases: Array<{
      id: string
      locale: string
      execution: string
      parityGroup?: string
      prompt: string
      expect: Record<string, unknown>
    }>
  }
  const testCase = dataset.generationCases.find(
    ({ execution }) => execution === 'browser',
  )
  expect(testCase).toBeTruthy()

  const healthResponse = await request.get(`${apiUrl}/ai/health`, { headers })
  expect(healthResponse.ok()).toBe(true)
  const health = await healthResponse.json() as {
    enabled: boolean
    provider: string
    model: string
  }
  expect({
    enabled: health.enabled,
    provider: health.provider,
    model: health.model,
  }).toEqual({
    enabled: true,
    provider: REAL_PROVIDER,
    model: REAL_MODEL,
  })

  await page.addInitScript(({ activeOrg }) => {
    window.localStorage.setItem('janusly:activeOrg', activeOrg)
    window.localStorage.setItem('janusly:locale', 'en')
    window.localStorage.setItem('janusly:recovery:hideIntro', 'true')
  }, { activeOrg: orgId })
  await page.goto('/')
  await openWorkflowAiAction(page, 'Workflows')
  await expect(page.locator('.copilot-hero')).toContainText('AI is connected')
  await expect(page.locator('.copilot-hero')).toContainText(REAL_MODEL)

  const responsePromise = page.waitForResponse((response) =>
    response.request().method() === 'POST'
    && new URL(response.url()).pathname === '/ai/generate-workflow')
  await page.locator('.copilot-prompt').fill(testCase!.prompt)
  await page.getByRole('button', { name: 'Draft flow', exact: true }).click()
  const generationResponse = await responsePromise
  expect(generationResponse.ok()).toBe(true)
  const body = await generationResponse.json()
  const result = validateGenerationCase(
    testCase,
    body,
    REAL_PROVIDER,
    REAL_MODEL,
  )
  expect(result.issues).toEqual([])
  expect(result.safetyIssues).toEqual([])
  await writeEvidence('browser-generation-result', result)

  await expect(page.locator('.result-panel')).toContainText('Flow drafted by AI')
  await expect(page.locator('.result-panel .mode-pill-ai')).toBeVisible()
  await expect(page.locator('.workflow-node').filter({ hasText: 'Ask approval' })).toBeVisible()
  await capture(page, 'real-provider-ai-studio-en')
  await expectHealthySurface(page, 'English real-provider AI Studio result')

  await changeLocale(page, 'es')
  await openWorkspaceSection(page, 'Configuración', 'Espacio de trabajo')
  await page.getByTestId('operations-rail-tab-usage').click()
  const costTable = page.getByTestId('settings-usage-cost-table')
  await expect(costTable).toHaveAccessibleName('Tabla de desglose de costo')
  await expect(costTable).toContainText(REAL_PROVIDER)
  await expect(costTable).toContainText(REAL_MODEL)
  await capture(page, 'real-provider-usage-es')
  await expectHealthySurface(page, 'Spanish real-provider usage')

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(costTable).toBeVisible()
  await expect(costTable).toHaveAttribute('tabindex', '0')
  const compactTable = await costTable.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }))
  expect(compactTable.clientWidth).toBeGreaterThan(0)
  expect(compactTable.scrollWidth).toBeGreaterThan(compactTable.clientWidth)
  await capture(page, 'real-provider-usage-es-mobile')
  await expectHealthySurface(page, 'compact Spanish real-provider usage')

  expect(browserErrors).toEqual([])
})
