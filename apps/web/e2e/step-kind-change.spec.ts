import { mkdir } from 'node:fs/promises'
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3001'
const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR

type LocaleContract = {
  locale: 'en' | 'es'
  flows: string
  httpNode: string
  stepKind: string
  dialogTitle: string
  dialogBody: string
  confirm: string
  advancedJson: string
  save: string
}

const LOCALES: LocaleContract[] = [
  {
    locale: 'en',
    flows: 'Flows',
    httpNode: 'Call an API',
    stepKind: 'Step kind',
    dialogTitle: 'Change step kind?',
    dialogBody: 'Change Call an API to AI prompt? Type-specific settings will be replaced; compatible retry and timeout settings will be kept.',
    confirm: 'Change kind',
    advancedJson: 'Advanced JSON',
    save: 'Save',
  },
  {
    locale: 'es',
    flows: 'Flujos',
    httpNode: 'Llamar a una API',
    stepKind: 'Tipo de paso',
    dialogTitle: '¿Cambiar el tipo de paso?',
    dialogBody: '¿Cambiar Llamar a una API por Prompt de IA? Se reemplazarán los ajustes específicos del tipo; se conservarán los ajustes compatibles de reintentos y tiempo límite.',
    confirm: 'Cambiar tipo',
    advancedJson: 'JSON avanzado',
    save: 'Guardar',
  },
]

function headers(orgId: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-org-id': orgId,
    'x-user-id': 'dev-user',
  }
}

async function seedWorkflow(
  request: APIRequestContext,
  orgId: string,
  workflowId: string,
  workflowName: string,
): Promise<void> {
  const response = await request.post(`${API_URL}/workflows/save`, {
    headers: headers(orgId),
    data: {
      id: workflowId,
      name: workflowName,
      nodes: [{
        id: 'remote-call',
        type: 'http',
        config: {
          url: 'https://example.com/orders',
          method: 'POST',
          maxResponseBytes: 65_536,
          retry: { maxAttempts: 4, backoff: 'exponential' },
          timeoutMs: 45_000,
        },
      }],
      edges: [],
    },
  })
  if (!response.ok()) throw new Error(`seed workflow failed: ${response.status()} ${await response.text()}`)
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

async function capture(surface: Locator, name: string): Promise<void> {
  await expect(surface).toBeVisible()
  if (!EVIDENCE_DIR) return
  await mkdir(EVIDENCE_DIR, { recursive: true })
  await surface.screenshot({ path: `${EVIDENCE_DIR}/${name}.png` })
}

test.describe.configure({ mode: 'serial' })

for (const contract of LOCALES) {
  test(`${contract.locale} confirms a step-kind change and preserves only shared execution controls`, async ({ page, request }) => {
    const stamp = Date.now()
    const orgId = `step-kind-${contract.locale}-${stamp}`
    const workflowId = `step-kind-flow-${contract.locale}-${stamp}`
    const workflowName = `Step kind smoke ${contract.locale} ${stamp}`
    await seedWorkflow(request, orgId, workflowId, workflowName)
    await seedWorkflow(request, orgId, `${workflowId}-decoy`, `Unrelated flow ${contract.locale} ${stamp}`)
    const browserErrors = installConsoleErrorGuards(page)

    await page.addInitScript(({ activeOrg, locale }) => {
      window.localStorage.setItem('janusly:activeOrg', activeOrg)
      window.localStorage.setItem('janusly:locale', locale)
    }, { activeOrg: orgId, locale: contract.locale })

    await page.goto('/')
    await page.getByRole('button', { name: contract.flows, exact: true }).click()
    await page.getByTestId('workflows-search').fill(workflowName)
    const row = page.getByTestId(`workflows-row-${workflowId}`)
    await expect(row).toContainText(workflowName)
    await row.click()

    await page.locator('.workflow-node').filter({ hasText: contract.httpNode }).click()
    const inspector = page.getByTestId('inspector-node-remote-call')
    const kindSelect = inspector.getByLabel(contract.stepKind) as Locator
    await expect(kindSelect).toHaveValue('http')
    await kindSelect.focus()
    await kindSelect.selectOption('ai')

    const dialog = page.getByRole('alertdialog')
    await expect(dialog.getByRole('heading', { name: contract.dialogTitle, exact: true })).toBeVisible()
    await expect(dialog).toContainText(contract.dialogBody)
    await expect(dialog.getByRole('button', { name: contract.confirm, exact: true })).toBeFocused()
    await expect(kindSelect).toHaveValue('http')
    await hideUnrelatedOverlays(page)
    await capture(dialog, `web-${contract.locale}-step-kind-confirm`)

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(kindSelect).toBeFocused()
    await expect(kindSelect).toHaveValue('http')

    await kindSelect.selectOption('ai')
    await dialog.getByRole('button', { name: contract.confirm, exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect(kindSelect).toHaveValue('ai')

    await inspector.getByText(contract.advancedJson, { exact: true }).click()
    const configField = inspector.locator('#node-config')
    const config = JSON.parse(await configField.inputValue()) as Record<string, unknown>
    expect(config).toEqual({
      prompt: contract.locale === 'en'
        ? 'Summarize the latest workflow result and suggest the next action.'
        : 'Resume el resultado más reciente del flujo y sugiere la siguiente acción.',
      retry: { maxAttempts: 4, backoff: 'exponential' },
      timeoutMs: 45_000,
    })
    expect(config).not.toHaveProperty('url')
    expect(config).not.toHaveProperty('method')
    expect(config).not.toHaveProperty('maxResponseBytes')
    await hideUnrelatedOverlays(page)
    await capture(inspector.locator('.form-grid'), `web-${contract.locale}-step-kind-applied`)
    await capture(inspector.locator('.advanced-config'), `web-${contract.locale}-step-kind-config-preserved`)

    const saveResponse = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return response.request().method() === 'POST' && url.pathname === '/workflows/save'
    })
    await page.locator(`button.sb-workflow__ghost[aria-label="${contract.save}"]`).click()
    expect((await saveResponse).ok()).toBe(true)

    const latest = await request.get(`${API_URL}/workflows/latest?workflowId=${encodeURIComponent(workflowId)}`, {
      headers: headers(orgId),
    })
    expect(latest.ok()).toBe(true)
    const body = await latest.json() as { dagJson: { nodes: Array<{ id: string; type: string; config: Record<string, unknown> }> } }
    const savedNode = body.dagJson.nodes.find((node) => node.id === 'remote-call')
    expect(savedNode?.type).toBe('ai')
    expect(savedNode?.config).toEqual(config)
    expect(browserErrors).toEqual([])
  })
}
