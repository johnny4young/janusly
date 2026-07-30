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
    mode: 'Run rule',
    simple: 'Match one rule',
    advanced: 'Use an advanced expression',
    source: 'Value from',
    condition: 'Condition',
    value: 'Compare with',
    branchExpression: 'Branch expression',
  },
  es: {
    workflows: 'Flujos',
    build: 'Crear',
    save: 'Guardar',
    run: 'Ejecutar',
    mode: 'Regla de ejecución',
    simple: 'Evaluar una regla',
    advanced: 'Usar una expresión avanzada',
    source: 'Valor de',
    condition: 'Condición',
    value: 'Comparar con',
    branchExpression: 'Expresión de rama',
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
      id: 'source',
      label: 'Order input',
      type: 'transform',
      config: { mapping: { priority: 'high' } },
    }, {
      id: 'gate',
      label: 'Check priority',
      type: 'condition',
      config: { expression: "context.source.output.priority === 'high'" },
    }, {
      id: 'complete',
      label: 'Complete branch',
      type: 'tool',
      config: {
        tool: 'text.uppercase',
        input: { value: 'branch completed' },
      },
    }],
    edges: [{
      id: 'source-gate',
      from: 'source',
      to: 'gate',
    }, {
      id: 'gate-complete',
      from: 'gate',
      to: 'complete',
      condition: 'context.gate.output.result === true',
    }],
    ui: {
      positions: {
        source: { x: 100, y: 180 },
        gate: { x: 430, y: 180 },
        complete: { x: 760, y: 180 },
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

  test(`${locale} configures, persists, and executes guided branch rules`, async ({ page, request }) => {
    test.setTimeout(90_000)
    const stamp = Date.now()
    const orgId = `approachable-branch-${locale}-${stamp}`
    const workflowId = `branch-rule-${locale}-${stamp}`
    const workflowName = locale === 'en' ? 'Route priority order' : 'Enrutar pedido prioritario'
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
    await canvas.locator('.react-flow__node[data-id="gate"] .workflow-node').click()
    const nodeInspector = page.getByTestId('inspector-node-gate')
    const nodeEditor = nodeInspector.locator('section.quick-config')
    await expect(nodeEditor.getByLabel(copy.mode)).toHaveValue('simple')
    await expect(nodeEditor.getByLabel(copy.source)).toHaveValue('context.source.output.priority')
    await expect(nodeEditor.getByLabel(copy.condition)).toHaveValue('===')
    await expect(nodeEditor.getByLabel(copy.value)).toHaveValue('high')

    await nodeEditor.getByLabel(copy.condition).selectOption('!==')
    await nodeEditor.getByLabel(copy.value).fill('low')

    await nodeEditor.getByLabel(copy.source).focus()
    await page.keyboard.press('Tab')
    await expect(nodeEditor.getByLabel(copy.condition)).toBeFocused()
    await expectNoBlockingAccessibilityViolations(page, `${locale} guided condition node`)
    await capture(page.locator('.app-shell'), `web-${locale}-branch-rule-node`)

    await nodeEditor.getByLabel(copy.mode).selectOption('advanced')
    await expect(nodeEditor.getByLabel(copy.branchExpression))
      .toHaveValue("context.source.output.priority !== 'low'")
    await capture(page.locator('.app-shell'), `web-${locale}-branch-rule-advanced`)
    await nodeEditor.getByLabel(copy.mode).selectOption('simple')

    const edge = canvas.locator(
      '.react-flow__edge[aria-label*="Check priority"][aria-label*="Complete branch"]',
    )
    await expect(edge).toBeVisible()
    await edge.click({ force: true })
    const edgeInspector = page.locator('[data-testid^="inspector-edge-"]')
    const edgeEditor = edgeInspector.locator('section.quick-config')
    await expect(edgeEditor.getByLabel(copy.mode)).toHaveValue('simple')
    await expect(edgeEditor.getByLabel(copy.source)).toHaveValue('context.gate.output.result')
    await edgeEditor.getByLabel(copy.condition).selectOption('!==')
    await edgeEditor.getByLabel(copy.value).selectOption('false')
    await expectNoBlockingAccessibilityViolations(page, `${locale} guided conditional edge`)
    await capture(page.locator('.app-shell'), `web-${locale}-branch-rule-edge`)

    await page.setViewportSize({ width: 1024, height: 900 })
    await expect(edgeEditor).toBeVisible()
    const editorOverflow = await edgeEditor.evaluate(element => element.scrollWidth - element.clientWidth)
    expect(editorOverflow).toBeLessThanOrEqual(2)
    await capture(page.locator('.app-shell'), `web-${locale}-branch-rule-narrow`)
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
      edges?: Array<{ from?: string; to?: string; condition?: string }>
    }
    expect(savedPayload.nodes?.find(node => node.id === 'gate')?.config).toEqual({
      expression: "context.source.output.priority !== 'low'",
    })
    expect(savedPayload.edges?.find(edgeRow => (
      edgeRow.from === 'gate' && edgeRow.to === 'complete'
    ))?.condition)
      .toBe('context.gate.output.result !== false')

    const latest = await request.get(
      `${API_URL}/workflows/latest?workflowId=${encodeURIComponent(workflowId)}`,
      { headers: headers(orgId) },
    )
    const latestText = await latest.text()
    expect(latest.ok(), latestText).toBe(true)
    const latestBody = JSON.parse(latestText) as {
      dagJson?: {
        nodes?: Array<{ id?: string; config?: Record<string, unknown> }>
        edges?: Array<{ from?: string; to?: string; condition?: string }>
      }
    }
    expect(latestBody.dagJson?.nodes?.find(node => node.id === 'gate')?.config)
      .toEqual(savedPayload.nodes?.find(node => node.id === 'gate')?.config)
    expect(latestBody.dagJson?.edges?.find(edgeRow => (
      edgeRow.from === 'gate' && edgeRow.to === 'complete'
    ))?.condition)
      .toBe('context.gate.output.result !== false')

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
    expect(terminal.nodes.find(node => node.nodeId === 'gate')).toMatchObject({
      status: 'succeeded',
      stateJson: { output: { result: true } },
    })
    expect(terminal.nodes.find(node => node.nodeId === 'complete')).toMatchObject({
      status: 'succeeded',
      stateJson: {
        output: {
          tool: 'text.uppercase',
          result: { value: 'BRANCH COMPLETED' },
        },
      },
    })
    expect(browserErrors).toEqual([])
  })
}
