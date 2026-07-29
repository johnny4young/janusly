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
    workflows: 'Workflows',
    activity: 'Activity',
    settings: 'Settings',
    recover: 'Recover',
    allWorkflows: 'All workflows',
    emptyWorkflows: 'No flows saved yet',
    runs: 'Runs',
    workspace: 'Workspace',
    operationsHeading: 'Operations',
    primaryGroup: 'Workspace',
    homeKicker: 'Recovery Center',
    search: 'Search sections…',
  },
  {
    locale: 'es',
    home: 'Inicio',
    workflows: 'Flujos',
    activity: 'Actividad',
    settings: 'Configuración',
    recover: 'Recuperar',
    allWorkflows: 'Todos los flujos',
    emptyWorkflows: 'Aún no hay flujos guardados',
    runs: 'Ejecuciones',
    workspace: 'Espacio de trabajo',
    operationsHeading: 'Operaciones',
    primaryGroup: 'Principal',
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
  await page.getByRole('button', { name: /^Start blank\b/ }).click()

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
  test(`${locale.locale} exposes four destinations with contextual activity sections`, async ({
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

    await page.setViewportSize({ width: 1280, height: 720 })
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
    await expect(sidebar.getByText(locale.primaryGroup, { exact: true }))
      .toBeVisible()
    for (const destination of [
      locale.home,
      locale.workflows,
      locale.activity,
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
      name: locale.activity,
      exact: true,
    }).click()
    const sectionNav = page.getByTestId('workspace-section-nav')
    await expect(sectionNav).toHaveAttribute('data-destination', 'activity')
    await expect(sectionNav.getByRole('button', {
      name: locale.runs,
      exact: true,
    })).toHaveAttribute('aria-current', 'page')
    await expect(sectionNav.getByRole('button', {
      name: locale.recover,
      exact: true,
    })).toBeVisible()
    await sectionNav.getByRole('button', {
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
      sidebar.getByRole('button', { name: locale.activity, exact: true }),
    ).toHaveAttribute('aria-current', 'page')
    await expectAccessible(page, `${locale.locale} Recover task space`)
    await capture(
      shell,
      `web-${locale.locale}-recover-task-space`,
    )

    await sidebar.getByRole('button', {
      name: locale.workflows,
      exact: true,
    }).click()
    await expect(sectionNav).toHaveAttribute('data-destination', 'workflows')
    await expect(sectionNav.getByRole('button', {
      name: locale.allWorkflows,
      exact: true,
    })).toHaveAttribute('aria-current', 'page')
    await expect(page.getByText(locale.emptyWorkflows, { exact: true }))
      .toBeVisible()
    await expectAccessible(page, `${locale.locale} Workflows task space`)
    await capture(
      shell,
      `web-${locale.locale}-workflows-task-space`,
    )

    await sidebar.getByRole('button', {
      name: locale.settings,
      exact: true,
    }).click()
    await expect(sectionNav).toHaveAttribute('data-destination', 'settings')
    await expect(sectionNav.getByRole('button', {
      name: locale.workspace,
      exact: true,
    })).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('heading', {
      name: locale.operationsHeading,
      exact: true,
    })).toBeVisible()
    await expectAccessible(page, `${locale.locale} Settings task space`)
    await capture(
      shell,
      `web-${locale.locale}-settings-task-space`,
    )

    expect(homeRequests.filter((search) => search === '')).toHaveLength(1)
    expect(await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    )).toBeLessThanOrEqual(2)
    expect(consoleErrors).toEqual([])
    expect(pageErrors).toEqual([])
  })
}
