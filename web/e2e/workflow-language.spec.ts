import { mkdir } from 'node:fs/promises'
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { openWorkspaceSection } from './_helpers/workspace-navigation'

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3001'
const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR

type Json = Record<string, unknown>
type RunSnapshot = {
  run: { status: string }
  nodes: Array<{ nodeId: string; status: string; stateJson?: { output?: unknown } | null }>
}

const contracts = {
  en: {
    flows: 'Workflows',
    mode: 'Run rule',
    expression: 'Branch expression',
  },
  es: {
    flows: 'Flujos',
    mode: 'Regla de ejecución',
    expression: 'Expresión de rama',
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

async function pollRun(request: APIRequestContext, orgId: string, runId: string): Promise<RunSnapshot> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const response = await request.get(`${API_URL}/run?runId=${encodeURIComponent(runId)}`, { headers: headers(orgId) })
    if (!response.ok()) throw new Error(`GET /run failed: ${response.status()} ${await response.text()}`)
    const snapshot = await response.json() as RunSnapshot
    if (['succeeded', 'failed', 'cancelled'].includes(snapshot.run.status)) return snapshot
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  throw new Error(`Run ${runId} did not reach a terminal status`)
}

function captureBrowserErrors(page: Page): string[] {
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

async function capture(page: Page, surface: Locator, filename: string): Promise<void> {
  await expect(surface).toBeVisible()
  await surface.scrollIntoViewIfNeeded()
  if (!EVIDENCE_DIR) return
  await page.mouse.move(0, 0)
  await page.evaluate(() => new Promise<void>(resolve => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()))
  }))
  const box = await surface.boundingBox()
  if (!box) throw new Error(`Cannot capture ${filename}: branch rule editor has no bounding box`)
  await mkdir(EVIDENCE_DIR, { recursive: true })
  await page.screenshot({
    path: `${EVIDENCE_DIR}/${filename}.png`,
    clip: box,
    animations: 'disabled',
    caret: 'hide',
  })
}

async function openBranchRuleEditor(
  page: Page,
  locale: keyof typeof contracts,
  workflowId: string,
  workflowName: string,
): Promise<{ editor: Locator; expression: Locator }> {
  const contract = contracts[locale]
  await page.getByRole('button', { name: contract.flows, exact: true }).click()
  const row = page.getByTestId(`workflows-row-${workflowId}`)
  await expect(row).toContainText(workflowName)
  await row.click()
  await openWorkspaceSection(page, contract.flows, locale === 'en' ? 'Build' : 'Crear')
  await page.locator('.react-flow__node[data-id="rules"] .workflow-node').click()

  const inspector = page.getByTestId('inspector-node-rules')
  const editor = inspector.locator('section.quick-config')
  await expect(editor.getByLabel(contract.mode)).toHaveValue('advanced')
  return { editor, expression: editor.getByLabel(contract.expression) }
}

test('the richer workflow language executes and remains authorable in English and Spanish', async ({ page, request }) => {
  test.setTimeout(120_000)
  const stamp = Date.now()
  const orgId = `workflow-language-${stamp}`
  const workflowId = `workflow-language-${stamp}`
  const workflowName = `Workflow language ${stamp}`
  const browserErrors = captureBrowserErrors(page)
  const expression = [
    "context.input.message contains 'card declined'",
    "context.input.email startsWith 'operator@'",
    "context.input.message matches 'payment *'",
    "'billing' in context.input.tags",
    "context.input.createdAt >= '2026-01-01T00:00:00Z'",
  ].join(' && ')
  const workflow: Json = {
    id: workflowId,
    name: workflowName,
    inputs: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        email: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        createdAt: { type: 'string' },
      },
    },
    nodes: [
      { id: 'rules', type: 'condition', config: { expression } },
      { id: 'matched', type: 'noop', config: {} },
      { id: 'unmatched', type: 'noop', config: {} },
    ],
    edges: [
      { from: 'rules', to: 'matched', condition: 'context.rules.output.result === true' },
      { from: 'rules', to: 'unmatched', condition: 'context.rules.output.result === false' },
    ],
  }

  await postJson(request, orgId, '/workflows/save', workflow)
  const started = await postJson(request, orgId, '/start', {
    workflow,
    input: {
      message: 'payment failed: card declined',
      email: 'operator@example.com',
      tags: ['priority', 'billing'],
      createdAt: '2026-07-14T12:30:00Z',
    },
  }) as { runId?: unknown }
  expect(typeof started.runId).toBe('string')
  const snapshot = await pollRun(request, orgId, String(started.runId))
  expect(snapshot.run.status).toBe('succeeded')
  expect(snapshot.nodes.find(node => node.nodeId === 'rules')?.stateJson?.output).toEqual({ result: true })
  expect(snapshot.nodes.find(node => node.nodeId === 'matched')?.status).toBe('succeeded')
  expect(snapshot.nodes.find(node => node.nodeId === 'unmatched')?.status).toBe('skipped')

  await page.addInitScript(({ activeOrg }) => {
    window.localStorage.setItem('janusly:activeOrg', activeOrg)
    if (!window.localStorage.getItem('janusly:locale')) window.localStorage.setItem('janusly:locale', 'en')
  }, { activeOrg: orgId })
  await page.goto('/')
  await hideUnrelatedOverlays(page)

  const english = await openBranchRuleEditor(page, 'en', workflowId, workflowName)
  await expect(english.expression).toHaveValue(expression)
  await english.expression.fill("context.input.message contains 'card declined'")
  await expect(english.editor.getByRole('alert')).toHaveCount(0)
  await capture(page, english.editor, 'web-en-advanced-branch-expression')

  await page.evaluate(() => window.localStorage.setItem('janusly:locale', 'es'))
  await page.reload()
  await hideUnrelatedOverlays(page)

  const spanish = await openBranchRuleEditor(page, 'es', workflowId, workflowName)
  await spanish.expression.fill("'billing' in context.input.tags && context.input.email matches '*@example.com'")
  await expect(spanish.editor.getByRole('alert')).toHaveCount(0)
  await capture(page, spanish.editor, 'web-es-advanced-branch-expression')

  expect(browserErrors).toEqual([])
})
