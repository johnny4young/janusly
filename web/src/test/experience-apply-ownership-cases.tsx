import { invalidateTags } from '../lib/query-cache'
import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, contractApi } from '../api'
import { changeAppLanguage } from '../i18n'
import { useWorkflowStore } from '../store'
import type { SessionContext } from '../identity-context'
import type { AuthoringCapabilityCatalog, WorkflowProposalApplyOutcome, WorkflowProposalResponse } from '../types'
import type { AppCommandsOptions } from '../hooks/app-command-types'
import { useWorkflowCommands } from '../hooks/useWorkflowCommands'
import { deferred } from './deferred'

const initial = useWorkflowStore.getState()
const permissions = ['workflows.read', 'workflows.write', 'ai.write']
const catalog: AuthoringCapabilityCatalog = {
  schemaVersion: '1', version: 'catalog-v1', builtinTools: [], mcpTools: [],
  triggers: [], credentials: [], subworkflows: [], primitives: [], warnings: [],
}
function identity(grants = permissions): SessionContext {
  return {
    identity: { userId: 'operator', email: null, mode: 'dev-headers', source: 'dev' },
    profile: { name: null, email: null }, invitations: [], currentOrganizationId: 'tenant',
    organizations: [{ id: 'tenant', name: 'Tenant', plan: null, role: 'editor', roleBase: 'editor',
      permissions: grants, usable: true, developmentFallback: false, isOwner: false }],
    selectionRequired: false, needsOrganization: false, truncated: false, invitationsTruncated: false,
  }
}
function proposal(): WorkflowProposalResponse {
  return {
    mode: 'fallback',
    brief: { version: '1', objective: 'Local review', trigger: 'manual', inputs: [],
      expectedOutcome: 'Local result', externalEffects: [], approvals: [], failurePolicy: 'stop', examples: [], language: 'en' },
    clarifyingQuestions: [], bindings: { catalogVersion: catalog.version, resolved: [], missing: [], complete: true },
    proposal: {
      workflow: { dslVersion: '1.0', id: 'reviewed-draft', name: 'Reviewed source',
        nodes: [{ id: 'done', type: 'noop', config: {} }], edges: [], outputs: {} },
      intentContract: {}, recoveryContract: null,
      qualification: { intent: false, recovery: false, semantic: false },
      assumptions: [], risks: [], readiness: { status: 'pass', issues: [] },
      diff: { nodesAdded: ['done'], nodesRemoved: [], nodesChanged: [], edgesBefore: 0, edgesAfter: 0 }, applicable: true,
    },
    experienceDecision: {
      provider: 'rules', mode: 'REUSE', reason: 'exact_match', policyVersion: 'authoring-experience-v1',
      contextRevision: 'review-revision', catalogVersion: catalog.version, draftId: 'reviewed-draft',
      source: { candidateId: 'registered-example', workflowId: 'source', versionId: 'source-version', version: 7 },
      truncated: false, outcomeEvidence: 'unknown',
    },
  }
}
function options(): AppCommandsOptions {
  return {
    store: useWorkflowStore.getState() as unknown as AppCommandsOptions['store'], permissions,
    projectedRuns: [], refreshPlatform: vi.fn(async () => undefined), projectRunSummary: vi.fn(),
    loadStatus: vi.fn(async () => undefined), runTransitionGuard: {} as AppCommandsOptions['runTransitionGuard'],
    runPlatformMutation: vi.fn() as AppCommandsOptions['runPlatformMutation'],
    setValidationIssues: vi.fn(), setAiReviewIssues: vi.fn(), setRunInputOpen: vi.fn(),
    setRunInputServerErrors: vi.fn(), setRunInputSubmitting: vi.fn(), setActivityRecoveryId: vi.fn(),
    setPaletteOpen: vi.fn(), setShortcutsOpen: vi.fn(), focusSidebarSearch: () => false, t: key => key,
  }
}
const boundaries = ['organization', 'identity', 'workflow', 'navigation', 'ai.write', 'workflows.read', 'workflows.write'] as const
function changeBoundary(boundary: typeof boundaries[number]) {
  if (boundary === 'organization') useWorkflowStore.setState({ orgId: 'other-tenant' })
  else if (boundary === 'identity') useWorkflowStore.setState({ userId: 'other-operator' })
  else if (boundary === 'workflow') useWorkflowStore.setState({ currentWorkflowId: 'other-canvas' })
  else if (boundary === 'navigation') useWorkflowStore.setState({ activeTab: 'operations' })
  else useWorkflowStore.setState({ identityContext: identity(permissions.filter(permission => permission !== boundary)) })
}
export function registerExperienceApplyOwnershipCases() {
  describe('experience Apply ownership lease', () => {
    beforeEach(() => {
      vi.mocked(api).mockReset()
      vi.mocked(contractApi).mockReset()
      useWorkflowStore.setState({ ...initial, orgId: 'tenant', userId: 'operator',
        activeTab: 'ai-studio', identityContext: identity(), toasts: [] }, true)
      useWorkflowStore.getState().hydrateWorkflow({ id: 'current-canvas', name: 'Current canvas', nodes: [], edges: [] })
    })
    for (const locale of ['en', 'es'] as const) {
      for (const boundary of boundaries) {
        for (const returns of [false, true]) {
          for (const outcome of ['resolve', 'reject'] as const) {
            it(`${locale} discards late ${outcome} after ${boundary}${returns ? ' even when context returns' : ''}`, async () => {
              await changeAppLanguage(locale)
              const pending = deferred<WorkflowProposalResponse>()
              vi.mocked(contractApi).mockImplementation(async operation => {
                if (operation === 'GET /authoring/capabilities') return catalog as never
                if (operation === 'POST /ai/workflow-proposals') return pending.promise as never
                throw new Error('Unexpected operation: ' + operation)
              })
              const { result } = renderHook(() => useWorkflowCommands(options()))
              const reviewed = proposal()
              const reviewedSnapshot = structuredClone(reviewed)
              let applying!: Promise<WorkflowProposalApplyOutcome>
              act(() => { applying = result.current.applyWorkflowProposal(reviewed) })
              await waitFor(() => expect(contractApi).toHaveBeenCalledWith('POST /ai/workflow-proposals', expect.anything(), expect.anything(), expect.anything()))
              const previous = useWorkflowStore.getState()
              act(() => {
                changeBoundary(boundary)
                if (returns) useWorkflowStore.setState({ orgId: previous.orgId, userId: previous.userId,
                  currentWorkflowId: previous.currentWorkflowId, activeTab: previous.activeTab, identityContext: previous.identityContext })
              })
              const canvas = useWorkflowStore.getState().getWorkflowJson()
              let actual: WorkflowProposalApplyOutcome | undefined
              await act(async () => {
                if (outcome === 'reject') pending.reject(new Error('STALE_SOURCE_ERROR'))
                else pending.resolve(structuredClone(reviewed))
                actual = await applying
              })
              expect(actual).toEqual({ status: 'canvas_changed' })
              expect(useWorkflowStore.getState().getWorkflowJson()).toEqual(canvas)
              expect(useWorkflowStore.getState().toasts).toHaveLength(0)
              expect(reviewed).toEqual(reviewedSnapshot)
              expect(api).not.toHaveBeenCalled()
              expect(contractApi).toHaveBeenCalledTimes(2)
            })
          }
        }
      }
      for (const tag of ['authoring-experiences', 'memory', 'org-config', 'versions', 'workflows'] as const) {
        for (const outcome of ['resolve', 'reject'] as const) {
          it(`${locale} source resource ${tag} invalidation discards late Apply ${outcome}`, async () => {
            await changeAppLanguage(locale)
            const pending = deferred<WorkflowProposalResponse>()
            vi.mocked(contractApi).mockImplementation(async operation => (
              operation === 'GET /authoring/capabilities' ? catalog as never : pending.promise as never
            ))
            const { result } = renderHook(() => useWorkflowCommands(options()))
            const reviewed = proposal()
            let applying!: Promise<WorkflowProposalApplyOutcome>
            act(() => { applying = result.current.applyWorkflowProposal(reviewed) })
            await waitFor(() => expect(contractApi).toHaveBeenCalledTimes(2))
            const canvas = useWorkflowStore.getState().getWorkflowJson()
            act(() => invalidateTags([tag]))
            let actual: WorkflowProposalApplyOutcome | undefined
            await act(async () => {
              if (outcome === 'resolve') pending.resolve(structuredClone(reviewed))
              else pending.reject(new Error('STALE_RESOURCE_ERROR'))
              actual = await applying
            })
            expect(actual).toEqual({ status: 'canvas_changed' })
            expect(useWorkflowStore.getState().getWorkflowJson()).toEqual(canvas)
            expect(useWorkflowStore.getState().toasts).toHaveLength(0)
            expect(api).not.toHaveBeenCalled()
          })
        }
      }
      it(`${locale} explicit Apply copies only the reviewed unsaved snapshot without Save or Run`, async () => {
        await changeAppLanguage(locale)
        const reviewed = proposal()
        vi.mocked(contractApi).mockImplementation(async operation => (
          operation === 'GET /authoring/capabilities' ? catalog as never : structuredClone(reviewed) as never
        ))
        const { result } = renderHook(() => useWorkflowCommands(options()))
        let actual: WorkflowProposalApplyOutcome | undefined
        await act(async () => { actual = await result.current.applyWorkflowProposal(reviewed) })
        expect(actual).toEqual({ status: 'applied' })
        expect(useWorkflowStore.getState()).toMatchObject({ currentWorkflowId: 'reviewed-draft', currentWorkflowSaved: false, workflowDirty: true })
        expect(api).not.toHaveBeenCalled()
        expect(contractApi).toHaveBeenCalledTimes(2)
      })
    }
  })
}
