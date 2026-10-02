import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api, contractApi } from '../api'
import { changeAppLanguage } from '../i18n'
import { useWorkflowStore } from '../store'
import { VersionHistoryPanel } from '../components/VersionHistoryPanel'
import type { SessionContext } from '../identity-context'
import type { AuthoringExperienceRecord } from '../lib/api-types.generated'
import type { WorkflowBriefCompilation } from '../types'
import { deferred } from './deferred'

const initial = useWorkflowStore.getState()
const grants = ['workflows.read', 'workflows.write', 'ai.write']
function identity(permissions = grants): SessionContext {
  return {
    identity: { userId: 'operator', email: null, mode: 'dev-headers', source: 'dev' }, profile: { name: null, email: null },
    organizations: [{ id: 'tenant', name: 'Tenant', plan: null, role: 'editor', roleBase: 'editor', permissions,
      usable: true, developmentFallback: false, isOwner: false }], invitations: [], currentOrganizationId: 'tenant',
    selectionRequired: false, needsOrganization: false, truncated: false, invitationsTruncated: false,
  }
}
const versions = [7, 3].map(version => ({ id: `version-${version}`, version, workflowId: 'saved-source', createdAt: null,
  dagJson: { dslVersion: '1.0', id: 'saved-source', name: 'Saved local example', nodes: [{ id: 'done', type: 'noop', config: {} }], edges: [] } }))
const compiled: WorkflowBriefCompilation = { mode: 'deterministic', complete: true, clarifyingQuestions: [],
  brief: { version: '1', objective: 'Local intent', trigger: 'manual', inputs: [], expectedOutcome: 'Local result',
    externalEffects: [], approvals: [], failurePolicy: 'stop', examples: [], language: 'en' } }
const entry: AuthoringExperienceRecord = { id: 'registered-3', workflowId: 'saved-source', versionId: 'version-3', version: 3,
  registeredAt: '2026-10-02T12:00:00Z', retainUntil: '2027-03-31T12:00:00Z', policyVersion: 'authoring-experience-v1', outcomeEvidence: 'unknown' }
