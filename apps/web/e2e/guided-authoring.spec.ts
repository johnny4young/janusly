import { mkdir } from 'node:fs/promises'
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3001'
const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR

type LocaleContract = {
  locale: 'en' | 'es'
  flows: string
  inspector: string
  home: string
  studio: string
  help: string
  aiPrompt: string
  minimap: string
  duplicate: string
  workflowId: string
  cronExpression: string
  cronInvalid: string
  cronReady: string
  shortcuts: string
  shortcutHome: string
  shortcutStudio: string
  save: string
}

const LOCALES: LocaleContract[] = [
  {
    locale: 'en',
    flows: 'Workflows',
    inspector: 'Step setup',
    home: 'Home',
    studio: 'AI Studio',
    help: 'Help',
    aiPrompt: 'AI prompt',
    minimap: 'Workflow overview map',
    duplicate: 'Duplicate step',
    workflowId: 'Workflow id',
    cronExpression: 'Cron expression',
    cronInvalid: 'Use a valid 5-field cron expression.',
    cronReady: 'Next 3 runs',
    shortcuts: 'Keyboard shortcuts',
    shortcutHome: 'Open Recovery Center',
    shortcutStudio: 'Open AI Studio',
    save: 'Save',
  },
  {
    locale: 'es',
    flows: 'Flujos',
    inspector: 'Configuración de paso',
    home: 'Inicio',
    studio: 'AI Studio',
    help: 'Ayuda',
    aiPrompt: 'Prompt de IA',
    minimap: 'Mapa general del workflow',
    duplicate: 'Duplicar paso',
    workflowId: 'ID del flujo',
    cronExpression: 'Expresión cron',
    cronInvalid: 'Usa una expresión cron válida de 5 campos.',
    cronReady: 'Próximas 3 ejecuciones',
    shortcuts: 'Atajos de teclado',
    shortcutHome: 'Abrir el Centro de Recuperación',
    shortcutStudio: 'Abrir AI Studio',
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

async function saveWorkflow(request: APIRequestContext, orgId: string, workflow: Record<string, unknown>): Promise<void> {
  const response = await request.post(`${API_URL}/workflows/save`, {
    headers: headers(orgId),
    data: workflow,
  })
  if (!response.ok()) throw new Error(`seed workflow failed: ${response.status()} ${await response.text()}`)
}

async function seedGuidedAuthoring(
  request: APIRequestContext,
  orgId: string,
  workflowId: string,
  workflowName: string,
  childOneId: string,
  childTwoId: string,
): Promise<void> {
  await saveWorkflow(request, orgId, {
    id: childOneId,
    name: 'Child invoices',
    nodes: [{ id: 'finish', type: 'noop', config: {} }],
    edges: [],
  })
  await saveWorkflow(request, orgId, {
    id: childTwoId,
    name: 'Child notifications',
    nodes: [{ id: 'finish', type: 'noop', config: {} }],
    edges: [],
  })
  await saveWorkflow(request, orgId, {
    id: workflowId,
    name: workflowName,
    nodes: [
      { id: 'schedule', type: 'schedule', config: { cronExpression: '0 8 * * *', enabled: true } },
      { id: 'source', type: 'http', config: { url: 'https://example.com/orders' } },
      { id: 'branch', type: 'condition', config: { expression: 'context.source.output.statusCode === 200' } },
      { id: 'approve', type: 'approval', config: { message: 'Approve order' } },
      { id: 'call-child', type: 'subworkflow', config: { workflowId: childOneId, input: {} } },
      { id: 'finish', type: 'noop', config: {} },
    ],
    edges: [
      { from: 'schedule', to: 'source' },
      { from: 'source', to: 'branch' },
      { from: 'branch', to: 'approve', condition: 'context.branch.output.result === true' },
      { from: 'approve', to: 'call-child' },
      { from: 'call-child', to: 'finish' },
    ],
    ui: {
      positions: {
        schedule: { x: 0, y: 20 },
        source: { x: 280, y: 20 },
        branch: { x: 560, y: 20 },
        approve: { x: 0, y: 260 },
        'call-child': { x: 280, y: 260 },
        finish: { x: 560, y: 260 },
      },
    },
  })
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

async function openWorkflow(page: Page, contract: LocaleContract, workflowId: string, workflowName: string): Promise<void> {
  await page.getByRole('button', { name: contract.flows, exact: true }).click()
  const row = page.getByTestId(`workflows-row-${workflowId}`)
  await expect(row).toContainText(workflowName)
  await row.click()
  await page.getByRole('button', { name: contract.inspector, exact: true }).click()
}

function navigationButton(page: Page, label: string): Locator {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return page.getByRole('button', { name: new RegExp(`^${escaped}(?:\\s|$)`) })
}

test.describe.configure({ mode: 'serial' })

for (const contract of LOCALES) {
  test(`${contract.locale} guides drag, duplicate, workflow selection, schedules, and shortcuts`, async ({ page, request }) => {
    const stamp = Date.now()
    const orgId = `guided-authoring-${contract.locale}-${stamp}`
    const suffix = `${contract.locale}-${stamp.toString(36)}`
    const workflowId = `guided-parent-${suffix}`
    const workflowName = `Guided authoring ${contract.locale} ${stamp}`
    const childOneId = `guided-child-one-${suffix}`
    const childTwoId = `guided-child-two-${suffix}`
    await seedGuidedAuthoring(request, orgId, workflowId, workflowName, childOneId, childTwoId)
    const browserErrors = installConsoleErrorGuards(page)

    await page.addInitScript(({ activeOrg, locale }) => {
      window.localStorage.setItem('janusly:activeOrg', activeOrg)
      window.localStorage.setItem('janusly:locale', locale)
    }, { activeOrg: orgId, locale: contract.locale })

    await page.goto('/')
    await openWorkflow(page, contract, workflowId, workflowName)

    const canvas = page.locator('.canvas-frame[data-mode="author"]')
    await expect(canvas.locator('.canvas-palette')).toBeVisible()
    await expect(canvas.getByRole('img', { name: contract.minimap })).toBeVisible()
    await navigationButton(page, contract.studio).click()
    await expect(canvas.locator('.canvas-palette')).toBeVisible()
    await page.getByRole('button', { name: contract.inspector, exact: true }).click()

    const paletteSource = page.locator('.builder-sidebar .sb-palette').getByRole('button', { name: contract.aiPrompt, exact: true }).first()
    // Drop into the exposed canvas area; the contextual inspector occupies the
    // right side of the workspace and correctly intercepts pointer events.
    await paletteSource.dragTo(canvas, { targetPosition: { x: 320, y: 500 } })
    await expect(canvas.locator('.react-flow__node')).toHaveCount(7)

    await canvas.locator('.react-flow__node[data-id="source"] .workflow-node').click()
    const sourceInspector = page.getByTestId('inspector-node-source')
    await expect(sourceInspector.getByRole('button', { name: contract.duplicate, exact: true })).toBeVisible()
    await sourceInspector.getByRole('button', { name: contract.duplicate, exact: true }).click()
    await expect(canvas.locator('.react-flow__node')).toHaveCount(8)

    await canvas.locator('.react-flow__node[data-id="call-child"] .workflow-node').click()
    const subworkflowConfig = page.getByTestId('inspector-node-call-child').locator('.quick-config')
    const workflowPicker = subworkflowConfig.getByLabel(contract.workflowId)
    await expect(subworkflowConfig.locator(`datalist option[value="${workflowId}"]`)).toHaveCount(0)
    await workflowPicker.fill(childTwoId)
    await expect(workflowPicker).toHaveValue(childTwoId)
    await workflowPicker.blur()
    await hideUnrelatedOverlays(page)
    await capture(subworkflowConfig, `web-${contract.locale}-subworkflow-picker-selected`)

    await canvas.locator('.react-flow__node[data-id="schedule"] .workflow-node').click()
    const scheduleConfig = page.getByTestId('inspector-node-schedule').locator('.quick-config')
    const cronInput = scheduleConfig.getByLabel(contract.cronExpression)
    await cronInput.fill('not a cron')
    await expect(scheduleConfig.getByText(contract.cronInvalid, { exact: true })).toBeVisible()
    await expect(cronInput).toHaveAttribute('aria-invalid', 'true')
    await hideUnrelatedOverlays(page)
    await capture(scheduleConfig, `web-${contract.locale}-schedule-preview-invalid`)

    const cronResponse = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return response.request().method() === 'GET'
        && url.pathname.endsWith('/workflows/schedule-preview')
        && url.searchParams.get('cron') === '0 9 * * *'
    })
    await cronInput.fill('0 9 * * *')
    await cronResponse
    await expect(scheduleConfig.getByText(contract.cronReady, { exact: true })).toBeVisible()
    await expect(scheduleConfig.locator('.we-cron-preview li')).toHaveCount(3)
    await expect(cronInput).not.toHaveAttribute('aria-invalid')
    await hideUnrelatedOverlays(page)
    await capture(scheduleConfig, `web-${contract.locale}-schedule-preview-ready`)

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
    const body = await latest.json() as {
      dagJson: {
        nodes: Array<{ id: string; type: string; config: Record<string, unknown> }>
        ui?: { positions?: Record<string, { x: number; y: number }> }
      }
    }
    expect(body.dagJson.nodes).toHaveLength(8)
    expect(body.dagJson.nodes.find(node => node.id === 'call-child')?.config.workflowId).toBe(childTwoId)
    expect(body.dagJson.nodes.find(node => node.id === 'schedule')?.config.cronExpression).toBe('0 9 * * *')
    expect(Object.keys(body.dagJson.ui?.positions ?? {})).toHaveLength(8)

    await page.reload()
    await openWorkflow(page, contract, workflowId, workflowName)
    await expect(canvas.locator('.react-flow__node')).toHaveCount(8)
    await expect(canvas.getByRole('img', { name: contract.minimap })).toBeVisible()
    await hideUnrelatedOverlays(page)
    await capture(canvas, `web-${contract.locale}-canvas-guided-reloaded`)

    await page.getByRole('button', { name: contract.help, exact: true }).click()
    const shortcuts = page.getByRole('dialog', { name: contract.shortcuts })
    await expect(shortcuts.getByText(contract.shortcutHome, { exact: true })).toBeVisible()
    await expect(shortcuts.getByText(contract.shortcutStudio, { exact: true })).toBeVisible()
    await capture(shortcuts.locator('.we-shortcuts-dialog'), `web-${contract.locale}-shortcuts-help-open`)
    await page.keyboard.press('Escape')

    await page.keyboard.press('Meta+1')
    await expect(navigationButton(page, contract.home)).toHaveAttribute('aria-current', 'page')
    await expect(page.getByTestId('workspace-canvas-wrapper')).toHaveCount(0)
    await page.keyboard.press('Meta+2')
    await expect(navigationButton(page, contract.studio)).toHaveAttribute('aria-current', 'page')
    await expect(page.getByTestId('workspace-canvas-wrapper')).toHaveAttribute('data-canvas-visible', 'true')
    await expect(canvas.locator('.canvas-palette')).toBeVisible()

    expect(browserErrors).toEqual([])
  })
}
