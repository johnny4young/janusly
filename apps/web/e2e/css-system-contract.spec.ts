import { mkdir } from 'node:fs/promises'
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3001'
const DEV_HEADERS = { 'Content-Type': 'application/json', 'x-org-id': 'default', 'x-user-id': 'dev-user' }
const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR

const copy = {
  en: { flows: 'Flows', connections: 'Connections' },
  es: { flows: 'Flujos', connections: 'Conexiones' },
} as const

async function saveTaggedWorkflow(
  request: APIRequestContext,
  id: string,
  tag: string,
): Promise<void> {
  const save = await request.post(`${API_URL}/workflows/save`, {
    headers: DEV_HEADERS,
    data: { id, name: `CSS contract ${id}`, nodes: [{ id: 'n1', type: 'noop' }], edges: [] },
  })
  if (!save.ok()) throw new Error(`save ${id} failed: ${save.status()} ${await save.text()}`)

  const metadata = await request.post(`${API_URL}/workflows/${id}/metadata`, {
    headers: DEV_HEADERS,
    data: { metadata: { owners: [], tags: [tag] } },
  })
  if (!metadata.ok()) {
    throw new Error(`metadata ${id} failed: ${metadata.status()} ${await metadata.text()}`)
  }
}

function installBrowserErrorGuards(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') {
      errors.push(`${message.type()}: ${message.text()}`)
    }
  })
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  return errors
}

async function capture(surface: Locator, filename: string): Promise<void> {
  await expect(surface).toBeVisible()
  if (!EVIDENCE_DIR) return
  await mkdir(EVIDENCE_DIR, { recursive: true })
  await surface.screenshot({
    path: `${EVIDENCE_DIR}/${filename}.png`,
    animations: 'disabled',
    caret: 'hide',
  })
}

test('canonical card and pill CSS contracts render in both locales', async ({ page, request }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1440, height: 1000 })
  const errors = installBrowserErrorGuards(page)
  const stamp = Date.now()
  const workflowId = `e2e-css-contract-${stamp}`
  const tag = `css-contract-${stamp}`
  await saveTaggedWorkflow(request, workflowId, tag)

  await page.addInitScript(() => {
    if (!window.localStorage.getItem('janusly:locale')) {
      window.localStorage.setItem('janusly:locale', 'en')
    }
  })

  for (const locale of ['en', 'es'] as const) {
    if (locale === 'en') {
      await page.goto('/')
    } else {
      await page.evaluate(() => window.localStorage.setItem('janusly:locale', 'es'))
      await page.reload()
    }
    await expect(page.getByText('dev-user')).toBeVisible()

    await page.getByRole('button', { name: copy[locale].flows, exact: true }).click()
    const row = page.getByTestId(`workflows-row-${workflowId}`)
    await expect(row).toBeVisible()
    const pill = row.getByText(tag, { exact: true })
    await expect(pill).toHaveClass(/\bwe-pill\b/)
    await expect(pill).toHaveAttribute('data-tone', 'ghost')
    await expect.poll(() => pill.evaluate((element) => {
      const style = getComputedStyle(element)
      return { border: style.borderTopStyle, radius: style.borderRadius }
    })).toEqual({ border: 'solid', radius: '999px' })
    await expect(page.locator('.panel-card')).toHaveCount(0)
    await capture(row, `web-${locale}-css-system-flow-pill`)

    await page.getByRole('button', { name: copy[locale].connections, exact: true }).click()
    const card = page.locator('section.we-card.connection-form')
    await expect(card).toBeVisible()
    await expect.poll(() => card.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        border: style.borderTopStyle,
        painted: style.backgroundColor !== 'rgba(0, 0, 0, 0)',
      }
    })).toEqual({ border: 'solid', painted: true })
    await expect(page.locator('.panel-card')).toHaveCount(0)
    const overflow = await card.evaluate((element) => element.scrollWidth - element.clientWidth)
    expect(overflow).toBeLessThanOrEqual(2)
    await capture(card, `web-${locale}-css-system-connection-card`)
  }

  expect(errors).toEqual([])
})
