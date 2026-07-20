import { mkdir } from 'node:fs/promises'
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3001'
const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR

type Json = Record<string, unknown>
type RunSnapshot = {
  run: { status: string; outputJson?: Record<string, unknown> | null }
  nodes: Array<{ nodeId: string; status: string; stateJson?: { output?: unknown } | null }>
}

const locales = {
  en: {
    flows: 'Flows',
    stepSetup: 'Step setup',
    version: 'Version pin',
    pinned: /Pinned to exact version v\d+\. Clear the field to follow latest\./,
    latest: 'Leave blank to use the latest saved version at run time.',
    invalid: 'Enter a whole version number between 1 and 2,147,483,647.',
  },
  es: {
    flows: 'Flujos',
    stepSetup: 'Configuración de paso',
    version: 'Versión fija',
    pinned: /Fijado en la versión exacta v\d+\. Borra el campo para seguir la última\./,
    latest: 'Déjalo vacío para usar la última versión guardada al ejecutar.',
    invalid: 'Escribe un número de versión entero entre 1 y 2.147.483.647.',
  },
} as const

function headers(orgId: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'x-org-id': orgId, 'x-user-id': 'dev-user' }
}

async function postJson(request: APIRequestContext, orgId: string, path: string, data: Json): Promise<Json> {
  const response = await request.post(`${API_URL}${path}`, { headers: headers(orgId), data })
  if (!response.ok()) throw new Error(`POST ${path} failed: ${response.status()} ${await response.text()}`)
  return response.json()
}

async function getJson(request: APIRequestContext, orgId: string, path: string): Promise<Json> {
  const response = await request.get(`${API_URL}${path}`, { headers: headers(orgId) })
  if (!response.ok()) throw new Error(`GET ${path} failed: ${response.status()} ${await response.text()}`)
  return response.json()
}

async function saveWorkflow(request: APIRequestContext, orgId: string, workflow: Json): Promise<void> {
  await postJson(request, orgId, '/workflows/save', workflow)
}

async function latestWorkflow(request: APIRequestContext, orgId: string, workflowId: string): Promise<Json> {
  const latest = await getJson(request, orgId, `/workflows/latest?workflowId=${encodeURIComponent(workflowId)}`)
  const dagJson = latest.dagJson
  if (!dagJson || typeof dagJson !== 'object' || Array.isArray(dagJson)) throw new Error('Latest workflow has no DAG')
  return dagJson as Json
}

async function runWorkflow(request: APIRequestContext, orgId: string, workflow: Json): Promise<RunSnapshot> {
  const started = await postJson(request, orgId, '/start', workflow) as { runId?: unknown }
  if (typeof started.runId !== 'string') throw new Error('Start response has no run id')
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const snapshot = await getJson(request, orgId, `/run?runId=${encodeURIComponent(started.runId)}`) as unknown as RunSnapshot
    if (['succeeded', 'failed', 'cancelled'].includes(snapshot.run.status)) return snapshot
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  throw new Error(`Run ${started.runId} did not reach a terminal status`)
}

function installBrowserErrorGuards(page: Page): string[] {
  const errors: string[] = []
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', error => errors.push(error.message))
  return errors
}

async function hideUnrelatedOverlays(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const selector of ['.toast', '.toast-stack', '.we-onboarding-banner', '.we-budget-banner', '[data-testid="command-palette"]']) {
      for (const element of document.querySelectorAll<HTMLElement>(selector)) element.style.display = 'none'
    }
  })
}

async function capture(surface: Locator, filename: string): Promise<void> {
  await expect(surface).toBeVisible()
  await surface.scrollIntoViewIfNeeded()
  if (!EVIDENCE_DIR) return
  await mkdir(EVIDENCE_DIR, { recursive: true })
  await surface.screenshot({ path: `${EVIDENCE_DIR}/${filename}.png`, animations: 'disabled', caret: 'hide' })
}

async function openVersionField(
  page: Page,
  locale: keyof typeof locales,
  workflowId: string,
  workflowName: string,
): Promise<{ field: Locator; surface: Locator }> {
  const contract = locales[locale]
  await page.getByRole('button', { name: contract.flows, exact: true }).click()
  const row = page.getByTestId(`workflows-row-${workflowId}`)
  await expect(row).toContainText(workflowName)
  await row.click()
  await page.getByRole('button', { name: contract.stepSetup, exact: true }).click()
  await page.locator('.react-flow__node[data-id="call-child"] .workflow-node').click()
  const surface = page.getByTestId('inspector-node-call-child').getByTestId('subworkflow-version-field')
  return { field: surface.getByLabel(contract.version), surface }
}

