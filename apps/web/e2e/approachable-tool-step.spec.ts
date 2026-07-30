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
    save: 'Save',
    run: 'Run',
    toolSearch: 'Find a tool',
    tool: 'Tool',
    toolInput: 'Tool input',
    credential: 'Credential',
    owner: 'Owner',
    repo: 'Repository',
    title: 'Title',
    body: 'Body',
    value: 'Value',
    advancedInput: 'Advanced JSON',
    writeCapable: 'May change external systems',
    readOnly: 'Read-only',
  },
  es: {
    workflows: 'Flujos',
    build: 'Crear',
    save: 'Guardar',
    run: 'Ejecutar',
    toolSearch: 'Buscar una herramienta',
    tool: 'Herramienta',
    toolInput: 'Entrada de la herramienta',
    credential: 'Credencial',
    owner: 'Propietario',
    repo: 'Repositorio',
    title: 'Título',
    body: 'Contenido',
    value: 'Valor',
    advancedInput: 'JSON avanzado',
    writeCapable: 'Puede modificar sistemas externos',
    readOnly: 'Solo lectura',
  },
} as const

type RunSnapshot = {
  run: { status: string }
  nodes: Array<{
    nodeId: string
    status: string
    stateJson?: { output?: unknown } | null
  }>
}

function headers(orgId: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-org-id': orgId,
    'x-user-id': 'dev-user',
  }
}

async function postJson(
  request: APIRequestContext,
  orgId: string,
  path: string,
  data: Record<string, unknown>,
): Promise<unknown> {
  const response = await request.post(`${API_URL}${path}`, {
    headers: headers(orgId),
    data,
  })
  const text = await response.text()
  expect(response.ok(), `${path}: ${response.status()} ${text}`).toBe(true)
  return text ? JSON.parse(text) : null
}

async function seedWorkflow(
  request: APIRequestContext,
  orgId: string,
  workflowId: string,
  workflowName: string,
): Promise<void> {
  await postJson(request, orgId, '/workflows/save', {
    id: workflowId,
    name: workflowName,
    nodes: [{
      id: 'normalize',
      type: 'tool',
      config: {
        tool: 'text.lowercase',
        input: { value: 'STALE INPUT' },
      },
    }],
    edges: [],
    ui: {
      positions: {
        normalize: { x: 260, y: 180 },
      },
    },
  })
}

