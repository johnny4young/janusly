import { mkdir } from 'node:fs/promises'
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3001'
const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR

type LocaleContract = {
  locale: 'en' | 'es'
  flows: string
  empty: string
}

const LOCALES: LocaleContract[] = [
  { locale: 'en', flows: 'Flows', empty: 'Trash is empty' },
  { locale: 'es', flows: 'Flujos', empty: 'La Papelera está vacía' },
]

function headers(orgId: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-org-id': orgId,
    'x-user-id': 'dev-user',
  }
}

async function seedDeletedWorkflow(
  request: APIRequestContext,
  orgId: string,
  workflowId: string,
  name: string,
): Promise<void> {
  const save = await request.post(`${API_URL}/workflows/save`, {
    headers: headers(orgId),
    data: { id: workflowId, name, nodes: [{ id: 'n1', type: 'noop' }], edges: [] },
  })
  if (!save.ok()) throw new Error(`save ${workflowId} failed: ${save.status()} ${await save.text()}`)

  const remove = await request.delete(`${API_URL}/workflows/${workflowId}`, {
    headers: headers(orgId),
  })
  if (!remove.ok()) throw new Error(`delete ${workflowId} failed: ${remove.status()} ${await remove.text()}`)
}

function installConsoleErrorGuards(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

async function hideUnrelatedOverlays(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const selector of ['.toast', '.we-onboarding-banner', '.we-budget-banner', '[data-testid="command-palette"]']) {
      for (const element of document.querySelectorAll<HTMLElement>(selector)) element.style.display = 'none'
    }
  })
}

async function captureSurface(surface: Locator, name: string): Promise<void> {
  await expect(surface).toBeVisible()
  if (!EVIDENCE_DIR) return
  await mkdir(EVIDENCE_DIR, { recursive: true })
  await surface.screenshot({ path: `${EVIDENCE_DIR}/${name}.png` })
}

test.describe.configure({ mode: 'serial' })

for (const contract of LOCALES) {
  test(`${contract.locale} trash keeps list, selection, restore, and empty states intact`, async ({ page, request }) => {
    const stamp = Date.now()
    const orgId = `trash-smoke-${contract.locale}-${stamp}`
    const workflowId = `trash-flow-${contract.locale}-${stamp}`
    const workflowName = `Trash smoke ${contract.locale} ${stamp}`
    await seedDeletedWorkflow(request, orgId, workflowId, workflowName)
    const browserErrors = installConsoleErrorGuards(page)

    await page.addInitScript(({ activeOrg, locale }) => {
      window.localStorage.setItem('janusly:activeOrg', activeOrg)
      window.localStorage.setItem('janusly:locale', locale)
    }, { activeOrg: orgId, locale: contract.locale })

    await page.goto('/')
    await page.getByRole('button', { name: contract.flows, exact: true }).click()
    await page.getByTestId('workflows-trash-toggle').click()

    const list = page.getByTestId('workflows-trash-list')
    const row = page.getByTestId(`workflows-trash-row-${workflowId}`)
    const surface = list.locator('..')
    await expect(row).toContainText(workflowName)
    await hideUnrelatedOverlays(page)
    await captureSurface(surface, `web-${contract.locale}-workflow-trash-list`)

    const select = page.getByTestId(`workflows-trash-select-${workflowId}`)
    const restoreSelected = page.getByTestId('workflows-trash-restore-selected')
    await select.check()
    await expect(select).toBeChecked()
    await expect(select).toBeFocused()
    await expect(restoreSelected).toBeEnabled()
    await captureSurface(surface, `web-${contract.locale}-workflow-trash-selected`)

    const restoreResponse = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return response.request().method() === 'POST' && url.pathname === `/workflows/${workflowId}/restore`
    })
    await restoreSelected.click()
    expect((await restoreResponse).ok()).toBe(true)
    const empty = page.getByTestId('workflows-trash-empty')
    await expect(empty).toContainText(contract.empty)
    await expect(list).toHaveCount(0)
    await hideUnrelatedOverlays(page)
    await captureSurface(empty.locator('..'), `web-${contract.locale}-workflow-trash-empty`)
    expect(browserErrors).toEqual([])
  })
}
