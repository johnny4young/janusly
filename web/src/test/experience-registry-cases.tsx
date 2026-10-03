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
import { invalidateTags, type ResourceTag } from '../lib/query-cache'

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
      const contexts = ['organization', 'user', 'workflow', 'navigation', 'saved', ...grants] as const
      const resources: ResourceTag[] = ['authoring-experiences', 'memory', 'org-config', 'versions', 'workflows', 'credentials', 'mcp']
      for (const boundary of [...contexts, ...resources]) {
        for (const mutation of ['register', 'revoke'] as const) {
          for (const outcome of ['resolve', 'reject'] as const) {
            it(`${locale} pending ${mutation} ${outcome} across ${boundary} cannot release a new compilation`, async () => {
              await changeAppLanguage(locale)
              const previous = deferred<unknown>()
              const next = deferred<WorkflowBriefCompilation>()
              let retired = false
              const write = `POST /authoring/experiences/${mutation}`
              setup(operation => {
                if (operation === write) return previous.promise
                if (operation === 'GET /authoring/experiences') return Promise.resolve({
                  entries: !retired && mutation === 'revoke' ? [entry] : [], truncated: false,
                })
                if (retired && operation === 'POST /ai/workflow-briefs/compile') return next.promise
                return undefined
              })
              render(<VersionHistoryPanel />)
              if (mutation === 'register') await compileExample(locale)
              fireEvent.click(await screen.findByRole('button', { name: copy[locale][mutation === 'register' ? 'register' : 'withdraw'] }))
              await waitFor(() => expect(vi.mocked(contractApi).mock.calls.some(([operation]) => operation === write)).toBe(true))
              const submitted = vi.mocked(contractApi).mock.calls.find(([operation]) => operation === write)!
              expect(submitted[2]).toEqual(mutation === 'register'
                ? { workflowId: 'saved-source', versionId: 'version-3', brief: compiled.brief } : { id: entry.id })
              if (mutation === 'register') expect((submitted[2] as { brief: unknown }).brief).not.toBe(compiled.brief)
              expect(screen.getByLabelText(copy[locale].intent)).toBeDisabled()
              expect(screen.getByLabelText(copy[locale].version)).toBeDisabled()
              const reads = vi.mocked(contractApi).mock.calls.filter(([operation]) => operation === 'GET /authoring/experiences').length
              retired = true
              act(() => {
                const state = useWorkflowStore.getState()
                if (resources.includes(boundary as ResourceTag)) invalidateTags([boundary as ResourceTag])
                else {
                  if (boundary === 'organization') useWorkflowStore.setState({ orgId: 'other' })
                  else if (boundary === 'user') useWorkflowStore.setState({ userId: 'other' })
                  else if (boundary === 'workflow') useWorkflowStore.setState({ currentWorkflowId: 'other' })
                  else if (boundary === 'navigation') useWorkflowStore.setState({ activeTab: 'operations' })
                  else if (boundary === 'saved') useWorkflowStore.setState({ currentWorkflowSaved: false })
                  else useWorkflowStore.setState({ identityContext: identity(grants.filter(grant => grant !== boundary)) })
                  useWorkflowStore.setState({ orgId: state.orgId, userId: state.userId, currentWorkflowId: state.currentWorkflowId,
                    currentWorkflowSaved: state.currentWorkflowSaved, activeTab: state.activeTab, identityContext: state.identityContext })
                }
              })
              await waitFor(() => expect(vi.mocked(contractApi).mock.calls.filter(([operation]) => operation === 'GET /authoring/experiences').length).toBeGreaterThan(reads))
              const input = await screen.findByLabelText(copy[locale].intent)
              expect(input).toBeEnabled()
              fireEvent.change(input, { target: { value: 'New owner intent' } })
              fireEvent.click(screen.getByRole('button', { name: copy[locale].compile }))
              await waitFor(() => expect(screen.getByRole('button', { name: copy[locale].compile })).toBeDisabled())
              await act(async () => {
                if (outcome === 'resolve') previous.resolve(mutation === 'register' ? entry : { id: entry.id, revoked: true })
                else previous.reject(new Error('STALE_MUTATION_ERROR'))
              })
              expect(screen.getByRole('button', { name: copy[locale].compile })).toBeDisabled()
              expect(screen.getByRole('button', { name: copy[locale].register })).toBeDisabled()
              expect(screen.queryByRole('button', { name: copy[locale].withdraw })).not.toBeInTheDocument()
              expect(screen.queryByText(copy[locale].failed)).not.toBeInTheDocument()
              expect(input).toHaveValue('New owner intent')
              await act(async () => next.resolve({ ...compiled, brief: { ...compiled.brief, expectedOutcome: 'New owner compilation' } }))
              await waitFor(() => expect(screen.getByRole('button', { name: copy[locale].register })).toBeEnabled())
              expect(screen.getByText('New owner compilation')).toBeInTheDocument()
              expect(vi.mocked(contractApi).mock.calls.filter(([operation]) => operation === write)).toHaveLength(1)
              expect(useWorkflowStore.getState()).toMatchObject({ currentWorkflowId: 'saved-source', workflowDirty: false, toasts: [] })
            })
          }
        }
      }
      const invalidLists = {
        'six entries': Array.from({ length: 6 }, (_, index) => ({ ...entry, id: `example-${index}` })),
        'duplicate identities': [entry, { ...entry }],
        'foreign workflow': [{ ...entry, workflowId: 'another-tenant-source' }],
        'empty identity': [{ ...entry, id: '' }],
        'padded identity': [{ ...entry, versionId: ' version-3' }],
        'control character': [{ ...entry, id: 'example\u007f' }],
        '129 UTF-8 bytes': [{ ...entry, id: '🧭'.repeat(32) + 'a' }],
        'zero source version': [{ ...entry, version: 0 }],
        'invalid registration date': [{ ...entry, registeredAt: 'not-a-date' }],
        'invalid retention date': [{ ...entry, retainUntil: 'not-a-date' }],
        'equal retention date': [{ ...entry, retainUntil: entry.registeredAt }],
        'earlier retention date': [{ ...entry, retainUntil: '2026-10-01T12:00:00Z' }],
      }
      for (const [boundary, entries] of Object.entries(invalidLists)) {
        it(`${locale} rejects registry ${boundary} without enabling a mutation`, async () => {
          await changeAppLanguage(locale)
          setup(operation => operation === 'GET /authoring/experiences'
            ? Promise.resolve({ entries, truncated: false }) : undefined)
          render(<VersionHistoryPanel />)
          await screen.findByText(copy[locale].failed)
          expect(screen.queryByRole('button', { name: copy[locale].register })).not.toBeInTheDocument()
          expect(screen.queryByRole('button', { name: copy[locale].withdraw })).not.toBeInTheDocument()
          expect(vi.mocked(contractApi).mock.calls.filter(([operation]) => operation.startsWith('POST'))).toHaveLength(0)
          expect(useWorkflowStore.getState()).toMatchObject({ currentWorkflowId: 'saved-source', workflowDirty: false, toasts: [] })
        })
      }
      it(`${locale} accepts five distinct entries and the exact 128-byte identity boundary`, async () => {
        await changeAppLanguage(locale)
        const entries = Array.from({ length: 5 }, (_, index) => ({ ...entry,
          id: index === 0 ? '🧭'.repeat(32) : `example-${index}` }))
        setup(operation => operation === 'GET /authoring/experiences'
          ? Promise.resolve({ entries, truncated: true }) : undefined)
        render(<VersionHistoryPanel />)
        expect(await screen.findAllByRole('button', { name: copy[locale].withdraw })).toHaveLength(5)
        expect(screen.getByRole('button', { name: copy[locale].register })).toBeDisabled()
        expect(screen.queryByText(copy[locale].failed)).not.toBeInTheDocument()
        expect(vi.mocked(contractApi).mock.calls.filter(([operation]) => operation.startsWith('POST'))).toHaveLength(0)
      })
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
