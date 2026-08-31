import { mkdir } from 'node:fs/promises'
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

import { expectNoBlockingAccessibilityViolations } from './_helpers/accessibility'
import {
  findDeadLetterForRun,
  loadTemplate,
  pollUntilTerminal,
  pollUntilWaitingOrTerminal,
  resumeWebhook,
  startRun,
} from './_helpers/demo-helpers'
import { openWorkspaceDestination, openWorkspaceSection } from './_helpers/workspace-navigation'

const enabled = process.env.JANUSLY_TEXT_SEARCH_E2E === '1'
const evidenceDir = process.env.JANUSLY_EVIDENCE_DIR
const apiURL = process.env.E2E_API_URL ?? 'http://localhost:3001'

type Locale = 'en' | 'es'
type Workflow = Record<string, unknown> & {
  id?: string
  name?: string
  nodes?: Array<Record<string, unknown>>
  edges?: Array<Record<string, unknown>>
}

function headers(orgID: string) {
  return { 'content-type': 'application/json', 'x-org-id': orgID, 'x-user-id': 'search-operator' }
}

async function post(request: APIRequestContext, orgID: string, path: string, data: unknown) {
  const response = await request.post(`${apiURL}${path}`, { headers: headers(orgID), data })
  expect(response.ok(), `${path}: ${response.status()} ${await response.text()}`).toBe(true)
}

function renameFailureNode(workflow: Workflow, nodeID: string): void {
  for (const node of workflow.nodes ?? []) {
    if (node.id === 'charge') node.id = nodeID
  }
  for (const edge of workflow.edges ?? []) {
    if (edge.from === 'charge') edge.from = nodeID
    if (edge.to === 'charge') edge.to = nodeID
    if (edge.source === 'charge') edge.source = nodeID
    if (edge.target === 'charge') edge.target = nodeID
  }
}

async function seed(request: APIRequestContext, locale: Locale, orgID: string) {
  const stamp = `${locale}-${Date.now()}`
  const workflowID = `text-search-target-${stamp}`
  const workflowName = `Factura café abc%_\\ ${stamp}`
  const nodeID = `search-café-node-${stamp}`
  const workflow = structuredClone(await loadTemplate(request, 'failed-workflow-recovery', orgID)) as Workflow
  workflow.id = workflowID
  workflow.name = workflowName
  renameFailureNode(workflow, nodeID)
  await post(request, orgID, '/workflows/save', workflow)
  await post(request, orgID, '/workflows/save', {
    dslVersion: '1.0',
    id: `text-search-distractor-${stamp}`,
    name: `Routine cleanup ${stamp}`,
    nodes: [{ id: 'noop', type: 'noop', config: {} }],
    edges: [],
  })
  await post(request, orgID, '/onboarding', { action: 'skip' })

  const { runId } = await startRun(request, workflow, { customer: 'search@example.test', amountUsd: 42 }, orgID)
  await pollUntilWaitingOrTerminal(request, runId, 'trigger', 30_000, orgID)
  await resumeWebhook(request, runId, 'trigger', { customer: 'search@example.test', amountUsd: 42 }, orgID)
  const terminal = await pollUntilTerminal(request, runId, 30_000, orgID)
  expect(terminal.status).toBe('failed')
  const deadLetter = await findDeadLetterForRun(request, runId, orgID)
  expect(deadLetter).not.toBeNull()
  return {
    workflowID,
    workflowName,
    distractorID: `text-search-distractor-${stamp}`,
    deadLetterID: deadLetter!.id,
  }
}