test('exact subworkflow versions execute deterministically and remain authorable in English and Spanish', async ({ page, request }) => {
  test.setTimeout(120_000)
  const stamp = Date.now()
  const orgId = `subworkflow-composition-${stamp}`
  const childId = `subworkflow-child-${stamp}`
  const parentId = `subworkflow-parent-${stamp}`
  const parentName = `Versioned composition ${stamp}`
  const browserErrors = installBrowserErrorGuards(page)
  let browserSaveRequests = 0
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/workflows/save') {
      browserSaveRequests += 1
    }
  })

  await saveWorkflow(request, orgId, {
    id: childId,
    name: 'Versioned child',
    outputs: { selected: 'v1' },
    nodes: [{ id: 'finish-v1', type: 'noop', config: {} }],
    edges: [],
  })
  await saveWorkflow(request, orgId, {
    id: childId,
    name: 'Versioned child',
    outputs: { selected: 'v2' },
    nodes: [{ id: 'finish-v2', type: 'noop', config: {} }],
    edges: [],
  })
  await saveWorkflow(request, orgId, {
    id: parentId,
    name: parentName,
    outputs: { selected: '{{context.call-child.output.selected}}' },
    nodes: [{ id: 'call-child', type: 'subworkflow', config: { workflowId: childId, version: 1 } }],
    edges: [],
  })

  const pinnedV1 = await runWorkflow(request, orgId, await latestWorkflow(request, orgId, parentId))
  expect(pinnedV1.run.status).toBe('succeeded')
  expect(pinnedV1.run.outputJson).toMatchObject({ selected: 'v1' })
  expect(pinnedV1.nodes.find(node => node.nodeId === 'call-child')?.stateJson?.output).toMatchObject({ selected: 'v1' })

  await page.addInitScript(({ activeOrg }) => {
    window.localStorage.setItem('janusly:activeOrg', activeOrg)
    if (!window.localStorage.getItem('janusly:locale')) window.localStorage.setItem('janusly:locale', 'en')
  }, { activeOrg: orgId })
  await page.goto('/')

  for (const locale of ['en', 'es'] as const) {
    if (locale === 'es') {
      await page.evaluate(() => window.localStorage.setItem('janusly:locale', 'es'))
      await page.reload()
    }
    await hideUnrelatedOverlays(page)
    const { field, surface } = await openVersionField(page, locale, parentId, parentName)
    await field.blur()
    await expect(surface.getByText(locales[locale].pinned)).toBeVisible()
    await capture(surface, `web-${locale}-subworkflow-version-pinned`)

    await field.fill('')
    await field.blur()
    await expect(surface.getByText(locales[locale].latest, { exact: true })).toBeVisible()
    await capture(surface, `web-${locale}-subworkflow-version-latest`)

    await field.fill('0')
    await field.blur()
    await expect(field).toHaveAttribute('aria-invalid', 'true')
    await expect(surface.getByText(locales[locale].invalid, { exact: true })).toBeVisible()
    await capture(surface, `web-${locale}-subworkflow-version-invalid`)

    const savesBeforeInvalidShortcut = browserSaveRequests
    await field.focus()
    await expect(field).toBeFocused()
    const invalidValidation = page.waitForResponse(response =>
      response.request().method() === 'POST' && new URL(response.url()).pathname === '/validate',
    )
    await page.keyboard.press('ControlOrMeta+s')
    expect((await invalidValidation).ok()).toBe(true)
    await page.waitForTimeout(100)
    expect(browserSaveRequests).toBe(savesBeforeInvalidShortcut)
    const unchanged = await latestWorkflow(request, orgId, parentId) as { nodes?: Array<{ id?: string; config?: Json }> }
    expect(unchanged.nodes?.find(node => node.id === 'call-child')?.config?.version).toBe(locale === 'en' ? 1 : 2)

    if (locale === 'en') {
      await field.fill('2')
      await expect(field).toBeFocused()
      const saveResponse = page.waitForResponse(response =>
        response.request().method() === 'POST' && new URL(response.url()).pathname === '/workflows/save',
      )
      await page.keyboard.press('ControlOrMeta+s')
      expect((await saveResponse).ok()).toBe(true)
      const saved = await latestWorkflow(request, orgId, parentId) as { nodes?: Array<{ id?: string; config?: Json }> }
      expect(saved.nodes?.find(node => node.id === 'call-child')?.config?.version).toBe(2)
    }
  }

  const pinnedV2 = await runWorkflow(request, orgId, await latestWorkflow(request, orgId, parentId))
  expect(pinnedV2.run.status).toBe('succeeded')
  expect(pinnedV2.run.outputJson).toMatchObject({ selected: 'v2' })
  expect(browserErrors).toEqual([])
})
