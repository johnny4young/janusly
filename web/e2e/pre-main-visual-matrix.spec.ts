import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import {
  expect,
  test,
  type Browser,
  type Page,
} from '@playwright/test'

import {
  createSemanticRecoveryFixture,
  type SemanticFixtureLocale,
  type SemanticRecoveryFixture,
} from './_helpers/semantic-recovery-fixture'
import {
  openWorkflowAiAction,
  openWorkspaceSection,
} from './_helpers/workspace-navigation'

const enabled = process.env.JANUSLY_PRE_MAIN_VISUAL_E2E === '1'
const phase = process.env.JANUSLY_VISUAL_PHASE === 'before' ? 'before' : 'after'
const evidenceDir = process.env.JANUSLY_EVIDENCE_DIR
const runtimeUrl = process.env.JANUSLY_E2E_RUNTIME_BASE_URL
  ?? process.env.PLAYWRIGHT_BASE_URL
  ?? 'http://127.0.0.1:3001'
const apiUrl = process.env.E2E_API_URL ?? runtimeUrl
const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

type Theme = 'light' | 'dark'
type Surface =
  | 'home'
  | 'command-palette'
  | 'recovery-case'
  | 'ai-studio'
  | 'team'
  | 'connections'
  | 'connection-dialog'

type ViewportCase = {
  name: 'desktop' | 'tablet' | 'mobile'
  width: number
  height: number
}

type SurfaceEvidence = {
  surface: Surface
  screenshot: string
  overflowPx: number
  blockingViolations: Array<{
    id: string
    impact: string | null
    nodes: number
  }>
}

type MatrixEvidence = {
  phase: 'before' | 'after'
  boundary: string
  generatedAt: string
  runtimeUrl: string
  apiUrl: string
  combinations: Array<{
    locale: SemanticFixtureLocale
    theme: Theme
    viewport: ViewportCase
    caseId: string
    surfaces: SurfaceEvidence[]
    browserErrors: string[]
  }>
}

const viewports: readonly ViewportCase[] = [
  { name: 'desktop', width: 1440, height: 1000 },
  { name: 'tablet', width: 1024, height: 768 },
  { name: 'mobile', width: 390, height: 844 },
]

const copy = {
  en: {
    workflows: 'Workflows',
    settings: 'Settings',
    workspace: 'Workspace',
    team: 'Team',
    connections: 'Connections',
    addConnection: 'Add connection',
    addConnectionDialog: 'Register a protected secret',
    connectionName: 'Connection name',
    navigation: 'Navigation',
    closeNavigation: 'Close navigation',
  },
  es: {
    workflows: 'Flujos',
    settings: 'Configuración',
    workspace: 'Espacio de trabajo',
    team: 'Equipo',
    connections: 'Conexiones',
    addConnection: 'Añadir conexión',
    addConnectionDialog: 'Registrar un secreto protegido',
    connectionName: 'Nombre de la conexión',
    navigation: 'Navegación',
    closeNavigation: 'Cerrar navegación',
  },
} as const

function installBrowserGuards(page: Page): string[] {
  const errors: string[] = []
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`)
  })
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`))
  page.on('response', response => {
    if (response.status() < 400) return
    const pathname = new URL(response.url()).pathname
    // A missing optional HttpOnly SSO session is the normal dev-header probe.
    if (pathname === '/auth/session' && [401, 404].includes(response.status())) return
    const type = response.request().resourceType()
    if (type === 'fetch' || type === 'xhr') {
      errors.push(`http ${response.status()}: ${response.request().method()} ${pathname}`)
    }
  })
  return errors
}

async function settleVisualState(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const selector of ['.toast-stack', '.we-budget-banner']) {
      for (const element of document.querySelectorAll<HTMLElement>(selector)) {
        element.style.display = 'none'
      }
    }
  })
}

async function captureSurface(
  page: Page,
  surface: Surface,
  slug: string,
): Promise<SurfaceEvidence> {
  await settleVisualState(page)
  const overflowPx = await page.evaluate(
    () => Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
  )
  expect(overflowPx, `${slug}/${surface} must not overflow horizontally`).toBeLessThanOrEqual(2)

  const axe = await new AxeBuilder({ page }).withTags(wcagTags).analyze()
  const blockingViolations = axe.violations
    .filter(violation => violation.impact === 'critical' || violation.impact === 'serious')
    .map(violation => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.length,
    }))
  if (phase === 'after') {
    expect(
      blockingViolations,
      `${slug}/${surface} must have no serious or critical accessibility violations`,
    ).toEqual([])
  }

  const filename = `${phase}-${slug}-${surface}.png`
  if (evidenceDir) {
    await mkdir(evidenceDir, { recursive: true })
    await page.screenshot({
      path: path.join(evidenceDir, filename),
      animations: 'disabled',
      caret: 'hide',
      fullPage: false,
    })
  }
  return {
    surface,
    screenshot: filename,
    overflowPx,
    blockingViolations,
  }
}

async function openRecoveryCase(
  page: Page,
  fixture: SemanticRecoveryFixture,
): Promise<void> {
  const preferred = page.getByTestId('recovery-center-action-cta-review_semantic_cases')
  if (await preferred.isVisible().catch(() => false)) {
    await preferred.click()
  } else {
    await page.getByTestId(`semantic-recovery-open-${fixture.caseId}`).click()
  }
  await expect(page.getByTestId(`recovery-case-workspace-${fixture.caseId}`)).toBeVisible()
}

