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
    activity: 'Activity',
    recover: 'Recover',
    save: 'Save',
    run: 'Run',
    fields: 'Form fields',
    advanced: 'Advanced JSON',
    add: 'Add input',
    inputName: (name: string) => `Input name: ${name}`,
    inputType: (name: string) => `Type for input ${name}`,
    inputDescription: (name: string) => `Description for input ${name}`,
    required: (name: string) => `Required input: ${name}`,
    fillForm: /Fill form collect/u,
    submit: 'Submit form',
    submitted: /Form collect submitted/u,
  },
  es: {
    workflows: 'Flujos',
    build: 'Crear',
    activity: 'Actividad',
    recover: 'Recuperar',
    save: 'Guardar',
    run: 'Ejecutar',
    fields: 'Campos del formulario',
    advanced: 'JSON avanzado',
    add: 'Agregar entrada',
    inputName: (name: string) => `Nombre de la entrada: ${name}`,
    inputType: (name: string) => `Tipo de la entrada ${name}`,
    inputDescription: (name: string) => `Descripción de la entrada ${name}`,
    required: (name: string) => `Entrada obligatoria: ${name}`,
    fillForm: /Rellenar formulario collect/u,
    submit: 'Enviar formulario',
    submitted: /Formulario collect enviado/u,
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
      id: 'collect',
      label: 'Collect qualification',
      type: 'human_form',
      config: {
        title: 'Qualification request',
        description: 'Capture the information needed to continue.',
        schema: {
          type: 'object',
          properties: {
            requester: { type: 'string', description: 'Person requesting review' },
            reason: { type: 'string', description: 'Reason for the request' },
          },
          required: ['requester', 'reason'],
        },
      },
    }, {
      id: 'normalize',
      label: 'Normalize requester',
      type: 'tool',
      config: {
        tool: 'text.uppercase',
        input: { value: '{{context.collect.output.employee}}' },
      },
    }],
    edges: [{ id: 'collect-normalize', from: 'collect', to: 'normalize' }],
    ui: {
      positions: {
        collect: { x: 180, y: 220 },
        normalize: { x: 600, y: 220 },
      },
    },
  })
}

async function getRun(
  request: APIRequestContext,
  orgId: string,
  runId: string,
): Promise<RunSnapshot> {
  const response = await request.get(`${API_URL}/run?runId=${encodeURIComponent(runId)}`, {
    headers: headers(orgId),
  })
  const text = await response.text()
  expect(response.ok(), `/run: ${response.status()} ${text}`).toBe(true)
  return JSON.parse(text) as RunSnapshot
}

