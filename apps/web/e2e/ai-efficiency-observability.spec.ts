import { openWorkspaceSection } from './_helpers/workspace-navigation'
/** Real-stack proof for AI/run efficiency in Operations, Reasoning, and Copilot. */

import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'

const execFileAsync = promisify(execFile)
const COMPOSE_FILE = fileURLToPath(new URL('../../../docker-compose.yml', import.meta.url))
const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR
const API_URL = process.env.E2E_API_URL ?? 'http://127.0.0.1:3001'

type Locale = 'en' | 'es'

const copy = {
  en: {
    operations: 'Operations',
    costHeading: 'Cost breakdown',
    cacheLabel: 'Prompt cache efficiency',
    runs: 'Runs',
    timeline: 'View timeline',
    loading: 'Loading persisted usage',
    usageAria: 'Run resource usage',
    empty: 'No AI or memory usage has been recorded',
    error: "Couldn't load resource usage",
    invalid: "The server returned usage data Janusly couldn't validate.",
    draft: 'Draft flow',
    backoff: 'evaluated 1 of 4 candidates',
    cacheTokens: '8,000',
    createdTokens: '2,000',
    knownCost: '0.0425',
  },
  es: {
    operations: 'Operaciones',
    costHeading: 'Desglose de costo',
    cacheLabel: 'Eficiencia de la caché de instrucciones',
    runs: 'Ejecuciones',
    timeline: 'Ver cronología',
    loading: 'Cargando el uso registrado',
    usageAria: 'Uso de recursos de la ejecución',
    empty: 'No se registró uso de IA ni de memoria',
    error: 'No se pudo cargar el uso de recursos',
    invalid: 'El servidor devolvió datos de uso que Janusly no pudo validar.',
    draft: 'Armar flujo',
    backoff: 'evaluó 1 de 4 candidatos',
    cacheTokens: '8000',
    createdTokens: '2000',
    knownCost: '0,0425',
  },
} as const

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function headers(orgId: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-org-id': orgId,
    'x-user-id': 'dev-user',
  }
}

