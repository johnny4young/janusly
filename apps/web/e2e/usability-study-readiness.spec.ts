import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type Locator,
  type Page,
} from '@playwright/test'

import { expectNoBlockingAccessibilityViolations } from './_helpers/accessibility'
import { openWorkspaceDestination, openWorkspaceSection } from './_helpers/workspace-navigation'

const API_URL = process.env.E2E_API_URL ?? 'http://127.0.0.1:3001'
const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR

type Locale = 'en' | 'es'
type RunSnapshot = { run: { status: string } }

const copy = {
  en: {
    home: 'Home',
    workflows: 'Workflows',
    activity: 'Activity',
    settings: 'Settings',
    workspace: 'Workspace',
    team: 'Team',
    newWorkflow: 'New workflow',
    needsAction: 'Needs action',
    recoverStep: 'Recover this step',
    recover: 'Suggest fix',
    connectionIndex: 'Connections',
    addConnection: 'Add connection',
    addConnectionDialog: 'Register a protected secret',
    invite: 'Invite member',
  },
  es: {
    home: 'Inicio',
    workflows: 'Flujos',
    activity: 'Actividad',
    settings: 'Configuración',
    workspace: 'Espacio de trabajo',
    team: 'Equipo',
    newWorkflow: 'Nuevo flujo',
    needsAction: 'Requiere acción',
    recoverStep: 'Recuperar este paso',
    recover: 'Sugerir corrección',
    connectionIndex: 'Conexiones',
    addConnection: 'Añadir conexión',
    addConnectionDialog: 'Registrar un secreto protegido',
    invite: 'Invitar miembro',
  },
} as const

function headers(orgId: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-org-id': orgId,
    'x-user-id': 'usability-owner',
  }
}

async function seedFailure(
  request: APIRequestContext,
  orgId: string,
): Promise<{ runId: string; deadLetterId: string }> {
  const response = await request.post(`${API_URL}/start`, {
    headers: headers(orgId),
    data: {
      id: `usability-customer-sync-${Date.now()}`,
      name: 'Customer sync',
      nodes: [{
        id: 'load_customer_secret',
        type: 'transform',
        config: { mapping: { token: '{{secret.USABILITY_STUDY_MISSING}}' } },
      }],
      edges: [],
    },
  })
  if (!response.ok()) {
    throw new Error(`POST /start failed: ${response.status()} ${await response.text()}`)
  }
  const { runId } = await response.json() as { runId: string }
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const runResponse = await request.get(`${API_URL}/run?runId=${encodeURIComponent(runId)}`, {
      headers: headers(orgId),
    })
    if (!runResponse.ok()) throw new Error(`GET /run failed: ${runResponse.status()}`)
    const snapshot = await runResponse.json() as RunSnapshot
    if (snapshot.run.status === 'failed') break
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  const dlqDeadline = Date.now() + 30_000
  while (Date.now() < dlqDeadline) {
    const dlqResponse = await request.get(`${API_URL}/dlq?limit=100`, {
      headers: headers(orgId),
    })
    if (!dlqResponse.ok()) throw new Error(`GET /dlq failed: ${dlqResponse.status()}`)
    const rows = await dlqResponse.json() as Array<{ id: string; runId: string }>
    const row = rows.find(candidate => candidate.runId === runId)
    if (row) return { runId, deadLetterId: row.id }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`No recovery row was created for run ${runId}`)
}

async function capture(surface: Locator, name: string): Promise<void> {
  await expect(surface).toBeVisible()
  if (!EVIDENCE_DIR) return
  await mkdir(EVIDENCE_DIR, { recursive: true })
  await surface.screenshot({
    path: path.join(EVIDENCE_DIR, name),
    animations: 'disabled',
    caret: 'hide',
  })
}

function installBrowserGuards(page: Page): string[] {
  const errors: string[] = []
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  page.on('pageerror', error => errors.push(`page: ${error.message}`))
  page.on('response', response => {
    const resourceType = response.request().resourceType()
    if (response.status() >= 400 && (resourceType === 'fetch' || resourceType === 'xhr')) {
      errors.push(`http ${response.status()}: ${response.request().method()} ${response.url()}`)
    }
  })
  return errors
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  )).toBeLessThanOrEqual(2)
}

async function preparePage(
  browser: Browser,
  locale: Locale,
  orgId: string,
): Promise<{
  context: Awaited<ReturnType<Browser['newContext']>>
  page: Page
  browserErrors: string[]
}> {
  const context = await browser.newContext({
    viewport: locale === 'en' ? { width: 1280, height: 720 } : { width: 1024, height: 720 },
    reducedMotion: 'reduce',
  })
  const page = await context.newPage()
  const browserErrors = installBrowserGuards(page)
  await page.addInitScript(({ activeOrg, selectedLocale }) => {
    window.localStorage.clear()
    window.localStorage.setItem('janusly:activeOrg', activeOrg)
    window.localStorage.setItem('janusly:locale', selectedLocale)
    window.localStorage.setItem('janusly:activeTab', 'home')
  }, { activeOrg: orgId, selectedLocale: locale })
  await page.goto('/')
  await expect(page.locator('.app-shell')).toBeVisible()
  await page.evaluate(() => {
    for (const selector of ['.toast-stack', '.we-onboarding-banner', '.we-budget-banner']) {
      for (const element of document.querySelectorAll<HTMLElement>(selector)) {
        element.style.display = 'none'
      }
    }
  })
  return { context, page, browserErrors }
}

