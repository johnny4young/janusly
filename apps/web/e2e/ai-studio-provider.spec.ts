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
  await page.getByRole('button', { name: /^AI Studio\b/ }).click()

  const englishHero = page.locator('.copilot-hero')
  await expect(englishHero).toContainText('Add ANTHROPIC_API_KEY to the root .env')
  await expect(page.getByText('Root .env has ANTHROPIC_API_KEY')).toBeVisible()
  await expect(page.getByText(/OPENAI_API_KEY/)).toHaveCount(0)

  await page.evaluate(() => window.localStorage.setItem('janusly:locale', 'es'))
  await page.reload()
  await page.getByRole('button', { name: /^AI Studio\b/ }).click()

  const spanishHero = page.locator('.copilot-hero')
  await expect(spanishHero).toContainText('Agrega ANTHROPIC_API_KEY al archivo .env de la raíz')
  await expect(page.getByText('El archivo .env de la raíz contiene ANTHROPIC_API_KEY')).toBeVisible()
  await expect(page.getByText(/OPENAI_API_KEY/)).toHaveCount(0)
  expect(browserErrors).toEqual([])
})