async function startObservedRun(request: APIRequestContext, orgId: string, stamp: string): Promise<string> {
  const response = await request.post(`${API_URL}/start`, {
    headers: headers(orgId),
    data: {
      id: `efficiency-flow-${stamp}`,
      name: `AI efficiency ${stamp}`,
      nodes: [{ id: 'observe_usage', type: 'noop', config: {} }],
      edges: [],
    },
  })
  expect(response.ok()).toBe(true)
  const { runId } = await response.json() as { runId: string }
  const startedAt = Date.now()
  while (Date.now() - startedAt < 30_000) {
    const detail = await request.get(`${API_URL}/run?runId=${encodeURIComponent(runId)}`, {
      headers: headers(orgId),
    })
    expect(detail.ok()).toBe(true)
    const body = await detail.json() as { run?: { status?: string } }
    if (body.run?.status === 'succeeded') return runId
    if (body.run?.status === 'failed' || body.run?.status === 'cancelled') {
      throw new Error(`Observed run reached ${body.run.status}`)
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Observed run ${runId} did not complete`)
}

async function seedRunUsage(orgId: string, runId: string, stamp: string): Promise<void> {
  await execFileAsync('docker', [
    'compose', '-f', COMPOSE_FILE,
    'exec', '-T', 'postgres',
    'psql', '-U', 'postgres', '-d', 'workflow', '-v', 'ON_ERROR_STOP=1',
    '-c', `
      INSERT INTO usage_events (id, org_id, run_id, metric, quantity, metadata, created_at)
      VALUES
        (${sqlLiteral(`efficiency-llm-a-${stamp}`)}, ${sqlLiteral(orgId)}, ${sqlLiteral(runId)}, 'llm.completion', 10000,
          '{"provider":"anthropic","model":"claude-haiku-4-5-20251001","inputTokens":9000,"outputTokens":1000,"cachedInputTokens":5000,"cacheCreationInputTokens":1500,"costUsd":0.0425}'::jsonb, now() - interval '4 seconds'),
        (${sqlLiteral(`efficiency-llm-b-${stamp}`)}, ${sqlLiteral(orgId)}, ${sqlLiteral(runId)}, 'llm.completion', 8000,
          '{"provider":"anthropic","model":"claude-haiku-4-5-20251001","inputTokens":7000,"outputTokens":1000,"cachedInputTokens":3000,"cacheCreationInputTokens":500}'::jsonb, now() - interval '3 seconds'),
        (${sqlLiteral(`efficiency-memory-a-${stamp}`)}, ${sqlLiteral(orgId)}, ${sqlLiteral(runId)}, 'memory.recall', 1,
          '{"kind":"agent_episode","ok":true}'::jsonb, now() - interval '2 seconds'),
        (${sqlLiteral(`efficiency-memory-b-${stamp}`)}, ${sqlLiteral(orgId)}, ${sqlLiteral(runId)}, 'memory.commit', 1,
          '{"kind":"workflow_vector","ok":false}'::jsonb, now() - interval '1 second');
    `,
  ])
}

function installErrorGuards(page: Page): string[] {
  const errors: string[] = []
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', error => errors.push(error.message))
  return errors
}

async function hideUnrelatedOverlays(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const selector of [
      '.toast-stack',
      '.toast',
      '.we-onboarding-banner',
      '.we-budget-blocked-banner',
      '[data-testid="command-palette"]',
    ]) {
      for (const element of document.querySelectorAll<HTMLElement>(selector)) element.style.display = 'none'
    }
  })
}

async function capture(locator: Locator, name: string): Promise<void> {
  await expect(locator).toBeVisible()
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  expect(box?.width ?? 0).toBeGreaterThan(0)
  expect(box?.height ?? 0).toBeGreaterThan(0)
  if (!EVIDENCE_DIR) return
  await mkdir(EVIDENCE_DIR, { recursive: true })
  await locator.screenshot({ path: `${EVIDENCE_DIR}/${name}.png`, animations: 'disabled', caret: 'hide' })
}

async function openRunFromHistory(page: Page, runId: string, locale: Locale): Promise<void> {
  await openWorkspaceSection(
    page,
    locale === 'en' ? 'Activity' : 'Actividad',
    copy[locale].runs,
  )
  const overviewTab = page.getByTestId('run-workspace-tab-overview')
  if (await overviewTab.isVisible().catch(() => false)) await overviewTab.click()
  const history = page.getByTestId('runs-history-virtual-list')
  await expect(history).toBeVisible()
  await expect.poll(() => history.getByRole('article').count()).toBeGreaterThan(0)
  const prefix = `${runId.slice(0, 8)}…`
  const card = history.getByRole('article').filter({ hasText: prefix }).first()
  await expect(card).toBeVisible()
  await card.locator('button.list-card-row').click()
  await expect(page.getByTestId('run-overview')).toContainText(runId.slice(0, 12))
  await page.getByTestId('run-overview').getByRole('button', { name: copy[locale].timeline, exact: true }).click()
}

function emptyUsage() {
  return {
    loadedRows: 0,
    truncated: false,
    rowCap: 10_000,
    llm: {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      knownCostUsd: 0,
      unknownCostCalls: 0,
    },
    memory: { recalls: 0, commits: 0, failures: 0, kinds: [] },
  }
}

async function captureRunUsageStates(page: Page, runId: string, locale: Locale): Promise<void> {
  await page.route('**/v1/run/usage?**', async route => {
    const response = await route.fetch()
    await new Promise(resolve => setTimeout(resolve, 700))
    await route.fulfill({ response })
  }, { times: 1 })
  await openRunFromHistory(page, runId, locale)
  const usage = page.getByTestId('run-resource-usage')
  await expect(usage).toHaveAttribute('data-state', 'loading')
  await expect(usage).toContainText(copy[locale].loading)
  await hideUnrelatedOverlays(page)
  await capture(usage, `web-${locale}-run-resource-usage-loading`)
  await expect(usage).toHaveAttribute('data-state', 'ready')
  await expect(usage).toHaveAccessibleName(copy[locale].usageAria)
  await expect(usage).toContainText(copy[locale].cacheTokens)
  await expect(usage).toContainText(copy[locale].knownCost)
  await hideUnrelatedOverlays(page)
  await capture(usage, `web-${locale}-run-resource-usage-ready`)

  await page.route('**/v1/run/usage?**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ apiVersion: 'v1', requestId: 'e2e-empty', data: emptyUsage() }),
  }), { times: 1 })
  await page.reload()
  await hideUnrelatedOverlays(page)
  await openRunFromHistory(page, runId, locale)
  await expect(usage).toHaveAttribute('data-state', 'empty')
  await expect(usage).toContainText(copy[locale].empty)
  await capture(usage, `web-${locale}-run-resource-usage-empty`)

  await page.route('**/v1/run/usage?**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      apiVersion: 'v1',
      requestId: 'e2e-error',
      data: { loadedRows: 1, llm: {}, memory: {} },
    }),
  }), { times: 1 })
  await page.reload()
  await hideUnrelatedOverlays(page)
  await openRunFromHistory(page, runId, locale)
  await expect(usage).toHaveAttribute('data-state', 'error')
  await expect(usage).toContainText(copy[locale].error)
  await expect(usage).toContainText(copy[locale].invalid)
  await capture(usage, `web-${locale}-run-resource-usage-error`)
}

test('AI and run efficiency are observable in English and Spanish', async ({ page, request }) => {
  test.setTimeout(120_000)
  const browserErrors = installErrorGuards(page)
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const orgId = `efficiency-${stamp}`
  const runId = await startObservedRun(request, orgId, stamp)
  await seedRunUsage(orgId, runId, stamp)

  const usageResponse = await request.get(`${API_URL}/v1/run/usage?runId=${encodeURIComponent(runId)}`, {
    headers: headers(orgId),
  })
  expect(usageResponse.ok()).toBe(true)
  await expect(usageResponse.json()).resolves.toMatchObject({
    apiVersion: 'v1',
    data: {
      loadedRows: 4,
      llm: {
        calls: 2,
        inputTokens: 16_000,
        cachedInputTokens: 8_000,
        cacheCreationInputTokens: 2_000,
        knownCostUsd: 0.0425,
        unknownCostCalls: 1,
      },
      memory: { recalls: 1, commits: 1, failures: 1 },
    },
  })

  await page.addInitScript(({ activeOrg }) => {
    window.localStorage.setItem('janusly:activeOrg', activeOrg)
    if (!window.localStorage.getItem('janusly:locale')) window.localStorage.setItem('janusly:locale', 'en')
    window.localStorage.setItem('janusly:recovery:hideIntro', 'true')
  }, { activeOrg: orgId })
  await page.route('**/ai/generate-workflow', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      mode: 'ai',
      model: 'claude-haiku-4-5-20251001',
      provider: 'anthropic',
      candidateCount: 1,
      bonBackoff: { from: 4, to: 1 },
      dslVersion: '1.0',
      id: `budget-aware-${stamp}`,
      name: `Budget-aware flow ${stamp}`,
      nodes: [{ id: 'start', type: 'noop', config: {} }],
      edges: [],
    }),
  }))

  for (const locale of ['en', 'es'] as const) {
    await page.goto('/')
    if (locale === 'es') {
      await page.evaluate(() => window.localStorage.setItem('janusly:locale', 'es'))
      await page.reload()
    }
    await hideUnrelatedOverlays(page)

    await openWorkspaceSection(
      page,
      locale === 'en' ? 'Settings' : 'Configuración',
      locale === 'en' ? 'Workspace' : 'Espacio de trabajo',
    )
    const costCard = page.locator('.we-card').filter({ hasText: copy[locale].costHeading }).first()
    const cacheSummary = costCard.getByLabel(copy[locale].cacheLabel)
    await expect(cacheSummary).toContainText('50%')
    await expect(cacheSummary).toContainText(copy[locale].cacheTokens)
    await expect(costCard).toContainText(copy[locale].createdTokens)
    await hideUnrelatedOverlays(page)
    await capture(costCard, `web-${locale}-operations-cache-efficiency-ready`)

    await captureRunUsageStates(page, runId, locale)

    await openWorkspaceSection(
      page,
      locale === 'en' ? 'Workflows' : 'Flujos',
      locale === 'en' ? 'Build with AI' : 'Crear con IA',
    )
    await page.locator('.copilot-prompt').fill(locale === 'en'
      ? 'Draft a budget-aware approval flow.'
      : 'Arma un flujo de aprobación ajustado al presupuesto.')
    await page.getByRole('button', { name: copy[locale].draft, exact: true }).click()
    const backoff = page.getByTestId('ai-candidate-backoff')
    await expect(backoff).toContainText(copy[locale].backoff)
    await hideUnrelatedOverlays(page)
    await capture(backoff.locator('..'), `web-${locale}-ai-candidate-backoff-result`)
  }

  expect(browserErrors).toEqual([])
})