async function pollTerminalRun(
  request: APIRequestContext,
  orgId: string,
  runId: string,
): Promise<RunSnapshot> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const response = await request.get(`${API_URL}/run?runId=${encodeURIComponent(runId)}`, {
      headers: headers(orgId),
    })
    const text = await response.text()
    expect(response.ok(), `/run: ${response.status()} ${text}`).toBe(true)
    const snapshot = JSON.parse(text) as RunSnapshot
    if (['succeeded', 'failed', 'cancelled'].includes(snapshot.run.status)) return snapshot
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Run ${runId} did not reach a terminal state`)
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

  test(`${locale} explains, persists, and executes a deterministic tool step`, async ({ page, request }) => {
    test.setTimeout(90_000)
    const stamp = Date.now()
    const orgId = `approachable-tool-${locale}-${stamp}`
    const workflowId = `normalize-tool-${locale}-${stamp}`
    const workflowName = locale === 'en' ? 'Normalize customer name' : 'Normalizar nombre del cliente'
    await seedWorkflow(request, orgId, workflowId, workflowName)
    const browserErrors = installBrowserErrorGuards(page)

    await page.addInitScript(({ activeOrg, selectedLocale }) => {
      window.localStorage.setItem('janusly:activeOrg', activeOrg)
      window.localStorage.setItem('janusly:locale', selectedLocale)
    }, { activeOrg: orgId, selectedLocale: locale })

    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto('/')
    await page.getByRole('button', { name: copy.workflows, exact: true }).click()
    const workflowRow = page.getByTestId(`workflows-row-${workflowId}`)
    await expect(workflowRow).toContainText(workflowName)
    await workflowRow.click()
    await openWorkspaceSection(page, copy.workflows, copy.build)

    const canvas = page.locator('.canvas-frame[data-mode="author"]')
    await canvas.locator('.react-flow__node[data-id="normalize"] .workflow-node').click()
    const inspector = page.getByTestId('inspector-node-normalize')
    const editor = inspector.getByTestId('tool-config')
    await expect(editor).toBeVisible()

    const search = editor.getByLabel(copy.toolSearch, { exact: true })
    const picker = editor.getByLabel(copy.tool, { exact: true })
    await search.fill('github.create_issue')
    await picker.selectOption('github.create_issue')
    await expect(editor.getByTestId('tool-capability')).toContainText(copy.writeCapable)
    await expect(editor.getByLabel(new RegExp(`^${copy.credential}`))).toHaveValue('bot-github')
    await expect(editor.getByLabel(new RegExp(`^${copy.owner}`))).toHaveValue('janusly')
    await expect(editor.getByLabel(new RegExp(`^${copy.repo}`))).toHaveValue('demo')
    await expect(editor.getByLabel(new RegExp(`^${copy.title}`))).toHaveValue('Incident triage')
    await expect(editor.getByLabel(new RegExp(`^${copy.body}`))).toHaveValue('Details…')
    await expect(editor.getByText('STALE INPUT')).toHaveCount(0)
    await editor.getByLabel(new RegExp(`^${copy.credential}`)).scrollIntoViewIfNeeded()
    await capture(page.locator('.app-shell'), `web-${locale}-tool-fields-write-capability`)

    await search.fill('text.uppercase')
    await picker.selectOption('text.uppercase')
    await expect(editor.getByTestId('tool-capability')).toContainText(copy.readOnly)
    const valueInput = editor.getByLabel(new RegExp(`^${copy.value}`))
    await expect(valueInput).toHaveValue('hello')
    await valueInput.fill('hola Janusly')
    await valueInput.blur()

    await editor.getByText(copy.advancedInput, { exact: true }).click()
    const advancedInput = editor.getByLabel(copy.toolInput, { exact: true })
    await expect(advancedInput).toHaveValue(/"value": "hola Janusly"/)
    await capture(page.locator('.app-shell'), `web-${locale}-tool-fields-advanced-json`)
    await editor.getByText(copy.advancedInput, { exact: true }).click()

    await expectNoBlockingAccessibilityViolations(page, `${locale} approachable tool step`)
    await search.scrollIntoViewIfNeeded()
    await capture(page.locator('.app-shell'), `web-${locale}-tool-fields-editor`)

    await page.setViewportSize({ width: 1024, height: 900 })
    await expect(editor).toBeVisible()
    await valueInput.scrollIntoViewIfNeeded()
    const editorOverflow = await editor.evaluate(element => element.scrollWidth - element.clientWidth)
    expect(editorOverflow).toBeLessThanOrEqual(2)
    await capture(page.locator('.app-shell'), `web-${locale}-tool-fields-editor-narrow`)
    await page.setViewportSize({ width: 1440, height: 1000 })

    const saveResponse = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/workflows/save'
    ))
    await page.locator(`button.sb-workflow__ghost[aria-label="${copy.save}"]`).click()
    const saved = await saveResponse
    expect(saved.ok(), await saved.text()).toBe(true)
    const savedPayload = saved.request().postDataJSON() as {
      nodes?: Array<{ id?: string; config?: Record<string, unknown> }>
    }
    expect(savedPayload.nodes?.find(node => node.id === 'normalize')?.config).toEqual({
      tool: 'text.uppercase',
      input: { value: 'hola Janusly' },
    })

    const latest = await request.get(
      `${API_URL}/workflows/latest?workflowId=${encodeURIComponent(workflowId)}`,
      { headers: headers(orgId) },
    )
    const latestText = await latest.text()
    expect(latest.ok(), latestText).toBe(true)
    const latestBody = JSON.parse(latestText) as {
      dagJson?: { nodes?: Array<{ id?: string; config?: Record<string, unknown> }> }
    }
    expect(latestBody.dagJson?.nodes?.find(node => node.id === 'normalize')?.config)
      .toEqual(savedPayload.nodes?.find(node => node.id === 'normalize')?.config)

    const startResponse = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/start'
    ))
    await page.getByRole('button', { name: copy.run, exact: true }).click()
    const started = await startResponse
    const startedText = await started.text()
    expect(started.ok(), startedText).toBe(true)
    const startedBody = JSON.parse(startedText) as { runId?: unknown }
    expect(typeof startedBody.runId).toBe('string')

    const terminal = await pollTerminalRun(request, orgId, String(startedBody.runId))
    expect(terminal.run.status).toBe('succeeded')
    expect(terminal.nodes.find(node => node.nodeId === 'normalize')).toMatchObject({
      status: 'succeeded',
      stateJson: {
        output: {
          tool: 'text.uppercase',
          result: { value: 'HOLA JANUSLY' },
        },
      },
    })
    expect(browserErrors).toEqual([])
  })
}
