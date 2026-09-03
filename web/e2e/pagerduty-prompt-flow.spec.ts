import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { seedCredential } from './_helpers/demo-helpers'
import { openWorkflowAiAction, openWorkspaceSection } from './_helpers/workspace-navigation'
import { applyBuiltWorkflowProposal, buildWorkflowProposal } from './_helpers/workflow-authoring'

const enabled = process.env.JANUSLY_LOCAL_STACK_E2E === '1'
const evidenceDir = process.env.JANUSLY_EVIDENCE_DIR

const scenarios = [
  {
    locale: 'en' as const,
    workflows: 'Workflows' as const,
    build: 'Build',
    placeholder: 'Example: when a customer asks for a refund, check policy, summarize risk, and ask for approval.',
    proposalTitle: 'Deterministic local proposal',
    configuredDefaults: 'Inputs (7)',
    timeZoneDescription: 'IANA timezone used for the on-call window.',
    workflowName: 'PagerDuty governed on-call handling',
    nameLabel: 'Name',
    validate: 'Validate',
    validationSuccess: 'Flow is ready to run',
    compileBrief: 'Compile intent brief',
    buildProposal: 'Build proposal',
    clarificationTitle: 'Add the missing details to the business intent, then compile it again',
    save: 'Save',
    savedVersion: 'Saved version 1',
    webhookCredentialLabel: 'Webhook signing credential',
    callbackLabel: 'PagerDuty callback URL',
    signatureCopy: /verifies the signature before persisting anything/i,
    incompletePrompt: 'I am on call 24x7 for one week. When PagerDuty alerts in certain ranges, move it to reviewing for 12 hours.',
    prompt: (apiCredential: string, webhookCredential: string) => (
      `Starting now for one week, when PagerDuty alerts user PLOCALUSER outside working hours 09:00 to 17:00 in America/Bogota, acknowledge it and snooze it for 12 hours. Use API credential ${apiCredential} and webhook credential ${webhookCredential} for operator@example.com.`
    ),
  },
  {
    locale: 'es' as const,
    workflows: 'Flujos' as const,
    build: 'Crear',
    placeholder: 'Ejemplo: cuando un cliente pide un reembolso, revisa la política, resume el riesgo y pide aprobación.',
    proposalTitle: 'Propuesta local determinista',
    configuredDefaults: 'Entradas (7)',
    timeZoneDescription: 'Zona horaria IANA usada para la ventana de guardia.',
    workflowName: 'Gestión gobernada de guardia en PagerDuty',
    nameLabel: 'Nombre',
    validate: 'Validar',
    validationSuccess: 'El flujo está listo para correr',
    compileBrief: 'Compilar brief de intención',
    buildProposal: 'Construir propuesta',
    clarificationTitle: 'Agrega los detalles faltantes a la intención y vuelve a compilarla',
    save: 'Guardar',
    savedVersion: 'Versión 1 guardada',
    webhookCredentialLabel: 'Credencial para firmar el webhook',
    callbackLabel: 'URL de retorno de PagerDuty',
    signatureCopy: /verifica la firma antes de persistir datos/i,
    incompletePrompt: 'Yo, como usuario, tengo disponibilidad laboral 24x7 por una semana y uso PagerDuty para resolver casos; quiero que las alertas que salten en ciertos rangos de horas pasen automáticamente a revisando por 12 horas.',
    prompt: (apiCredential: string, webhookCredential: string) => (
      `Desde ahora y durante una semana, cuando PagerDuty asigne un incidente al usuario PLOCALUSER fuera de 09:00–17:00 en America/Bogota, muévelo a revisando y aplázalo por 12 horas como operator@example.com. Usa credencial de API ${apiCredential} y credencial del webhook ${webhookCredential}.`
    ),
  },
] as const

function guardBrowserErrors(page: Page) {
  const errors: string[] = []
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => {
    if (response.status() >= 400) errors.push(`${response.status()} ${new URL(response.url()).pathname}`)
  })
  return errors
}

