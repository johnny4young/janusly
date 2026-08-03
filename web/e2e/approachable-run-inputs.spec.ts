import { mkdir } from 'node:fs/promises'
import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from '@playwright/test'

import { expectNoBlockingAccessibilityViolations } from './_helpers/accessibility'
import { openWorkspaceSection } from './_helpers/workspace-navigation'

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3001'
const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR

const LOCALES = {
  en: {
    workflows: 'Workflows',
    build: 'Build',
    run: 'Run',
    submit: 'Run workflow',
    required: 'Required',
    optional: 'Optional',
    selectFalse: 'No',
    keys: {
      id: 'invoiceId',
      retries: 'retry_count',
      notify: 'notifyCustomer',
      tags: 'tags',
    },
    labels: {
      id: 'Invoice ID',
      retries: 'Retry Count',
      notify: 'Notify Customer',
      tags: 'Tags',
    },
    values: {
      id: 'INV-2042',
      tags: '["priority", "renewal"]',
    },
  },
  es: {
    workflows: 'Flujos',
    build: 'Crear',
    run: 'Ejecutar',
    submit: 'Ejecutar flujo',
    required: 'Obligatorio',
    optional: 'Opcional',
    selectFalse: 'No',
    keys: {
      id: 'factura_id',
      retries: 'reintentos',
      notify: 'notificarCliente',
      tags: 'etiquetas',
    },
    labels: {
      id: 'Factura ID',
      retries: 'Reintentos',
      notify: 'Notificar Cliente',
      tags: 'Etiquetas',
    },
    values: {
      id: 'FAC-2042',
      tags: '["prioridad", "renovación"]',
    },
  },
} as const

function headers(orgId: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-org-id': orgId,
    'x-user-id': 'dev-user',
  }
}