function guardBrowser(page: Page) {
  const errors: string[] = []
  const searchRequests: string[] = []
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`))
  page.on('response', response => {
    if (response.status() >= 400) errors.push(`${response.status()} ${new URL(response.url()).pathname}`)
  })
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname === '/workflows' || url.pathname === '/dlq/queue') {
      searchRequests.push(url.toString())
    }
  })
  return { errors, searchRequests }
}

async function capture(page: Page, name: string) {
  if (!evidenceDir) return
  await mkdir(evidenceDir, { recursive: true })
  await page.screenshot({
    path: `${evidenceDir}/${name}.png`,
    fullPage: true,
    animations: 'disabled',
    caret: 'hide',
  })
}

test.describe.configure({ mode: 'serial' })

for (const locale of ['en', 'es'] as const) {
  test(`bounded Unicode search works against Go and PostgreSQL 18 in ${locale}`, async ({ page, request }) => {
    test.skip(!enabled, 'requires the isolated full-stack search gate')
    test.setTimeout(120_000)
    const orgID = `qualification-text-search-ui-${locale}-${Date.now()}`
    const fixture = await seed(request, locale, orgID)
    const browser = guardBrowser(page)
    await page.setViewportSize({ width: 1440, height: 1000 })

    await page.addInitScript(({ activeOrg, language }) => {
      window.localStorage.setItem('janusly:activeOrg', activeOrg)
      window.localStorage.setItem('janusly:locale', language)
      window.localStorage.setItem('janusly:recovery:hideIntro', 'true')
    }, { activeOrg: orgID, language: locale })
    await page.goto('/')
    await openWorkspaceDestination(page, locale === 'en' ? 'Workflows' : 'Flujos')

    const workflowSearch = page.getByTestId('workflows-search')
    await expect(page.getByTestId(`workflows-row-${fixture.workflowID}`)).toBeVisible()
    await expect(page.getByTestId(`workflows-row-${fixture.distractorID}`)).toBeVisible()
    await workflowSearch.fill('ab')
    await expect(page.getByTestId('workflows-search-hint')).toContainText(
      locale === 'en' ? 'at least 3 letters or numbers' : 'al menos 3 letras o números',
    )
    await expect(workflowSearch).not.toHaveAttribute('aria-invalid')
    await page.waitForTimeout(400)
    expect(browser.searchRequests.some(raw => new URL(raw).searchParams.get('q') === 'ab')).toBe(false)

    await workflowSearch.fill('café')
    await expect(page.getByTestId(`workflows-row-${fixture.workflowID}`)).toContainText(fixture.workflowName)
    await expect(page.getByTestId(`workflows-row-${fixture.distractorID}`)).toHaveCount(0)
    await expectNoBlockingAccessibilityViolations(page, `${locale} workflow Unicode search`)
    await capture(page, `text-search-workflows-${locale}`)

    await workflowSearch.fill('abc%_\\')
    await expect(page.getByTestId(`workflows-row-${fixture.workflowID}`)).toBeVisible()
    await workflowSearch.fill('界'.repeat(101))
    await expect(workflowSearch).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByTestId('workflows-search-hint')).toContainText('100')
    await page.waitForTimeout(400)
    expect(browser.searchRequests.some(raw => Array.from(new URL(raw).searchParams.get('q') ?? '').length > 100)).toBe(false)
    await workflowSearch.fill('')
    await expect(page.getByTestId(`workflows-row-${fixture.distractorID}`)).toBeVisible()

    await openWorkspaceSection(
      page,
      locale === 'en' ? 'Activity' : 'Actividad',
      locale === 'en' ? 'Recover' : 'Recuperar',
    )
    const queue = page.getByTestId('recovery-queue')
    await expect(queue.getByTestId(`dlq-row-${fixture.deadLetterID}`)).toBeVisible()
    const recoverySearch = queue.getByTestId('dlq-search')
    await recoverySearch.fill('ab')
    await expect(queue.getByTestId('dlq-search-hint')).toContainText(
      locale === 'en' ? 'at least 3 letters or numbers' : 'al menos 3 letras o números',
    )
    await expect(recoverySearch).not.toHaveAttribute('aria-invalid')
    await page.waitForTimeout(400)
    expect(browser.searchRequests.some(raw => new URL(raw).searchParams.get('search') === 'ab')).toBe(false)

    await recoverySearch.fill('café')
    await expect(queue.getByTestId(`dlq-row-${fixture.deadLetterID}`)).toBeVisible()
    await expectNoBlockingAccessibilityViolations(page, `${locale} recovery Unicode search`)
    await capture(page, `text-search-recovery-${locale}`)

    expect(browser.errors).toEqual([])
  })
}