for (const scenario of scenarios) {
  test(`a ${scenario.locale} prompt creates the deterministic PagerDuty flow in the normal editor`, async ({ page, request }) => {
    test.skip(!enabled, 'requires the persistent local Docker stack')
    const browserErrors = guardBrowserErrors(page)
    const stamp = `${scenario.locale}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const apiCredential = `pagerduty-api-${stamp}`
    const webhookCredential = `pagerduty-webhook-${stamp}`
    await seedCredential(request, {
      name: apiCredential,
      kind: 'pagerduty_api_token',
      secretRef: 'JANUSLY_CRED_E2E_PAGERDUTY_API_TOKEN',
    }, 'default')
    await seedCredential(request, {
      name: webhookCredential,
      kind: 'pagerduty_webhook_secret',
      secretRef: 'JANUSLY_CRED_E2E_PAGERDUTY_WEBHOOK_SECRET',
    }, 'default')
    await page.addInitScript((locale) => {
      window.localStorage.setItem('janusly:activeOrg', 'default')
      window.localStorage.setItem('janusly:locale', locale)
    }, scenario.locale)

    await page.goto('/')
    await openWorkflowAiAction(page, scenario.workflows)
    const intentInput = page.getByPlaceholder(scenario.placeholder)
    await intentInput.fill(scenario.incompletePrompt)
    await page.getByRole('button', { name: scenario.compileBrief, exact: true }).click()
    const incompleteBrief = page.getByTestId('intent-brief')
    await expect(incompleteBrief.getByText(scenario.clarificationTitle, { exact: true })).toBeVisible()
    await expect(incompleteBrief.locator('.ai-brief-questions li')).toHaveCount(3)
    await expect(page.getByRole('button', { name: scenario.buildProposal, exact: true })).toBeDisabled()
    if (evidenceDir) {
      await mkdir(evidenceDir, { recursive: true })
      await incompleteBrief.screenshot({
        path: `${evidenceDir}/pagerduty-prompt-${scenario.locale}-clarification.png`,
      })
    }

    await intentInput.fill(
      scenario.prompt(apiCredential, webhookCredential),
    )
    const proposal = await buildWorkflowProposal(page, scenario.locale)
    await expect(
      proposal.getByRole('status').filter({ hasText: scenario.proposalTitle }),
    ).toBeVisible()
    await proposal.getByText(scenario.configuredDefaults, { exact: true }).click()
    await expect(proposal.getByText('America/Bogota', { exact: true })).toBeVisible()
    await expect(proposal.getByText('outside', { exact: true })).toBeVisible()
    await expect(proposal.getByText('09:00', { exact: true })).toBeVisible()
    await expect(proposal.getByText('17:00', { exact: true })).toBeVisible()
    await expect(proposal.getByText('43200', { exact: true })).toBeVisible()
    await expect(proposal.getByText(scenario.timeZoneDescription, { exact: true })).toBeVisible()
    const activeFrom = await proposal.locator('dt', { hasText: /^activeFrom$/u })
      .locator('..').locator('dd').textContent()
    const activeUntil = await proposal.locator('dt', { hasText: /^activeUntil$/u })
      .locator('..').locator('dd').textContent()
    expect(activeFrom).not.toBeNull()
    expect(activeUntil).not.toBeNull()
    expect(new Date(activeUntil!).getTime() - new Date(activeFrom!).getTime()).toBe(7 * 24 * 60 * 60 * 1_000)
    await applyBuiltWorkflowProposal(page, scenario.locale)

    await openWorkspaceSection(page, scenario.workflows, scenario.build)
    await expect(page.getByRole('textbox', { name: scenario.nameLabel, exact: true })).toHaveValue(scenario.workflowName)
    const canvas = page.locator('.canvas-frame')
    await expect(canvas.locator('.react-flow__node')).toHaveCount(11)
    await expect(canvas.locator('.react-flow__node[data-id="on_pagerduty"]')).toBeVisible()
    await expect(canvas.locator('.react-flow__node[data-id="action_clock"]')).toBeVisible()
    await expect(canvas.locator('.react-flow__node[data-id="evaluate_policy"]')).toBeVisible()
    await expect(canvas.locator('.react-flow__node[data-id="acknowledge_incident"]')).toBeVisible()
    await expect(canvas.locator('.react-flow__node[data-id="snooze_incident"]')).toBeVisible()
    await expect(canvas.locator('.react-flow__node[data-id="verify_incident"]')).toBeVisible()
    await expect(canvas.locator('.react-flow__node[data-id="verify_outcome"]')).toBeVisible()
    await expect(canvas.locator('.react-flow__node[data-id="outcome_projection"]')).toBeVisible()
    await expect(canvas.locator('.react-flow__node[data-id="summarize_action"]')).toHaveCount(0)
    await page.getByRole('button', { name: scenario.validate, exact: true }).click()
    await expect(page.getByText(scenario.validationSuccess, { exact: true })).toBeVisible()

    if (evidenceDir) {
      await mkdir(evidenceDir, { recursive: true })
      await page.screenshot({
        path: `${evidenceDir}/pagerduty-prompt-${scenario.locale}-generated-flow.png`,
        fullPage: true,
      })
    }

    await canvas.locator('.react-flow__node[data-id="on_pagerduty"] .workflow-node').click()
    await expect(page.locator('.we-readiness-badge--pass, .we-readiness-badge--warn')).toBeVisible()
    await expect(page.locator('.we-readiness-badge--fail')).toHaveCount(0)
    await expect(page.locator('.we-readiness-badge--loading')).toHaveCount(0)
    await expect(page.locator('button[aria-busy="true"]')).toHaveCount(0)
    await expect(page.getByLabel(scenario.webhookCredentialLabel)).toHaveValue(webhookCredential)
    const callbackUrl = page.getByLabel(scenario.callbackLabel)
    await expect(callbackUrl).toHaveValue(
      /\/webhooks\/pagerduty\/pagerduty_off_hours_[a-f0-9]{32}\/on_pagerduty$/u,
    )
    await expect(page.getByText(scenario.signatureCopy)).toBeVisible()

    if (evidenceDir) {
      await callbackUrl.scrollIntoViewIfNeeded()
      await page.screenshot({
        path: `${evidenceDir}/pagerduty-prompt-${scenario.locale}-trigger-config.png`,
        fullPage: true,
      })
    }

    const saveResponse = page.waitForResponse(response => (
      response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/workflows/save'
    ))
    await page.locator(`button.sb-workflow__ghost[aria-label="${scenario.save}"]`).click()
    const saved = await saveResponse
    const savedEnvelope = await saved.json() as { workflowId?: unknown; version?: unknown }
    expect(saved.ok(), JSON.stringify(savedEnvelope)).toBe(true)
    expect(typeof savedEnvelope.workflowId).toBe('string')
    expect(savedEnvelope.version).toBe(1)
    const workflowId = savedEnvelope.workflowId as string
    await expect(page.getByText(scenario.savedVersion, { exact: true })).toBeVisible()

    // Apply only dirties the canvas. Prove the flagship survives its separate
    // validity-gated save boundary and can be reopened from durable storage,
    // rather than treating an in-memory preview as a completed authoring flow.
    await page.reload()
    await page.getByRole('button', { name: scenario.workflows, exact: true }).click()
    const persistedRow = page.getByTestId(`workflows-row-${workflowId}`)
    await expect(persistedRow).toContainText(scenario.workflowName)
    await persistedRow.click()
    await openWorkspaceSection(page, scenario.workflows, scenario.build)
    await expect(page.getByRole('textbox', { name: scenario.nameLabel, exact: true })).toHaveValue(scenario.workflowName)
    await expect(canvas.locator('.react-flow__node')).toHaveCount(11)
    await canvas.locator('.react-flow__node[data-id="on_pagerduty"] .workflow-node').click()
    await expect(page.getByLabel(scenario.webhookCredentialLabel)).toHaveValue(webhookCredential)
    await expect(page.getByLabel(scenario.callbackLabel)).toHaveValue(
      new RegExp(`/webhooks/pagerduty/${workflowId}/on_pagerduty$`, 'u'),
    )
    expect(browserErrors).toEqual([])
  })
}