async function waitForSuccessfulRun(
  request: APIRequestContext,
  orgId: string,
  runId: string,
): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const response = await request.get(`${API_URL}/run?runId=${encodeURIComponent(runId)}`, {
      headers: headers(orgId),
    })
    if (!response.ok()) {
      throw new Error(`GET run failed: ${response.status()} ${await response.text()}`)
    }
    const snapshot = await response.json() as { run?: { status?: string } }
    const status = snapshot.run?.status
    if (status === 'succeeded') return
    if (status && ['failed', 'cancelled'].includes(status)) {
      throw new Error(`Run ${runId} finished with status ${status}`)
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Run ${runId} did not succeed`)
}

async function seedWorkflow(
  request: APIRequestContext,
  orgId: string,
  workflowId: string,
  workflowName: string,
  locale: keyof typeof LOCALES,
): Promise<void> {
  const { keys } = LOCALES[locale]
  const response = await request.post(`${API_URL}/workflows/save`, {
    headers: headers(orgId),
    data: {
      id: workflowId,
      name: workflowName,
      inputs: {
        type: 'object',
        properties: {
          [keys.id]: { type: 'string' },
          [keys.retries]: { type: 'number', default: 3 },
          [keys.notify]: { type: 'boolean' },
          [keys.tags]: { type: 'array', items: { type: 'string' } },
        },
        required: [keys.id, keys.notify],
      },
      nodes: [{ id: 'complete', type: 'noop', config: {} }],
      edges: [],
    },
  })
  if (!response.ok()) {
    throw new Error(`seed workflow failed: ${response.status()} ${await response.text()}`)
  }
}

function installBrowserErrorGuards(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
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

test.describe.configure({ mode: 'serial' })

for (const locale of ['en', 'es'] as const) {
  const copy = LOCALES[locale]

  test(`${locale} configures declared run inputs without exposing schema syntax`, async ({ page, request }) => {
    const stamp = Date.now()
    const orgId = `approachable-run-inputs-${locale}-${stamp}`
    const workflowId = `run-input-flow-${locale}-${stamp}`
    const workflowName = locale === 'en' ? 'Invoice follow-up' : 'Seguimiento de facturas'
    await seedWorkflow(request, orgId, workflowId, workflowName, locale)
    const browserErrors = installBrowserErrorGuards(page)

    await page.addInitScript(({ activeOrg, selectedLocale }) => {
      window.localStorage.setItem('janusly:activeOrg', activeOrg)
      window.localStorage.setItem('janusly:locale', selectedLocale)
    }, { activeOrg: orgId, selectedLocale: locale })

    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto('/')
    await page.getByRole('button', { name: copy.workflows, exact: true }).click()
    const workflowRow = page.getByTestId(`workflows-row-${workflowId}`)
    await expect(workflowRow).toContainText(workflowName)
    await workflowRow.click()
    await openWorkspaceSection(page, copy.workflows, copy.build)
    await page.getByRole('button', { name: copy.run, exact: true }).click()

    const dialog = page.getByRole('dialog', { name: workflowName })
    await expect(dialog).toBeVisible()
    const idInput = dialog.getByRole('textbox', { name: copy.labels.id })
    const retriesInput = dialog.getByRole('spinbutton', { name: copy.labels.retries })
    const notifyInput = dialog.getByRole('combobox', { name: copy.labels.notify })
    const tagsInput = dialog.getByRole('textbox', { name: copy.labels.tags })
    await expect(idInput).toBeFocused()
    await expect(retriesInput).toHaveValue('3')
    await expect(notifyInput).toHaveValue('')
    await expect(dialog.getByText(copy.required, { exact: true })).toHaveCount(2)
    await expect(dialog.getByText(copy.optional, { exact: true })).toHaveCount(2)
    await expect(dialog).not.toContainText(copy.keys.id)
    await expect(dialog).not.toContainText(copy.keys.notify)

    await expectNoBlockingAccessibilityViolations(page, `${locale} run input dialog`)
    await capture(dialog, `web-${locale}-run-inputs`)

    await page.setViewportSize({ width: 390, height: 844 })
    await expect(dialog).toBeVisible()
    const overflow = await dialog.evaluate((element) => element.scrollWidth - element.clientWidth)
    expect(overflow).toBeLessThanOrEqual(2)
    await capture(page.locator('.run-input-backdrop'), `web-${locale}-run-inputs-mobile`)
    await page.setViewportSize({ width: 1280, height: 800 })

    await dialog.getByRole('button', { name: copy.submit, exact: true }).click()
    await expect(dialog.getByText(
      locale === 'en'
        ? `${copy.labels.id} is required`
        : `${copy.labels.id} es obligatorio`,
      { exact: true },
    )).toBeVisible()
    await expect(dialog.getByText(
      locale === 'en'
        ? `${copy.labels.notify} is required`
        : `${copy.labels.notify} es obligatorio`,
      { exact: true },
    )).toBeVisible()

    await idInput.fill(copy.values.id)
    await notifyInput.selectOption({ label: copy.selectFalse })
    await tagsInput.fill(copy.values.tags)
    const startResponse = page.waitForResponse((incoming) => (
      incoming.request().method() === 'POST'
      && new URL(incoming.url()).pathname === '/start'
    ))
    await dialog.getByRole('button', { name: copy.submit, exact: true }).click()

    const response = await startResponse
    expect(response.ok(), await response.text()).toBe(true)
    const payload = response.request().postDataJSON() as {
      input?: Record<string, unknown>
    }
    expect(payload.input).toEqual({
      [copy.keys.id]: copy.values.id,
      [copy.keys.retries]: 3,
      [copy.keys.notify]: false,
      [copy.keys.tags]: JSON.parse(copy.values.tags),
    })
    const started = await response.json() as { runId?: unknown }
    expect(typeof started.runId).toBe('string')
    await waitForSuccessfulRun(request, orgId, String(started.runId))
    await expect(dialog).toBeHidden()
    expect(browserErrors).toEqual([])
  })
}