const copy = {
  en: { intent: 'Example intent', version: 'Saved source version', compile: 'Compile example intent', register: 'Register example', withdraw: 'Withdraw example v3', unknown: 'Outcome evidence is unknown. Registration grants no approval and does not save or run a workflow.', failed: 'The example is unavailable. Check consent and the saved source, then try again.' },
  es: { intent: 'Intención del ejemplo', version: 'Versión guardada de origen', compile: 'Compilar intención del ejemplo', register: 'Registrar ejemplo', withdraw: 'Retirar ejemplo v3', unknown: 'La evidencia del resultado es desconocida. Registrar no otorga aprobación ni guarda o ejecuta un workflow.', failed: 'El ejemplo no está disponible. Revisa el consentimiento y el origen guardado e inténtalo de nuevo.' },
} as const
const consent = [
  { key: 'ai.authoringExperienceEnabled', value: true },
  { key: 'memory.enabled', value: true },
  { key: 'memory.allowedKinds', value: 'workflow_vector' },
]
function setup(extra?: (operation: string, request: unknown) => Promise<unknown> | undefined) {
  let registered = false
  vi.mocked(api).mockResolvedValue({ config: consent })
  vi.mocked(contractApi).mockImplementation(async (operation, _path, request) => {
    const overridden = extra?.(operation, request)
    if (overridden) return await overridden as never
    if (operation === 'GET /workflows/versions') return versions as never
    if (operation === 'GET /authoring/experiences') return { entries: registered ? [entry] : [], truncated: false } as never
    if (operation === 'POST /ai/workflow-briefs/compile') return compiled as never
    if (operation === 'POST /authoring/experiences/register') { registered = true; return entry as never }
    if (operation === 'POST /authoring/experiences/revoke') { registered = false; return { id: entry.id, revoked: true } as never }
    throw new Error('Unexpected operation: ' + operation)
  })
}
async function compileExample(locale: keyof typeof copy) {
  fireEvent.change(await screen.findByLabelText(copy[locale].version), { target: { value: 'version-3' } })
  fireEvent.change(screen.getByLabelText(copy[locale].intent), { target: { value: 'Explicit local example intent' } })
  fireEvent.click(screen.getByRole('button', { name: copy[locale].compile }))
  await waitFor(() => expect(screen.getByRole('button', { name: copy[locale].register })).toBeEnabled())
}
export function registerExperienceRegistryCases() {
  describe('explicit saved-version example registry', () => {
    beforeEach(() => {
      vi.mocked(contractApi).mockReset()
      vi.mocked(api).mockReset()
      useWorkflowStore.setState({ ...initial, orgId: 'tenant', userId: 'operator', identityContext: identity(),
        currentWorkflowId: 'saved-source', currentWorkflowSaved: true, activeTab: 'inspector', toasts: [] }, true)
    })
    for (const locale of ['en', 'es'] as const) {
      for (const denied of ['ai.authoringExperienceEnabled', 'memory.enabled', 'memory.allowedKinds', 'missing', 'malformed'] as const) {
        it(`${locale} tenant admission ${denied} never probes the protected registry`, async () => {
          await changeAppLanguage(locale)
          setup()
          const config = denied === 'missing' ? [] : consent.map(row => row.key === denied
            ? { ...row, value: row.key === 'memory.allowedKinds' ? 'run_summary' : false } : row)
          vi.mocked(api).mockResolvedValue(denied === 'malformed' ? { config: [{ key: 'ai.authoringExperienceEnabled', value: 'true' }] } : { config })
          render(<VersionHistoryPanel />)
          await waitFor(() => expect(api).toHaveBeenCalledWith('/org/config', expect.objectContaining({ signal: expect.any(AbortSignal) })))
          await act(async () => {})
          expect(vi.mocked(contractApi).mock.calls.some(([operation]) => operation === 'GET /authoring/experiences')).toBe(false)
          expect(screen.queryByRole('button', { name: copy[locale].register })).not.toBeInTheDocument()
          expect(useWorkflowStore.getState().toasts).toHaveLength(0)
        })
      }
      for (const outcome of ['resolve', 'reject'] as const) {
        it(`${locale} tenant admission discards late ${outcome} after identity ABA`, async () => {
          await changeAppLanguage(locale)
          setup()
          const pending = deferred<unknown>()
          vi.mocked(api).mockResolvedValue({ config: [] }).mockReturnValueOnce(pending.promise)
          render(<VersionHistoryPanel />)
          await waitFor(() => expect(api).toHaveBeenCalled())
          act(() => { useWorkflowStore.setState({ userId: 'other' }); useWorkflowStore.setState({ userId: 'operator' }) })
          await act(async () => { if (outcome === 'resolve') pending.resolve({ config: consent }); else pending.reject(new Error('STALE_CONSENT_ERROR')) })
          expect(vi.mocked(contractApi).mock.calls.some(([operation]) => operation === 'GET /authoring/experiences')).toBe(false)
          expect(screen.queryByRole('button', { name: copy[locale].register })).not.toBeInTheDocument()
          expect(screen.queryByText('STALE_CONSENT_ERROR')).not.toBeInTheDocument()
          expect(useWorkflowStore.getState().toasts).toHaveLength(0)
        })
      }
      it(`${locale} registers only the reviewed exact saved version and explicitly withdraws it`, async () => {
        await changeAppLanguage(locale)
        setup()
        render(<VersionHistoryPanel />)
        expect(await screen.findByRole('button', { name: copy[locale].register })).toBeDisabled()
        expect(screen.getByText(copy[locale].unknown)).toBeInTheDocument()
        expect(contractApi).not.toHaveBeenCalledWith('POST /authoring/experiences/register', expect.anything(), expect.anything(), expect.anything())
        await compileExample(locale)
        fireEvent.click(screen.getByRole('button', { name: copy[locale].register }))
        await screen.findByRole('button', { name: copy[locale].withdraw })
        expect(contractApi).toHaveBeenCalledWith('POST /authoring/experiences/register', '/v1/authoring/experiences/register',
          { workflowId: 'saved-source', versionId: 'version-3', brief: compiled.brief }, expect.anything())
        fireEvent.click(screen.getByRole('button', { name: copy[locale].withdraw }))
        await waitFor(() => expect(screen.queryByRole('button', { name: copy[locale].withdraw })).not.toBeInTheDocument())
        expect(contractApi).toHaveBeenCalledWith('POST /authoring/experiences/revoke', '/v1/authoring/experiences/revoke', { id: entry.id }, expect.anything())
        expect(vi.mocked(contractApi).mock.calls.filter(([operation]) => operation.startsWith('POST')).map(([operation]) => operation)).toEqual([
          'POST /ai/workflow-briefs/compile', 'POST /authoring/experiences/register', 'POST /authoring/experiences/revoke',
        ])
        expect(useWorkflowStore.getState()).toMatchObject({ currentWorkflowId: 'saved-source', workflowDirty: false })
      })
      it(`${locale} keeps registration hidden when process or tenant consent is disabled`, async () => {
        await changeAppLanguage(locale)
        setup(operation => operation === 'GET /authoring/experiences' ? Promise.reject(new ApiError('disabled', { statusCode: 403 })) : undefined)
        render(<VersionHistoryPanel />)
        await screen.findByRole('button', { name: /v7/ })
        await act(async () => {})
        expect(screen.queryByRole('button', { name: copy[locale].register })).not.toBeInTheDocument()
        expect(useWorkflowStore.getState().toasts).toHaveLength(0)
      })
      for (const grant of grants) {
        it(`${locale} hides registration without ${grant}`, async () => {
          await changeAppLanguage(locale)
          useWorkflowStore.setState({ identityContext: identity(grants.filter(value => value !== grant)) })
          setup()
          render(<VersionHistoryPanel />)
          await screen.findByRole('button', { name: /v7/ })
          expect(screen.queryByRole('button', { name: copy[locale].register })).not.toBeInTheDocument()
          expect(vi.mocked(contractApi).mock.calls.some(([operation]) => operation === 'GET /authoring/experiences')).toBe(false)
        })
      }
      for (const outcome of ['resolve', 'reject'] as const) {
        it(`${locale} intent editing discards late compilation ${outcome}`, async () => {
          await changeAppLanguage(locale)
          const pending = deferred<WorkflowBriefCompilation>()
          setup(operation => operation === 'POST /ai/workflow-briefs/compile' ? pending.promise : undefined)
          render(<VersionHistoryPanel />)
          const input = await screen.findByLabelText(copy[locale].intent)
          fireEvent.change(input, { target: { value: 'Previous intent' } })
          fireEvent.click(screen.getByRole('button', { name: copy[locale].compile }))
          await waitFor(() => expect(contractApi).toHaveBeenCalledWith('POST /ai/workflow-briefs/compile', expect.anything(), expect.anything(), expect.anything()))
          fireEvent.change(input, { target: { value: 'Current intent' } })
          await act(async () => { if (outcome === 'resolve') pending.resolve(compiled); else pending.reject(new Error('STALE_EXAMPLE_ERROR')) })
          expect(screen.getByRole('button', { name: copy[locale].register })).toBeDisabled()
          expect(screen.queryByText('Local result')).not.toBeInTheDocument()
          expect(screen.queryByText('STALE_EXAMPLE_ERROR')).not.toBeInTheDocument()
          expect(input).toHaveValue('Current intent')
          expect(screen.getByRole('button', { name: copy[locale].compile })).toBeEnabled()
        })
        it(`${locale} discards a late registration ${outcome} across an identity ABA`, async () => {
          await changeAppLanguage(locale)
          const pending = deferred<AuthoringExperienceRecord>()
          setup(operation => operation === 'POST /authoring/experiences/register' ? pending.promise : undefined)
          render(<VersionHistoryPanel />)
          await compileExample(locale)
          fireEvent.click(screen.getByRole('button', { name: copy[locale].register }))
          await waitFor(() => expect(contractApi).toHaveBeenCalledWith('POST /authoring/experiences/register', expect.anything(), expect.anything(), expect.anything()))
          act(() => { useWorkflowStore.setState({ userId: 'other' }); useWorkflowStore.setState({ userId: 'operator' }) })
          await act(async () => { if (outcome === 'resolve') pending.resolve(entry); else pending.reject(new Error('STALE_REGISTER_ERROR')) })
          expect(screen.queryByRole('button', { name: copy[locale].withdraw })).not.toBeInTheDocument()
          expect(screen.queryByText('STALE_REGISTER_ERROR')).not.toBeInTheDocument()
          expect(useWorkflowStore.getState().toasts).toHaveLength(0)
        })
      }
      it(`${locale} a deleted or withdrawn source cannot produce a successful registration`, async () => {
        await changeAppLanguage(locale)
        setup(operation => operation === 'POST /authoring/experiences/register' ? Promise.reject(new ApiError('source unavailable', { statusCode: 404 })) : undefined)
        render(<VersionHistoryPanel />)
        await compileExample(locale)
        fireEvent.click(screen.getByRole('button', { name: copy[locale].register }))
        await screen.findByText(copy[locale].failed)
        expect(screen.queryByRole('button', { name: copy[locale].withdraw })).not.toBeInTheDocument()
        expect(useWorkflowStore.getState()).toMatchObject({ currentWorkflowId: 'saved-source', workflowDirty: false })
      })
    }
  })
}
