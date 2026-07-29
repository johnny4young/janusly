import { openWorkflowAiAction } from './_helpers/workspace-navigation'
import { expect, test, type Page } from '@playwright/test'

async function forceLocalAiMode(page: Page) {
  await page.route('**/ai/health', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ enabled: false, model: 'claude-haiku-4-5-20251001', timeoutMs: 30_000, maxRetries: 2 }),
    })
  })
}

test('AI Studio local mode points operators to the supported Anthropic key in both locales', async ({ page }) => {
  const browserErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text())
  })
  page.on('pageerror', (error) => browserErrors.push(error.message))

  await forceLocalAiMode(page)
  await page.goto('/')
  await openWorkflowAiAction(page, 'Workflows')

  const englishHero = page.locator('.copilot-hero')
  await expect(englishHero).toContainText(
    'Configure ANTHROPIC_API_KEY for the API and worker, then restart both.',
  )
  await expect(page.getByText('Root .env has ANTHROPIC_API_KEY')).toBeVisible()
  await expect(page.getByText(/OPENAI_API_KEY/)).toHaveCount(0)

  await page.evaluate(() => window.localStorage.setItem('janusly:locale', 'es'))
  await page.reload()
  await openWorkflowAiAction(page, 'Flujos')

  const spanishHero = page.locator('.copilot-hero')
  await expect(spanishHero).toContainText(
    'Configura ANTHROPIC_API_KEY para la API y el worker y reinicia ambos.',
  )
  await expect(page.getByText('El archivo .env de la raíz contiene ANTHROPIC_API_KEY')).toBeVisible()
  await expect(page.getByText(/OPENAI_API_KEY/)).toHaveCount(0)
  expect(browserErrors).toEqual([])
})
