import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { openWorkflowAiAction, openWorkflowOperation, openWorkspaceSection } from './_helpers/workspace-navigation'

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3001'
const profile = process.env.JANUSLY_EXPERIENCE_E2E_PROFILE ?? 'disabled'
if (!['review', 'shadow', 'off', 'disabled'].includes(profile)) throw new Error('Unknown authoring experience E2E profile')

const copies = {
  en: { flows: 'Workflows', buildSection: 'Build', versions: 'Versions', intent: 'Example intent', version: 'Saved source version',
    compileExample: 'Compile example intent', register: 'Register example', withdraw: 'Withdraw example v1',
    prompt: 'Business intent', compile: 'Compile intent brief', build: 'Build proposal', apply: 'Apply proposal to draft',
    name: 'Optional copied workflow name', applied: 'Proposal copied to the draft', view: 'View changes in canvas',
    reuse: 'Reuse saved version', adapt: 'Adapt saved version name',
    intentText: 'Manually prepare a local report without modifying external systems; stop on failure.' },
  es: { flows: 'Flujos', buildSection: 'Crear', versions: 'Versiones', intent: 'Intención del ejemplo', version: 'Versión guardada de origen',
    compileExample: 'Compilar intención del ejemplo', register: 'Registrar ejemplo', withdraw: 'Retirar ejemplo v1',
    prompt: 'Intención de negocio', compile: 'Compilar brief de intención', build: 'Construir propuesta', apply: 'Aplicar propuesta al borrador',
    name: 'Nombre opcional del workflow copiado', applied: 'Propuesta copiada al borrador', view: 'Ver cambios en el canvas',
    reuse: 'Reutilizar versión guardada', adapt: 'Adaptar nombre de versión guardada',
    intentText: 'Manualmente prepara un informe local sin modificar sistemas externos; detente si falla.' },
} as const
function headers(org: string) { return { 'x-org-id': org, 'x-user-id': 'dev-user', 'Content-Type': 'application/json' } }
async function read(request: APIRequestContext, org: string, path: string) {
  const response = await request.get(API_URL + path, { headers: headers(org) })
  expect(response.ok(), `${path}: ${response.status()}`).toBe(true)
  const envelope = await response.json()
  return envelope.data ?? envelope
}
async function write(request: APIRequestContext, org: string, path: string, body: unknown) {
  const response = await request.post(API_URL + path, { headers: headers(org), data: body })
  expect(response.ok(), `${path}: ${response.status()} ${await response.text()}`).toBe(true)
  const envelope = await response.json()
  return envelope.data ?? envelope
}
async function seed(request: APIRequestContext, org: string, id: string, name: string) {
  expect((await read(request, org, '/ai/health')).enabled).toBe(false)
  const older = await write(request, org, '/v1/workflows/save', { dslVersion: '1.0', id, name,
    nodes: [{ id: 'original', label: 'Original immutable step', type: 'noop', config: {} }], edges: [],
    ui: { positions: { original: { x: 40, y: 40 } } } })
  await write(request, org, '/v1/workflows/save', { dslVersion: '1.0', id, name,
    nodes: [{ id: 'latest', label: 'Replacement latest step', type: 'noop', config: {} },
      { id: 'second', label: 'Second latest step', type: 'noop', config: {} }], edges: [{ from: 'latest', to: 'second' }] })
  for (const [key, value] of [['memory.enabled', true], ['memory.allowedKinds', 'workflow_vector'], ['ai.authoringExperienceEnabled', true]] as const) {
    await write(request, org, '/org/config', { key, value })
  }
  return { older, source: await read(request, org, `/v1/workflows/versions/${older.versionId}?workflowId=${encodeURIComponent(id)}`) }
}
function monitor(page: Page) {
  const errors: { text: string; url: string }[] = [], pageErrors: string[] = [], mutations: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push({ text: message.text(), url: message.location().url }) })
  page.on('request', request => {
    if (request.method() === 'POST') mutations.push(new URL(request.url()).pathname.replace(/^\/v1(?=\/)/, ''))
  })
  return { errors, pageErrors, mutations }
}
async function open(page: Page, org: string, locale: keyof typeof copies, id: string) {
  const copy = copies[locale]
  await page.addInitScript(({ org, locale }) => {
    localStorage.setItem('janusly:activeOrg', org)
    localStorage.setItem('janusly:locale', locale)
  }, { org, locale })
  await page.goto('/')
  await page.getByRole('button', { name: copy.flows, exact: true }).click()
  await page.getByTestId(`workflows-row-${id}`).click()
  await openWorkspaceSection(page, copy.flows, copy.buildSection)
  await openWorkflowOperation(page, copy.versions)
  await expect(page.locator('.version-row')).toHaveCount(2)
}
async function propose(page: Page, locale: keyof typeof copies) {
  const copy = copies[locale]
  await openWorkflowAiAction(page, copy.flows)
  await page.getByLabel(copy.prompt, { exact: true }).fill(copy.intentText)
  await page.getByRole('button', { name: copy.compile, exact: true }).click()
  await expect(page.getByTestId('intent-brief')).toBeVisible()
  const response = page.waitForResponse(response => /\/(?:v1\/)?ai\/workflow-proposals$/.test(new URL(response.url()).pathname)
    && response.request().method() === 'POST')
  await page.getByRole('button', { name: copy.build, exact: true }).click()
  const wire = await (await response).json()
  await expect(page.getByTestId('workflow-proposal')).toBeVisible()
  return wire.data ?? wire
}
async function registerExample(page: Page, request: APIRequestContext, org: string, locale: keyof typeof copies, workflowId: string, versionId: string) {
  const copy = copies[locale]
  await page.getByLabel(copy.version, { exact: true }).selectOption(versionId)
  await page.getByLabel(copy.intent, { exact: true }).fill(copy.intentText)
  await expect(page.getByRole('button', { name: copy.register, exact: true })).toBeDisabled()
  await page.getByRole('button', { name: copy.compileExample, exact: true }).click()
  await expect(page.getByTestId('registered-example-brief')).toBeVisible()
  const registering = page.waitForRequest(request => new URL(request.url()).pathname === '/v1/authoring/experiences/register')
  await page.getByRole('button', { name: copy.register, exact: true }).click()
  const submitted = (await registering).postDataJSON()
  expect(Object.keys(submitted).sort()).toEqual(['brief', 'versionId', 'workflowId'])
  expect(submitted.workflowId).toBe(workflowId)
  expect(submitted.versionId).toBe(versionId)
  await expect(page.getByRole('button', { name: copy.withdraw, exact: true })).toBeVisible()
  const registered = await read(request, org, `/v1/authoring/experiences?workflowId=${workflowId}`)
  expect(registered.entries).toHaveLength(1)
  expect(registered.entries[0]).toMatchObject({ workflowId, versionId: versionId, version: 1, outcomeEvidence: 'unknown' })
  return registered.entries[0]
}
function graphWithoutIdentity(value: Record<string, unknown>) {
  const { id: _id, name: _name, ...graph } = value
  return graph
}
for (const locale of ['en', 'es'] as const) {
  const copy = copies[locale]
  test(`${profile} ${locale} registers an exact older source and keeps authoring explicitly unsaved`, async ({ page, request }, testInfo) => {
    const stamp = Date.now()
    const org = `experience-${profile}-${locale}-${stamp}`
    const workflowId = `source-${locale}-${stamp}`
    const name = `Saved source ${locale} ${stamp}`
    const { older, source } = await seed(request, org, workflowId, name)
    const observed = monitor(page)
    await open(page, org, locale, workflowId)
    if (profile !== 'disabled') {
      await registerExample(page, request, org, locale, workflowId, older.versionId)
      const unconsented = await request.get(`${API_URL}/v1/authoring/experiences?workflowId=${workflowId}`, { headers: headers(`peer-${org}`) })
      expect(unconsented.status()).toBe(403)
      // Consenting a different tenant does not expose this workflow's registration or saved version.
      for (const [key, value] of [['memory.enabled', true], ['memory.allowedKinds', 'workflow_vector'], ['ai.authoringExperienceEnabled', true]] as const) {
        await write(request, `peer-${org}`, '/org/config', { key, value })
      }
      expect((await read(request, `peer-${org}`, `/v1/authoring/experiences?workflowId=${workflowId}`)).entries).toEqual([])
      const foreignSource = await request.get(`${API_URL}/v1/workflows/versions/${older.versionId}?workflowId=${workflowId}`, { headers: headers(`peer-${org}`) })
      expect(foreignSource.status()).toBe(404)
    } else {
      await expect(page.getByRole('button', { name: copy.register, exact: true })).toHaveCount(0)
    }
    const initial = await propose(page, locale)
    if (profile === 'review') {
      expect(initial.experienceDecision).toMatchObject({ mode: 'REUSE', source: { workflowId, versionId: older.versionId, version: 1 } })
      expect(graphWithoutIdentity(initial.proposal.workflow)).toEqual(graphWithoutIdentity(source.dagJson))
      const receipt = page.getByTestId('experience-review')
      await expect(receipt).toContainText(copy.reuse)
      await expect(receipt).toContainText(`v1 · ${older.versionId}`)
      expect(observed.mutations).not.toContain('/workflows/save')
      await page.getByLabel(copy.name, { exact: true }).fill(`Reviewed copy ${locale}`)
      await expect(page.getByTestId('workflow-proposal')).toHaveCount(0)
      await expect(page.getByRole('button', { name: copy.apply, exact: true })).toBeDisabled()
      const previewResponse = page.waitForResponse(response => /\/ai\/workflow-proposals$/.test(new URL(response.url()).pathname))
      await page.getByRole('button', { name: copy.build, exact: true }).click()
      const previewEnvelope = await (await previewResponse).json()
      const preview = previewEnvelope.data ?? previewEnvelope
      expect(preview.experienceDecision).toMatchObject({ mode: 'ADAPT', edits: [{ field: 'workflow_name', value: `Reviewed copy ${locale}` }] })
      expect(graphWithoutIdentity(preview.proposal.workflow)).toEqual(graphWithoutIdentity(source.dagJson))
      await expect(receipt).toContainText(copy.adapt)
      await expect(receipt).toContainText(`Reviewed copy ${locale}`)
      const reviewImage = testInfo.outputPath('review.png')
      await page.screenshot({ path: reviewImage, fullPage: true })
      await testInfo.attach('review', { path: reviewImage, contentType: 'image/png' })
      const revalidating = page.waitForRequest(request => /\/ai\/workflow-proposals$/.test(new URL(request.url()).pathname))
      await page.getByRole('button', { name: copy.apply, exact: true }).click()
      const revalidatedBody = (await revalidating).postDataJSON()
      expect(revalidatedBody.experienceReceipt).toEqual(preview.experienceDecision)
      expect(revalidatedBody).not.toHaveProperty('prompt')
      await expect(page.getByText(copy.applied, { exact: true })).toBeVisible()
      await page.getByRole('button', { name: copy.view, exact: true }).click()
      const canvas = page.getByTestId('workflow-canvas')
      await expect(canvas).toContainText('Original immutable step')
      await expect(canvas).not.toContainText('Replacement latest step')
      const missing = await request.get(`${API_URL}/v1/workflows/latest?workflowId=${preview.proposal.workflow.id}`, { headers: headers(org) })
      expect(missing.status()).toBe(404)
    } else {
      expect(initial).not.toHaveProperty('experienceDecision')
      await expect(page.getByTestId('experience-review')).toHaveCount(0)
      await expect(page.getByLabel(copy.name, { exact: true })).toHaveCount(0)
    }
    expect(observed.mutations.filter(path => path === '/workflows/save' || path === '/start')).toEqual([])
    expect(await read(request, org, `/v1/workflows/versions?workflowId=${workflowId}`)).toHaveLength(2)
    expect((await read(request, org, `/v1/workflows/versions/${older.versionId}?workflowId=${workflowId}`)).dagJson).toEqual(source.dagJson)
    expect(observed.pageErrors).toEqual([])
    expect(observed.errors).toEqual(profile === 'disabled' ? [{
      text: 'Failed to load resource: the server responded with a status of 403 (Forbidden)',
      url: `${API_URL}/v1/authoring/experiences?workflowId=${workflowId}`,
    }] : [])
  })
}

