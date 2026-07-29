import { addCanvasStep, openWorkspaceSection } from './_helpers/workspace-navigation'
import { mkdir } from 'node:fs/promises'
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3001'
const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR

type LocaleContract = {
  locale: 'en' | 'es'
  flows: string
  addInput: string
  inputName: string
  inputType: string
  required: string
  inputDescription: string
  inputDescriptionValue: string
  inputDefault: string
  addOutput: string
  outputName: string
  outputTemplate: string
  stepName: string
  customName: string
  newNodeLabel: string
  save: string
}

const LOCALES: LocaleContract[] = [
  {
    locale: 'en',
    flows: 'Workflows',
    addInput: 'Add input',
    inputName: 'Input name: input',
    inputType: 'Type for input invoiceId',
    required: 'Required input: invoiceId',
    inputDescription: 'Description for input invoiceId',
    inputDescriptionValue: 'Stable invoice identifier',
    inputDefault: 'Default value for invoiceId',
    addOutput: 'Add output',
    outputName: 'Output name: result',
    outputTemplate: 'Template for output approvedInvoice',
    stepName: 'Step name',
    customName: 'Review invoice',
    newNodeLabel: 'AI prompt',
    save: 'Save',
  },
  {
    locale: 'es',
    flows: 'Flujos',
    addInput: 'Agregar entrada',
    inputName: 'Nombre de la entrada: input',
    inputType: 'Tipo de la entrada invoiceId',
    required: 'Entrada obligatoria: invoiceId',
    inputDescription: 'Descripción de la entrada invoiceId',
    inputDescriptionValue: 'Identificador estable de factura',
    inputDefault: 'Valor por defecto de invoiceId',
    addOutput: 'Agregar salida',
    outputName: 'Nombre de la salida: result',
    outputTemplate: 'Plantilla de la salida approvedInvoice',
    stepName: 'Nombre del paso',
    customName: 'Revisar factura',
    newNodeLabel: 'Prompt de IA',
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

async function seedWorkflow(request: APIRequestContext, orgId: string, workflowId: string, workflowName: string): Promise<void> {
  const response = await request.post(`${API_URL}/workflows/save`, {
    headers: headers(orgId),
    data: {
      id: workflowId,
      name: workflowName,
      nodes: [
        { id: 'remote-call', type: 'http', config: { url: 'https://example.com/invoices' } },
        { id: 'finish', type: 'noop', config: {} },
      ],
      edges: [{ from: 'remote-call', to: 'finish' }],
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

async function captureVisibleTop(page: Page, surface: Locator, name: string, maxHeight: number): Promise<void> {
  await surface.scrollIntoViewIfNeeded()
  await expect(surface).toBeVisible()
  if (!EVIDENCE_DIR) return
  const box = await surface.boundingBox()
  const viewport = page.viewportSize()
  if (!box || !viewport) throw new Error(`Cannot capture visible region for ${name}`)
  const x = Math.max(0, box.x)
  const y = Math.max(0, box.y)
  const width = Math.min(box.width, viewport.width - x)
  const height = Math.min(maxHeight, box.height, viewport.height - y)
  await mkdir(EVIDENCE_DIR, { recursive: true })
  await page.screenshot({ path: `${EVIDENCE_DIR}/${name}.png`, clip: { x, y, width, height } })
}

async function openWorkflow(page: Page, contract: LocaleContract, workflowId: string, workflowName: string): Promise<void> {
  await page.getByRole('button', { name: contract.flows, exact: true }).click()
  const row = page.getByTestId(`workflows-row-${workflowId}`)
  await expect(row).toContainText(workflowName)
  await row.click()
  await openWorkspaceSection(
    page,
    contract.flows,
    contract.locale === 'en' ? 'Build' : 'Crear',
  )
}

test.describe.configure({ mode: 'serial' })

for (const contract of LOCALES) {
  test(`${contract.locale} authors and reloads workflow identity, contracts, and layout`, async ({ page, request }) => {
    const stamp = Date.now()
    const orgId = `durable-authoring-${contract.locale}-${stamp}`
    const workflowId = `durable-flow-${contract.locale}-${stamp}`
    const workflowName = `Durable authoring ${contract.locale} ${stamp}`
    await seedWorkflow(request, orgId, workflowId, workflowName)
    const browserErrors = installConsoleErrorGuards(page)

    await page.addInitScript(({ activeOrg, locale }) => {
      window.localStorage.setItem('janusly:activeOrg', activeOrg)
      window.localStorage.setItem('janusly:locale', locale)
    }, { activeOrg: orgId, locale: contract.locale })

    await page.goto('/')
    await openWorkflow(page, contract, workflowId, workflowName)

    const ioCard = page.getByTestId('workflow-io-card')
    await ioCard.getByRole('button', { name: contract.addInput, exact: true }).click()
    const inputName = ioCard.getByLabel(contract.inputName)
    await inputName.fill('invoiceId')
    await inputName.press('Tab')
    await ioCard.getByLabel(contract.inputType).selectOption('number')
    await ioCard.getByRole('checkbox', { name: contract.required, exact: true }).check()
    await ioCard.getByLabel(contract.inputDescription).fill(contract.inputDescriptionValue)
    await ioCard.getByLabel(contract.inputDefault).fill('12')

    await ioCard.getByRole('button', { name: contract.addOutput, exact: true }).click()
    const outputName = ioCard.getByLabel(contract.outputName)
    await outputName.fill('approvedInvoice')
    await outputName.press('Tab')
    await ioCard.getByLabel(contract.outputTemplate).fill('{{context.finish.output}}')
    await hideUnrelatedOverlays(page)
    await capture(ioCard, `web-${contract.locale}-workflow-io-authored`)

    const remoteNode = page.locator('.react-flow__node[data-id="remote-call"]')
    await remoteNode.locator('.workflow-node').click()
    const inspector = page.getByTestId('inspector-node-remote-call')
    await inspector.getByLabel(contract.stepName).fill(contract.customName)
    await expect(remoteNode).toContainText(contract.customName)
    await hideUnrelatedOverlays(page)
    await captureVisibleTop(page, inspector, `web-${contract.locale}-workflow-step-named`, 590)

    const beforeDrag = await remoteNode.boundingBox()
    if (!beforeDrag) throw new Error('remote node has no bounding box')
    await page.mouse.move(beforeDrag.x + beforeDrag.width / 2, beforeDrag.y + beforeDrag.height / 2)
    await page.mouse.down()
    await page.mouse.move(beforeDrag.x + beforeDrag.width / 2 - 120, beforeDrag.y + beforeDrag.height / 2 + 70, { steps: 12 })
    await page.mouse.up()
    const afterDrag = await remoteNode.boundingBox()
    if (!afterDrag) throw new Error('dragged node has no bounding box')
    expect(afterDrag.x).toBeLessThan(beforeDrag.x - 80)
    expect(afterDrag.y).toBeGreaterThan(beforeDrag.y + 50)

    const canvasFrame = page.locator('.canvas-frame[data-mode="author"]')
    await openWorkspaceSection(
      page,
      contract.locale === 'en' ? 'Workflows' : 'Flujos',
      contract.locale === 'en' ? 'Build' : 'Crear',
    )
    await addCanvasStep(page, contract.newNodeLabel)
    const allNodes = canvasFrame.locator('.react-flow__node')
    await expect(allNodes).toHaveCount(3)
    const newNode = allNodes.last()
    const newNodeBox = await newNode.boundingBox()
    const canvasBox = await canvasFrame.boundingBox()
    if (!newNodeBox || !canvasBox) throw new Error('new node or canvas has no bounding box')
    expect(Math.abs(newNodeBox.x + newNodeBox.width / 2 - (canvasBox.x + canvasBox.width / 2))).toBeLessThan(55)
    expect(Math.abs(newNodeBox.y + newNodeBox.height / 2 - (canvasBox.y + canvasBox.height / 2))).toBeLessThan(55)
    await page.mouse.move(newNodeBox.x + newNodeBox.width / 2, newNodeBox.y + newNodeBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(newNodeBox.x + newNodeBox.width / 2, newNodeBox.y + newNodeBox.height / 2 + 170, { steps: 12 })
    await page.mouse.up()

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
        inputs?: { type: string; properties?: Record<string, { type: string; description?: string; default?: unknown }>; required?: string[] }
        outputs?: Record<string, string>
        nodes: Array<{ id: string; label?: string }>
        ui?: { positions?: Record<string, { x: number; y: number }> }
      }
    }
    expect(body.dagJson.inputs).toEqual({
      type: 'object',
      properties: { invoiceId: { type: 'number', description: contract.inputDescriptionValue, default: 12 } },
      required: ['invoiceId'],
    })
    expect(body.dagJson.outputs).toEqual({ approvedInvoice: '{{context.finish.output}}' })
    expect(body.dagJson.nodes.find(node => node.id === 'remote-call')?.label).toBe(contract.customName)
    expect(Object.keys(body.dagJson.ui?.positions ?? {})).toHaveLength(3)
    const savedRemotePosition = body.dagJson.ui?.positions?.['remote-call']
    expect(savedRemotePosition?.x).not.toBe(80)
    expect(savedRemotePosition?.y).not.toBe(80)

    await page.reload()
    await openWorkflow(page, contract, workflowId, workflowName)
    await expect(page.getByTestId('workflow-input-invoiceId')).toBeVisible()
    await expect(page.getByLabel(contract.inputDefault)).toHaveValue('12')
    await expect(page.getByTestId('workflow-output-approvedInvoice')).toBeVisible()
    await hideUnrelatedOverlays(page)
    await capture(page.getByTestId('workflow-io-card'), `web-${contract.locale}-workflow-io-reloaded`)

    const reloadedRemoteNode = page.locator('.react-flow__node[data-id="remote-call"]')
    await expect(reloadedRemoteNode).toContainText(contract.customName)
    const transform = await reloadedRemoteNode.evaluate(element => (element as HTMLElement).style.transform)
    const match = transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\)/)
    expect(match).not.toBeNull()
    expect(Number(match?.[1])).toBeCloseTo(savedRemotePosition?.x ?? Number.NaN, 1)
    expect(Number(match?.[2])).toBeCloseTo(savedRemotePosition?.y ?? Number.NaN, 1)
    await hideUnrelatedOverlays(page)
    await capture(canvasFrame, `web-${contract.locale}-workflow-layout-reloaded`)

    expect(browserErrors).toEqual([])
  })
}