async function validateMobileNavigation(page: Page, locale: SemanticFixtureLocale): Promise<void> {
  const trigger = page.getByRole('button', { name: copy[locale].navigation })
  await trigger.click()
  const close = page.getByRole('button', { name: copy[locale].closeNavigation })
  await expect(close).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
}

async function captureCombination(
  browser: Browser,
  locale: SemanticFixtureLocale,
  theme: Theme,
  viewport: ViewportCase,
  fixture: SemanticRecoveryFixture,
): Promise<MatrixEvidence['combinations'][number]> {
  const context = await browser.newContext({
    baseURL: runtimeUrl,
    viewport: { width: viewport.width, height: viewport.height },
    reducedMotion: 'reduce',
  })
  const page = await context.newPage()
  const browserErrors = installBrowserGuards(page)
  await page.addInitScript(({ activeOrg, selectedLocale, selectedTheme }) => {
    window.localStorage.clear()
    window.sessionStorage.clear()
    window.localStorage.setItem('janusly:activeOrg', activeOrg)
    window.localStorage.setItem('janusly:locale', selectedLocale)
    window.localStorage.setItem('janusly:theme', selectedTheme)
    window.localStorage.setItem('janusly:activeTab', 'home')
    window.localStorage.setItem('janusly:recovery:hideIntro', 'true')
    window.localStorage.setItem('janusly:operations:section', 'overview')
  }, {
    activeOrg: fixture.orgId,
    selectedLocale: locale,
    selectedTheme: theme,
  })

  const slug = `${locale}-${theme}-${viewport.name}-${viewport.width}x${viewport.height}`
  const surfaces: SurfaceEvidence[] = []
  await page.goto('/')
  await expect(page.locator('.app-shell')).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
  await expect(page.locator('.we-recovery-center-hero')).toBeVisible()
  surfaces.push(await captureSurface(page, 'home', slug))

  if (viewport.name === 'mobile') await validateMobileNavigation(page, locale)

  await page.keyboard.press('ControlOrMeta+K')
  const palette = page.getByTestId('command-palette')
  await expect(palette).toBeVisible()
  await expect(palette.getByRole('combobox')).toBeFocused()
  surfaces.push(await captureSurface(page, 'command-palette', slug))
  await page.keyboard.press('Escape')
  await expect(palette).toHaveCount(0)

  await openRecoveryCase(page, fixture)
  surfaces.push(await captureSurface(page, 'recovery-case', slug))

  await openWorkflowAiAction(page, copy[locale].workflows)
  await expect(page.locator('.ai-studio-hero')).toBeVisible()
  surfaces.push(await captureSurface(page, 'ai-studio', slug))

  await openWorkspaceSection(page, copy[locale].settings, copy[locale].team)
  const memberEmail = page.locator('#member-email')
  await expect(memberEmail).toBeVisible()
  await memberEmail.focus()
  await expect(memberEmail).toBeFocused()
  surfaces.push(await captureSurface(page, 'team', slug))

  await openWorkspaceSection(page, copy[locale].settings, copy[locale].workspace)
  await page.getByTestId('settings-index-integrations').click()
  await page.locator('.we-operations-page__content')
    .getByRole('button', { name: copy[locale].connections, exact: true })
    .click()
  await expect(page.getByRole('button', { name: copy[locale].addConnection }).first()).toBeVisible()
  surfaces.push(await captureSurface(page, 'connections', slug))

  await page.getByRole('button', { name: copy[locale].addConnection }).first().click()
  const dialog = page.getByRole('dialog', { name: copy[locale].addConnectionDialog })
  await expect(dialog).toBeVisible()
  await expect(page.getByLabel(copy[locale].connectionName)).toBeFocused()
  surfaces.push(await captureSurface(page, 'connection-dialog', slug))
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)

  expect(browserErrors, `${slug} must not emit browser errors`).toEqual([])
  await context.close()
  return { locale, theme, viewport, caseId: fixture.caseId, surfaces, browserErrors }
}

test.describe.configure({ mode: 'serial' })

test('captures the exact pre-main bilingual theme and viewport matrix', async ({ browser }) => {
  test.skip(!enabled, 'requires an isolated local runtime and explicit visual evidence opt-in')
  test.setTimeout(20 * 60_000)
  const fixtures = {
    en: await createSemanticRecoveryFixture('en', {
      apiUrl,
      orgPrefix: `visual-${phase}`,
    }),
    es: await createSemanticRecoveryFixture('es', {
      apiUrl,
      orgPrefix: `visual-${phase}`,
    }),
  }
  const evidence: MatrixEvidence = {
    phase,
    boundary: phase === 'before'
      ? 'Exact reconstructed pre-phase commit; observed baseline, not current product behavior.'
      : 'Exact local candidate behavior; local evidence is not production certification.',
    generatedAt: new Date().toISOString(),
    runtimeUrl,
    apiUrl,
    combinations: [],
  }

  for (const locale of ['en', 'es'] as const) {
    for (const theme of ['light', 'dark'] as const) {
      for (const viewport of viewports) {
        evidence.combinations.push(await captureCombination(
          browser,
          locale,
          theme,
          viewport,
          fixtures[locale],
        ))
      }
    }
  }

  expect(evidence.combinations).toHaveLength(12)
  expect(evidence.combinations.flatMap(item => item.surfaces)).toHaveLength(84)
  if (evidenceDir) {
    await mkdir(evidenceDir, { recursive: true })
    await writeFile(
      path.join(evidenceDir, `${phase}-visual-matrix.json`),
      `${JSON.stringify(evidence, null, 2)}\n`,
      { mode: 0o600 },
    )
  }
})