async function pollRun(
  request: APIRequestContext,
  orgId: string,
  runId: string,
  done: (snapshot: RunSnapshot) => boolean,
): Promise<RunSnapshot> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const snapshot = await getRun(request, orgId, runId)
    if (done(snapshot)) return snapshot
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Run ${runId} did not reach the expected state`)
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

  test(`${locale} authors, persists, and completes a guided human form`, async ({ page, request }) => {
    test.setTimeout(90_000)
    const stamp = Date.now()
    const orgId = `approachable-form-${locale}-${stamp}`
    const workflowId = `qualification-form-${locale}-${stamp}`
    const workflowName = locale === 'en' ? 'Qualification intake' : 'Recepción de calificación'
    await seedWorkflow(request, orgId, workflowId, workflowName)
    const browserErrors = installBrowserErrorGuards(page)

    await page.addInitScript(({ activeOrg, selectedLocale }) => {
      window.localStorage.setItem('janusly:activeOrg', activeOrg)
      window.localStorage.setItem('janusly:locale', selectedLocale)
    }, { activeOrg: orgId, selectedLocale: locale })

    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.goto('/')
    await page.getByRole('button', { name: copy.workflows, exact: true }).click()
    await page.getByTestId(`workflows-row-${workflowId}`).click()
    await openWorkspaceSection(page, copy.workflows, copy.build)

    const canvas = page.locator('.canvas-frame[data-mode="author"]')
    await canvas.locator('.react-flow__node[data-id="collect"] .workflow-node').click()
    const inspector = page.getByTestId('inspector-node-collect')
    const editor = inspector.locator('section.quick-config')
    await expect(editor.getByText(copy.fields, { exact: true })).toBeVisible()

    const requesterName = editor.getByLabel(copy.inputName('requester'))
    await requesterName.focus()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.type('employee')
    await page.keyboard.press('Enter')
    await expect(editor.getByLabel(copy.inputName('employee'))).toBeVisible()
    await editor.getByLabel(copy.inputDescription('employee')).fill(
      locale === 'en' ? 'Employee requesting review' : 'Empleado que solicita la revisión',
    )

    const reasonName = editor.getByLabel(copy.inputName('reason'))
    await reasonName.fill('days')
    await page.keyboard.press('Enter')
    await editor.getByLabel(copy.inputType('days')).selectOption('number')
    await editor.getByLabel(copy.inputDescription('days')).fill(
      locale === 'en' ? 'Requested number of days' : 'Cantidad de días solicitados',
    )

    await editor.getByRole('button', { name: copy.add, exact: true }).click()
    const addedName = editor.getByLabel(copy.inputName('input'))
    await addedName.fill('urgent')
    await page.keyboard.press('Enter')
    await editor.getByLabel(copy.inputType('urgent')).selectOption('boolean')
    await editor.getByRole('checkbox', { name: copy.required('urgent') }).check()

    await editor.getByLabel(copy.inputName('employee')).focus()
    await page.keyboard.press('Tab')
    await expect(editor.getByLabel(copy.inputType('employee'))).toBeFocused()
    await expectNoBlockingAccessibilityViolations(page, `${locale} guided human form editor`)
    await capture(page.locator('.app-shell'), `web-${locale}-human-form-fields`)

    const advanced = inspector.locator('details.ui-inspector-json')
    await advanced.getByText(copy.advanced, { exact: true }).click()
    const exactConfig = JSON.parse(await advanced.locator('textarea').inputValue()) as {
      schema?: unknown
    }
    expect(exactConfig.schema).toEqual({
      type: 'object',
      properties: {
        employee: {
          type: 'string',
          description: locale === 'en'
            ? 'Employee requesting review'
            : 'Empleado que solicita la revisión',
        },
        days: {
          type: 'number',
          description: locale === 'en'
            ? 'Requested number of days'
            : 'Cantidad de días solicitados',
        },
        urgent: { type: 'boolean' },
      },
      required: ['employee', 'days', 'urgent'],
    })
    await advanced.locator('textarea').scrollIntoViewIfNeeded()
    await capture(page.locator('.app-shell'), `web-${locale}-human-form-advanced-json`)
    await advanced.getByText(copy.advanced, { exact: true }).click()

    await page.setViewportSize({ width: 1024, height: 900 })
    await expect(editor).toBeVisible()
    expect(await editor.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(2)
    expect(await page.locator('.app-shell').evaluate(element => (
      element.scrollWidth - element.clientWidth
    ))).toBeLessThanOrEqual(2)
    await capture(page.locator('.app-shell'), `web-${locale}-human-form-fields-narrow`)
    await page.setViewportSize({ width: 1440, height: 1000 })

    const saveResponse = page.waitForResponse((response) => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/workflows/save'
    ))
    await page.locator(`button.sb-workflow__ghost[aria-label="${copy.save}"]`).click()
    const saved = await saveResponse
    expect(saved.ok(), await saved.text()).toBe(true)

    const latest = await request.get(
      `${API_URL}/workflows/latest?workflowId=${encodeURIComponent(workflowId)}`,
      { headers: headers(orgId) },
    )
    const latestText = await latest.text()
    expect(latest.ok(), latestText).toBe(true)
    const latestBody = JSON.parse(latestText) as {
      dagJson?: { nodes?: Array<{ id?: string; config?: Record<string, unknown> }> }
    }
    expect(latestBody.dagJson?.nodes?.find(node => node.id === 'collect')?.config?.schema)
      .toEqual(exactConfig.schema)

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
    const runId = String(startedBody.runId)
    await pollRun(request, orgId, runId, snapshot => (
      snapshot.nodes.some(node => node.nodeId === 'collect' && node.status === 'waiting')
    ))

    await openWorkspaceSection(page, copy.activity, copy.recover)
    await page.getByRole('button', { name: copy.fillForm }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('heading', { name: 'Qualification request' })).toBeVisible()
    await dialog.getByLabel('employee').fill('Ada Lovelace')
    await dialog.getByLabel('days').fill('3')
    await dialog.getByLabel('urgent').selectOption('true')
    await expectNoBlockingAccessibilityViolations(page, `${locale} authored human form dialog`)
    await capture(dialog, `web-${locale}-human-form-runtime`)
    await dialog.getByRole('button', { name: copy.submit, exact: true }).click()
    await expect(page.getByText(copy.submitted)).toBeVisible()

    const terminal = await pollRun(request, orgId, runId, snapshot => (
      ['succeeded', 'failed', 'cancelled'].includes(snapshot.run.status)
    ))
    expect(terminal.run.status).toBe('succeeded')
    expect(terminal.nodes.find(node => node.nodeId === 'collect')).toMatchObject({
      status: 'succeeded',
      stateJson: {
        output: {
          employee: 'Ada Lovelace',
          days: 3,
          urgent: true,
        },
      },
    })
    expect(terminal.nodes.find(node => node.nodeId === 'normalize')).toMatchObject({
      status: 'succeeded',
      stateJson: {
        output: {
          tool: 'text.uppercase',
          result: { value: 'ADA LOVELACE' },
        },
      },
    })
    expect(browserErrors).toEqual([])
  })
}
