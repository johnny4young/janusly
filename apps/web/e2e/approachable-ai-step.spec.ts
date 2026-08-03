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
const MODEL = 'anthropic/claude-haiku-4-5-20251001'

const LOCALES = {
  en: {
    workflows: 'Workflows',
    build: 'Build',
    save: 'Save',
    run: 'Run',
    promptSource: 'Prompt source',
    savedPrompt: 'Saved prompt',
    output: 'Output',
    structuredOutput: 'Validated structured data',
    outputSchema: 'Output contract (JSON Schema)',
    advanced: 'Advanced options',
    promptVersion: 'Prompt version',
    promptVariables: 'Prompt variables (JSON)',
    model: 'Model override',
    summaryPrefix: 'Saved prompt:',
    promptDescription: 'Classifies invoice risk with a reusable prompt.',
  },
  es: {
    workflows: 'Flujos',
    build: 'Crear',
    save: 'Guardar',
    run: 'Ejecutar',
    promptSource: 'Origen del prompt',
    savedPrompt: 'Prompt guardado',
    output: 'Salida',
    structuredOutput: 'Datos estructurados validados',
    outputSchema: 'Contrato de salida (JSON Schema)',
    advanced: 'Opciones avanzadas',
    promptVersion: 'Versión del prompt',
    promptVariables: 'Variables del prompt (JSON)',
    model: 'Modelo alternativo',
    summaryPrefix: 'Prompt guardado:',
    promptDescription: 'Clasifica el riesgo de una factura con un prompt reutilizable.',
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

async function seedPromptAndWorkflow(
  request: APIRequestContext,
  orgId: string,
  workflowId: string,
  workflowName: string,
  promptName: string,
  promptDescription: string,
): Promise<void> {
  await postJson(request, orgId, '/prompts', {
    name: promptName,
    description: promptDescription,
  })
  await postJson(request, orgId, `/prompts/${encodeURIComponent(promptName)}/versions`, {
    templateText: 'Classify the invoice for {{var.customer}} and return its risk.',
    variables: [{ name: 'customer', type: 'string', required: true }],
  })
  await postJson(request, orgId, '/workflows/save', {
    id: workflowId,
    name: workflowName,
    nodes: [{
      id: 'classify',
      type: 'ai',
      config: { prompt: 'Classify this invoice.' },
    }],
    edges: [],
    ui: {
      positions: {
        classify: { x: 260, y: 180 },
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

  test(`${locale} configures, persists, and safely runs a reusable AI step`, async ({ page, request }) => {
    test.setTimeout(90_000)
    const stamp = Date.now()
    const orgId = `approachable-ai-${locale}-${stamp}`
    const workflowId = `invoice-ai-${locale}-${stamp}`
    const workflowName = locale === 'en' ? 'Invoice risk review' : 'Revisión de riesgo de factura'
    const promptName = `invoice_classifier_${locale}_${stamp}`
    await seedPromptAndWorkflow(
      request,
      orgId,
      workflowId,
      workflowName,
      promptName,
      copy.promptDescription,
    )
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
    await canvas.locator('.react-flow__node[data-id="classify"] .workflow-node').click()
    const inspector = page.getByTestId('inspector-node-classify')
    const editor = inspector.getByTestId('ai-config')
    await expect(editor).toBeVisible()

    await editor.getByLabel(copy.promptSource, { exact: true }).selectOption('saved')
    const savedPrompt = editor.getByLabel(copy.savedPrompt, { exact: true })
    await expect(savedPrompt.locator(`option[value="${promptName}"]`)).toHaveCount(1)
    await savedPrompt.selectOption(promptName)

    await editor.getByLabel(copy.output, { exact: true }).selectOption('structured')
    const outputSchema = editor.getByLabel(copy.outputSchema, { exact: true })
    await outputSchema.fill(JSON.stringify({
      type: 'object',
      properties: { risk: { type: 'string' } },
      required: ['risk'],
    }, null, 2))
    await outputSchema.blur()

    await editor.getByText(copy.advanced, { exact: true }).click()
    const promptVersion = editor.getByLabel(copy.promptVersion, { exact: true })
    await promptVersion.fill('1')
    await promptVersion.blur()
    const promptVariables = editor.getByLabel(copy.promptVariables, { exact: true })
    await promptVariables.fill(JSON.stringify({ customer: 'Ada Corp' }, null, 2))
    await promptVariables.blur()
    await editor.getByLabel(copy.model, { exact: true }).fill(MODEL)

    await expect(editor.getByLabel(copy.promptSource, { exact: true })).toHaveValue('saved')
    await expect(savedPrompt).toHaveValue(promptName)
    await expect(editor.getByLabel(copy.output, { exact: true })).toHaveValue('structured')
    await expect(editor.getByText(copy.structuredOutput, { exact: true })).toHaveCount(1)
    await expect(inspector).toContainText(`${copy.summaryPrefix} ${promptName} · v1`)
    await expectNoBlockingAccessibilityViolations(page, `${locale} approachable AI step`)
    await capture(page.locator('.app-shell'), `web-${locale}-ai-step-editor`)

    await page.setViewportSize({ width: 1024, height: 900 })
    await expect(editor).toBeVisible()
    const editorOverflow = await editor.evaluate(element => element.scrollWidth - element.clientWidth)
    expect(editorOverflow).toBeLessThanOrEqual(2)
    await capture(page.locator('.app-shell'), `web-${locale}-ai-step-editor-narrow`)
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
    expect(savedPayload.nodes?.find(node => node.id === 'classify')?.config).toEqual({
      promptRef: { name: promptName, version: 1 },
      outputSchema: {
        type: 'object',
        properties: { risk: { type: 'string' } },
        required: ['risk'],
      },
      variables: { customer: 'Ada Corp' },
      model: MODEL,
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
    expect(latestBody.dagJson?.nodes?.find(node => node.id === 'classify')?.config)
      .toEqual(savedPayload.nodes?.find(node => node.id === 'classify')?.config)

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
    expect(terminal.nodes.find(node => node.nodeId === 'classify')).toMatchObject({
      status: 'succeeded',
      stateJson: {
        output: {
          mode: 'fallback',
          valid: false,
        },
      },
    })
    expect(browserErrors).toEqual([])
  })
}
