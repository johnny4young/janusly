import type { Page } from '@playwright/test'

type Locale = 'en' | 'es'
type JsonObject = Record<string, unknown>

const labels = {
  en: {
    compile: 'Compile intent brief',
    build: 'Build proposal',
    apply: 'Apply proposal to draft',
  },
  es: {
    compile: 'Compilar brief de intención',
    build: 'Construir propuesta',
    apply: 'Aplicar propuesta al borrador',
  },
} as const

export async function buildWorkflowProposal(page: Page, locale: Locale = 'en') {
  await page.getByRole('button', { name: labels[locale].compile, exact: true }).click()
  await page.getByTestId('intent-brief').waitFor({ state: 'visible' })
  await page.getByRole('button', { name: labels[locale].build, exact: true }).click()
  const proposal = page.getByTestId('workflow-proposal')
  await proposal.waitFor({ state: 'visible' })
  return proposal
}

export async function applyBuiltWorkflowProposal(page: Page, locale: Locale = 'en') {
  await page.getByRole('button', { name: labels[locale].apply, exact: true }).click()

  // A dirty canvas deliberately requires a second, independent decision.
  // The same helper supports both a fresh canvas and a guarded replacement.
  const dialog = page.getByRole('alertdialog')
  if (await dialog.waitFor({ state: 'visible', timeout: 1_000 }).then(() => true).catch(() => false)) {
    await page.getByTestId('confirm-dialog-confirm').click()
  }
}

export async function applyWorkflowProposal(page: Page, locale: Locale = 'en') {
  const proposal = await buildWorkflowProposal(page, locale)
  await applyBuiltWorkflowProposal(page, locale)
  return proposal
}

export async function mockWorkflowProposal(
  page: Page,
  workflow: JsonObject,
  options: {
    mode?: 'ai' | 'fallback'
    bonBackoff?: JsonObject
    assumptions?: string[]
    risks?: string[]
  } = {},
): Promise<void> {
  await page.route('**/ai/workflow-proposals', async (route) => {
    const request = route.request().postDataJSON() as {
      brief?: JsonObject
      catalogVersion?: string
    }
    const nodes = Array.isArray(workflow.nodes) ? workflow.nodes as JsonObject[] : []
    const edges = Array.isArray(workflow.edges) ? workflow.edges : []
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        mode: options.mode ?? 'fallback',
        brief: request.brief ?? {},
        clarifyingQuestions: [],
        bindings: {
          catalogVersion: request.catalogVersion ?? 'e2e',
          resolved: [],
          missing: [],
          complete: true,
        },
        proposal: {
          workflow,
          intentContract: workflow.outputs ?? {},
          recoveryContract: (workflow.recovery as JsonObject | undefined)?.contract ?? {},
          qualification: { intent: true, recovery: true, semantic: true },
          assumptions: options.assumptions ?? [],
          risks: options.risks ?? [],
          readiness: { status: 'pass', issues: [] },
          diff: {
            nodesAdded: nodes.map((node) => String(node.id ?? '')).filter(Boolean),
            nodesRemoved: [],
            nodesChanged: [],
            edgesBefore: 0,
            edgesAfter: edges.length,
          },
          applicable: true,
        },
        ...(options.bonBackoff ? { bonBackoff: options.bonBackoff } : {}),
      }),
    })
  })
}