if (profile === 'review') {
  for (const locale of ['en', 'es'] as const) {
    const copy = copies[locale]
    test(`${locale} explicitly withdraws an example without deleting its saved source`, async ({ page, request }) => {
      const stamp = Date.now()
      const org = `withdraw-${locale}-${stamp}`, workflowId = `withdraw-source-${locale}-${stamp}`
      const { older, source } = await seed(request, org, workflowId, `Withdrawal source ${locale}`)
      const observed = monitor(page)
      await open(page, org, locale, workflowId)
      const entry = await registerExample(page, request, org, locale, workflowId, older.versionId)
      const response = page.waitForResponse(response => new URL(response.url()).pathname === '/v1/authoring/experiences/revoke')
      await page.getByRole('button', { name: copy.withdraw, exact: true }).click()
      const withdrawal = await (await response).json()
      expect(withdrawal.data).toEqual({ id: entry.id, revoked: true })
      await expect(page.getByRole('button', { name: copy.withdraw, exact: true })).toHaveCount(0)
      expect((await read(request, org, `/v1/authoring/experiences?workflowId=${workflowId}`)).entries).toEqual([])
      const proposal = await propose(page, locale)
      expect(proposal.experienceDecision).toMatchObject({ mode: 'GENERATE' })
      expect(proposal.experienceDecision).not.toHaveProperty('source')
      await expect(page.getByTestId('experience-review')).not.toContainText(older.versionId)
      expect(observed.mutations.filter(path => path === '/workflows/save' || path === '/start')).toEqual([])
      expect((await read(request, org, `/v1/workflows/versions/${older.versionId}?workflowId=${workflowId}`)).dagJson).toEqual(source.dagJson)
      expect(observed.pageErrors).toEqual([])
      expect(observed.errors).toEqual([])
    })
    for (const boundary of ['withdrawal', 'source deletion', 'ai.authoringExperienceEnabled', 'memory.enabled'] as const) {
      test(`${locale} fresh Apply rejects remote ${boundary} without replacing or saving the canvas`, async ({ page, request }) => {
        const stamp = Date.now()
        const org = `revalidate-${locale}-${stamp}`, workflowId = `revalidate-source-${locale}-${stamp}`
        const { older } = await seed(request, org, workflowId, `Revalidation source ${locale}`)
        const observed = monitor(page)
        await open(page, org, locale, workflowId)
        const entry = await registerExample(page, request, org, locale, workflowId, older.versionId)
        const preview = await propose(page, locale)
        expect(preview.experienceDecision.mode).toBe('REUSE')
        if (boundary === 'withdrawal') await write(request, org, '/v1/authoring/experiences/revoke', { id: entry.id })
        else if (boundary === 'source deletion') {
          const deleted = await request.delete(`${API_URL}/workflows/${workflowId}`, { headers: headers(org) })
          expect(deleted.status()).toBe(200)
        } else await write(request, org, '/org/config', { key: boundary, value: false })
        if (boundary === 'source deletion') {
          const postsBeforeApply = observed.mutations.filter(path => path === '/ai/workflow-proposals').length
          const refreshedCatalog = page.waitForResponse(response => /\/authoring\/capabilities$/.test(new URL(response.url()).pathname))
          await page.getByRole('button', { name: copy.apply, exact: true }).click()
          const catalog = await (await refreshedCatalog).json()
          expect(catalog.version).not.toBe(preview.bindings.catalogVersion)
          await expect(page.getByRole('button', { name: copy.apply, exact: true })).toBeDisabled()
          expect(observed.mutations.filter(path => path === '/ai/workflow-proposals')).toHaveLength(postsBeforeApply)
        } else {
          const revalidation = page.waitForResponse(response => /\/ai\/workflow-proposals$/.test(new URL(response.url()).pathname)
            && response.request().method() === 'POST')
          await page.getByRole('button', { name: copy.apply, exact: true }).click()
          const rejected = await revalidation
          expect(rejected.status()).toBe(boundary === 'withdrawal' ? 200 : 403)
          const rejectedEnvelope = await rejected.json()
          if (boundary === 'withdrawal') {
            expect(rejectedEnvelope.proposal.applicable).toBe(false)
            expect(rejectedEnvelope).not.toHaveProperty('experienceDecision')
          } else expect(rejectedEnvelope.code).toBe('authoring_experience_disabled')
          expect(rejected.request().postDataJSON().experienceReceipt).toEqual(preview.experienceDecision)
          await expect(page.getByRole('button', { name: copy.apply, exact: true })).toBeEnabled()
        }
        await expect(page.getByText(copy.applied, { exact: true })).toHaveCount(0)
        const canvas = page.getByTestId('workflow-canvas')
        await expect(canvas).toContainText('Replacement latest step')
        await expect(canvas).not.toContainText('Original immutable step')
        expect(observed.mutations.filter(path => path === '/workflows/save' || path === '/start')).toEqual([])
        const missing = await request.get(`${API_URL}/v1/workflows/latest?workflowId=${preview.proposal.workflow.id}`, { headers: headers(org) })
        expect(missing.status()).toBe(404)
        if (boundary === 'source deletion') {
          const deleted = await request.get(`${API_URL}/v1/workflows/latest?workflowId=${workflowId}`, { headers: headers(org) })
          expect(deleted.status()).toBe(404)
        } else expect(await read(request, org, `/v1/workflows/versions?workflowId=${workflowId}`)).toHaveLength(2)
        expect(observed.pageErrors).toEqual([])
        expect(observed.errors).toEqual(boundary === 'withdrawal' || boundary === 'source deletion' ? [] : [{
          text: 'Failed to load resource: the server responded with a status of 403 (Forbidden)',
          url: `${API_URL}/ai/workflow-proposals`,
        }])
      })
    }
  }
}
