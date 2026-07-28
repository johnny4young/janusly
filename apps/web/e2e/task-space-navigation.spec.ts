import { mkdir } from 'node:fs/promises'
import AxeBuilder from '@axe-core/playwright'
import {
  expect,
  test,
  type Locator,
  type Page,
} from '@playwright/test'

const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR
const WCAG_TAGS = [
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22aa',
]

const LOCALES = [
  {
    locale: 'en',
    home: 'Home',
    recover: 'Recover',
    workflows: 'Workflows',
    newWorkflow: 'New workflow',
    runs: 'Runs',
    connections: 'Connections',
    settings: 'Operations',
    primaryGroup: 'Workspace',
    advancedGroup: 'Advanced',
    homeKicker: 'Recovery Center',
    search: 'Search sections…',
  },
  {
    locale: 'es',
    home: 'Inicio',
    recover: 'Recuperar',
    workflows: 'Flujos',
    newWorkflow: 'Nuevo flujo',
    runs: 'Ejecuciones',
    connections: 'Conexiones',
    settings: 'Operaciones',
    primaryGroup: 'Principal',
    advancedGroup: 'Avanzado',
    homeKicker: 'Centro de recuperación',
    search: 'Buscar secciones…',
  },
] as const

async function capture(locator: Locator, name: string): Promise<void> {
  await expect(locator).toBeVisible()
  if (!EVIDENCE_DIR) return
  await mkdir(EVIDENCE_DIR, { recursive: true })
  await locator.screenshot({
    path: `${EVIDENCE_DIR}/${name}.png`,
    animations: 'disabled',
    caret: 'hide',
  })
}

async function expectAccessible(page: Page, context: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(WCAG_TAGS).analyze()
  const blocking = results.violations
    .filter((violation) =>
      violation.impact === 'serious'
      || violation.impact === 'critical')
    .map((violation) => ({
      context,
      rule: violation.id,
      targets: violation.nodes.map((node) => node.target.map(String)),
    }))
  expect(blocking).toEqual([])
}

test.describe.configure({ mode: 'serial' })

test('workflow creation is reachable from the workflow inventory', async ({ page }) => {
  const orgId = `task-workflow-create-${Date.now()}`
  const consoleErrors: string[] = []
  const pageErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.setViewportSize({ width: 1440, height: 1100 })
  await page.addInitScript((activeOrg) => {
    window.localStorage.setItem('janusly:activeOrg', activeOrg)
    window.localStorage.setItem('janusly:locale', 'en')
    window.localStorage.setItem('janusly:activeTab', 'home')
    window.localStorage.removeItem('janusly:sidebar:state')
  }, orgId)
  await page.goto('/')

  const sidebar = page.locator('.builder-sidebar')
  const workflowsDestination = sidebar.getByRole('button', {
    name: 'Workflows',
    exact: true,
  })
  await expect(workflowsDestination).toBeVisible()
  await workflowsDestination.click()

  const createWorkflowAction = page.getByRole('button', {
    name: 'New workflow',
    exact: true,
  })
  await expect(createWorkflowAction).toBeVisible()
  await expect(createWorkflowAction).toBeEnabled()
  await createWorkflowAction.click()

  const canvas = page.locator('.workspace-main .react-flow').first()
  await expect(canvas).toBeVisible()
  await expect(page.getByTestId('workspace-canvas-wrapper')).toHaveAttribute(
    'data-canvas-visible',
    'true',
  )
  await expectAccessible(page, 'workflow creation task')
  await capture(
    page.locator('.app-shell'),
    'web-en-workflow-creation-task',
  )
  expect(consoleErrors).toEqual([])
  expect(pageErrors).toEqual([])
})

for (const locale of LOCALES) {
  test(`${locale.locale} separates Home, Recover, and advanced authoring`, async ({
    page,
  }) => {
    const orgId = `task-spaces-${locale.locale}-${Date.now()}`
    const consoleErrors: string[] = []
    const pageErrors: string[] = []
    const homeRequests: string[] = []
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('pageerror', (error) => pageErrors.push(error.message))
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (url.pathname === '/recovery/home') {
        homeRequests.push(url.search)
      }
    })

    await page.setViewportSize({ width: 1440, height: 1100 })
    await page.addInitScript(({ activeOrg, selectedLocale }) => {
      window.localStorage.setItem('janusly:activeOrg', activeOrg)
      window.localStorage.setItem('janusly:locale', selectedLocale)
      window.localStorage.setItem('janusly:activeTab', 'home')
      window.localStorage.removeItem('janusly:sidebar:state')
    }, { activeOrg: orgId, selectedLocale: locale.locale })
    await page.goto('/')

    const shell = page.locator('.app-shell')
    const sidebar = page.locator('.builder-sidebar')
    await expect(
      page.locator('.we-recovery-center-hero .section-kicker'),
    ).toHaveText(locale.homeKicker)
    await expect(
      sidebar.getByRole('button', {
        name: new RegExp(`^${locale.primaryGroup}\\b`),
      }),
    ).toHaveAttribute('aria-expanded', 'true')
    await expect(
      sidebar.getByRole('button', {
        name: new RegExp(`^${locale.advancedGroup}\\b`),
      }),
    ).toHaveAttribute('aria-expanded', 'false')
    for (const destination of [
      locale.home,
      locale.recover,
      locale.workflows,
      locale.runs,
      locale.connections,
      locale.settings,
    ]) {
      await expect(
        sidebar.getByRole('button', {
          name: new RegExp(`^${destination}\\b`),
        }),
      ).toBeVisible()
    }
    await expect(sidebar.getByLabel(locale.search)).toBeVisible()
    await expect(sidebar.locator('.sb-workflow')).toHaveCount(0)
    await expect(sidebar.locator('.sb-ai-strip')).toHaveCount(0)
    await expect(sidebar.locator('.sb-pinned')).toHaveCount(0)
    await expectAccessible(page, `${locale.locale} Home task space`)
    await capture(
      shell,
      `web-${locale.locale}-home-task-spaces`,
    )

    await sidebar.getByRole('button', {
      name: locale.recover,
      exact: true,
    }).click()
    await expect(page.getByRole('heading', {
      name: locale.recover,
      exact: true,
    })).toBeVisible()
    await expect(page.getByTestId('recovery-queue')).toBeVisible()
    await expect(page.getByTestId('runs-metric-strip')).toHaveCount(0)
    await expect(page.getByTestId('usage-summary-card')).toHaveCount(0)
    await expect(
      sidebar.getByRole('button', { name: locale.recover, exact: true }),
    ).toHaveAttribute('aria-current', 'page')
    await expect(
      sidebar.getByRole('button', {
        name: new RegExp(`^${locale.advancedGroup}\\b`),
      }),
    ).toHaveAttribute('aria-expanded', 'false')
    await expectAccessible(page, `${locale.locale} Recover task space`)
    await capture(
      shell,
      `web-${locale.locale}-recover-task-space`,
    )

    expect(homeRequests.filter((search) => search === '')).toHaveLength(1)
    expect(await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )).toBeLessThanOrEqual(2)
    expect(consoleErrors).toEqual([])
    expect(pageErrors).toEqual([])
  })
}