test.describe.configure({ mode: 'serial' })

test('the local product is ready for the five moderated usability tasks', async ({
  browser,
  request,
}) => {
  test.setTimeout(180_000)
  const readiness: {
    kind: string
    boundary: string
    generatedAt: string
    locales: Partial<Record<Locale, unknown>>
  } = {
    kind: 'janusly_automated_usability_readiness',
    boundary: 'Automated affordance smoke only; not a moderated participant result.',
    generatedAt: new Date().toISOString(),
    locales: {},
  }

  for (const locale of ['en', 'es'] as const) {
    const orgId = `usability-readiness-${locale}-${Date.now()}`
    const { context, page, browserErrors } = await preparePage(browser, locale, orgId)
    const shell = page.locator('.app-shell')

    await expect(
      page.locator('#workspace-sidebar').getByRole('button', {
        name: copy[locale].workflows,
        exact: true,
      }),
    ).toBeVisible()
    await capture(shell, `web-${locale}-usability-home.png`)

    await openWorkspaceDestination(page, copy[locale].workflows)
    const createAction = page.getByRole('button', {
      name: copy[locale].newWorkflow,
      exact: true,
    }).first()
    await expect(createAction).toBeVisible()
    await createAction.click()
    await expect(page.getByTestId('workflow-creation-choices')).toBeVisible()
    await expectNoBlockingAccessibilityViolations(page, `${locale} create-workflow readiness`)
    await expectNoPageOverflow(page)
    await capture(shell, `web-${locale}-usability-create-workflow.png`)

    const failure = await seedFailure(request, orgId)
    // The failure is created outside the browser through the normal API. A
    // reload gives the app the same fresh-entry boundary a participant gets
    // when beginning the next moderated task.
    await page.reload()
    await openWorkspaceDestination(page, copy[locale].activity)
    await page.getByTestId('activity-filter-needs_action').click()
    const recoveryRow = page.getByTestId(`activity-row-recovery:${failure.deadLetterId}`)
    await expect(recoveryRow).toBeVisible()
    await expect(recoveryRow).toContainText('Customer sync')
    await expect(page.getByTestId('activity-filter-needs_action')).toContainText(
      copy[locale].needsAction,
    )
    await expect(recoveryRow).toContainText(copy[locale].recoverStep)
    await expectNoBlockingAccessibilityViolations(page, `${locale} failed-run discovery readiness`)
    await expectNoPageOverflow(page)
    await capture(shell, `web-${locale}-usability-find-failure.png`)

    await recoveryRow.locator('button.list-card-row').click()
    const recoveryDetail = page.getByTestId('activity-recovery-detail')
    await expect(recoveryDetail).toBeVisible()
    const suggestFix = recoveryDetail.getByRole('button', {
      name: copy[locale].recover,
      exact: true,
    })
    await expect(suggestFix).toBeEnabled()
    await suggestFix.click()
    const recoveryDialog = page.getByRole('dialog')
      .filter({ has: page.locator('#recovery-dialog-title') })
    await expect(recoveryDialog).toBeVisible()
    await expectNoBlockingAccessibilityViolations(page, `${locale} recovery-start readiness`)
    await capture(recoveryDialog, `web-${locale}-usability-recover-run.png`)
    await page.keyboard.press('Escape')
    await expect(recoveryDialog).toHaveCount(0)

    await openWorkspaceSection(page, copy[locale].settings, copy[locale].workspace)
    await page.getByTestId('settings-index-integrations').click()
    await page.locator('.we-operations-page__content')
      .getByRole('button', { name: copy[locale].connectionIndex, exact: true })
      .click()
    const addConnection = page.getByRole('button', {
      name: copy[locale].addConnection,
      exact: true,
    }).first()
    await expect(addConnection).toBeVisible()
    await addConnection.click()
    const connectionDialog = page.getByRole('dialog', {
      name: copy[locale].addConnectionDialog,
    })
    await expect(connectionDialog).toBeVisible()
    await expectNoBlockingAccessibilityViolations(page, `${locale} add-connection readiness`)
    await capture(connectionDialog, `web-${locale}-usability-add-connection.png`)
    await page.keyboard.press('Escape')
    await expect(connectionDialog).toHaveCount(0)

    await openWorkspaceSection(page, copy[locale].settings, copy[locale].team)
    const inviteEmail = page.locator('#member-email')
    await expect(page.getByText(copy[locale].invite, { exact: true })).toBeVisible()
    await expect(inviteEmail).toBeVisible()
    await inviteEmail.focus()
    await expect(inviteEmail).toBeFocused()
    await expectNoBlockingAccessibilityViolations(page, `${locale} invite-teammate readiness`)
    await expectNoPageOverflow(page)
    await capture(shell, `web-${locale}-usability-invite-teammate.png`)

    expect(browserErrors).toEqual([])
    readiness.locales[locale] = {
      orgId,
      viewport: page.viewportSize(),
      tasks: {
        create_workflow: 'visible',
        find_failed_run: 'visible_with_real_failure',
        recover_run: 'dialog_opened',
        add_connection: 'dialog_opened',
        invite_teammate: 'form_focused',
      },
    }
    await context.close()
  }

  if (EVIDENCE_DIR) {
    await mkdir(EVIDENCE_DIR, { recursive: true })
    await writeFile(
      path.join(EVIDENCE_DIR, 'automated-usability-readiness.json'),
      `${JSON.stringify(readiness, null, 2)}\n`,
      { mode: 0o600 },
    )
  }
})
