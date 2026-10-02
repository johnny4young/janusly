import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAiStudioController } from '../components/ai-studio/useAiStudioController'
import type { AiStudioPanelProps } from '../components/ai-studio/model'
import { changeAppLanguage } from '../i18n'
import { useWorkflowStore } from '../store'
import type { SessionContext } from '../identity-context'
import type { WorkflowBriefCompilation, WorkflowProposalResponse } from '../types'
import { invalidateTags } from '../lib/query-cache'
import { catalog, compilation, workflowProposal } from './ai-studio-fixtures'
import { deferred } from './deferred'

const initial = useWorkflowStore.getState()
const grants = ['ai.write', 'workflows.read', 'workflows.write']
function identity(permissions = grants): SessionContext {
  return { identity: { userId: 'operator', email: null, mode: 'dev-headers', source: 'dev' }, profile: { name: null, email: null },
    organizations: [{ id: 'tenant', name: 'Tenant', plan: null, role: 'editor', roleBase: 'editor', permissions,
      usable: true, developmentFallback: false, isOwner: false }], invitations: [], currentOrganizationId: 'tenant',
    selectionRequired: false, needsOrganization: false, truncated: false, invitationsTruncated: false }
}
function sourceProposal(): WorkflowProposalResponse {
  return workflowProposal({ mode: 'fallback', experienceDecision: { mode: 'REUSE', reason: 'exact_match', provider: 'rules',
    policyVersion: 'authoring-experience-v1', contextRevision: 'context', catalogVersion: catalog.version, draftId: 'wf_proposed',
    source: { candidateId: 'registered-source', workflowId: 'source', versionId: 'immutable-3', version: 3 },
    truncated: false, outcomeEvidence: 'unknown' } })
}
function props(overrides: Partial<AiStudioPanelProps> = {}): AiStudioPanelProps {
  return { health: null, workflowName: 'Current', actionRequest: null,
    onLoadAuthoringCapabilities: vi.fn(async () => catalog), onCompileWorkflowBrief: vi.fn(async () => compilation),
    onProposeWorkflow: vi.fn(async () => sourceProposal()), onApplyWorkflowProposal: vi.fn(async () => ({ status: 'applied' as const })),
    onExplainWorkflow: vi.fn(async () => ({ mode: 'fallback' as const, explanation: '' })),
    onReviewWorkflow: vi.fn(async () => ({ mode: 'fallback' as const, review: { status: 'pass' as const, issues: [] } })),
    onSuggestWorkflowImprovement: vi.fn(async () => ({ mode: 'fallback' as const, suggestions: [] })), onApplyWorkflowImprovement: vi.fn(async () => false),
    onViewCanvas: vi.fn(), onOpenRuns: vi.fn(), onOpenTemplates: vi.fn(), ...overrides }
}
const boundaries = ['organization', 'user', 'workflow', 'navigation', 'ai.write', 'workflows.read', 'workflows.write'] as const
function transientBoundary(boundary: typeof boundaries[number]) {
  const previous = useWorkflowStore.getState()
  if (boundary === 'organization') useWorkflowStore.setState({ orgId: 'other' })
  else if (boundary === 'user') useWorkflowStore.setState({ userId: 'other' })
  else if (boundary === 'workflow') useWorkflowStore.setState({ currentWorkflowId: 'other' })
  else if (boundary === 'navigation') useWorkflowStore.setState({ activeTab: 'operations' })
  else useWorkflowStore.setState({ identityContext: identity(grants.filter(value => value !== boundary)) })
  useWorkflowStore.setState({ orgId: previous.orgId, userId: previous.userId, currentWorkflowId: previous.currentWorkflowId,
    activeTab: previous.activeTab, identityContext: previous.identityContext })
}
export function registerExperienceControllerOwnershipCases() {
  describe('authoring controller first-change ownership', () => {
    beforeEach(() => useWorkflowStore.setState({ ...initial, orgId: 'tenant', userId: 'operator', identityContext: identity(),
      currentWorkflowId: 'current', activeTab: 'ai-studio' }, true))
    for (const locale of ['en', 'es'] as const) {
      for (const stage of ['compile', 'propose'] as const) {
        for (const boundary of boundaries) {
          for (const outcome of ['resolve', 'reject'] as const) {
            it(`${locale} discards late ${stage} ${outcome} after ${boundary} ABA`, async () => {
              await changeAppLanguage(locale)
              const compile = deferred<WorkflowBriefCompilation>()
              const propose = deferred<WorkflowProposalResponse>()
              const callbacks = props(stage === 'compile' ? { onCompileWorkflowBrief: vi.fn(() => compile.promise) }
                : { onProposeWorkflow: vi.fn(() => propose.promise) })
              const { result } = renderHook(() => useAiStudioController(callbacks))
              await waitFor(() => expect(result.current.catalog).toEqual(catalog))
              if (stage === 'propose') await act(async () => result.current.compileBrief())
              let applying!: Promise<void>
              act(() => { applying = stage === 'compile' ? result.current.compileBrief() : result.current.buildProposal() })
              expect(result.current.authoringLoading).toBe(stage)
              act(() => transientBoundary(boundary))
              expect(result.current.authoringLoading).toBeNull()
              await act(async () => {
                if (stage === 'compile') {
                  if (outcome === 'resolve') compile.resolve(compilation); else compile.reject(new Error('STALE_COMPILE_ERROR'))
                } else if (outcome === 'resolve') propose.resolve(sourceProposal()); else propose.reject(new Error('STALE_PROPOSE_ERROR'))
                await applying
              })
              expect(result.current.proposal).toBeNull()
              if (stage === 'compile') expect(result.current.briefCompilation).toBeNull()
              expect(result.current.authoringError).toBeNull()
              expect(result.current.authoringLoading).toBeNull()
              expect(callbacks.onApplyWorkflowProposal).not.toHaveBeenCalled()
            })
          }
        }
      }
      for (const tag of ['authoring-experiences', 'memory', 'org-config', 'versions', 'workflows', 'credentials', 'mcp'] as const) {
        for (const outcome of ['resolve', 'reject'] as const) {
          it(`${locale} source ${tag} invalidation discards pending proposal ${outcome}`, async () => {
            await changeAppLanguage(locale)
            const pending = deferred<WorkflowProposalResponse>()
            const callbacks = props({ onProposeWorkflow: vi.fn(() => pending.promise) })
            const { result } = renderHook(() => useAiStudioController(callbacks))
            await waitFor(() => expect(result.current.catalog).toEqual(catalog))
            await act(async () => result.current.compileBrief())
            let proposing!: Promise<void>
            act(() => { proposing = result.current.buildProposal() })
            act(() => invalidateTags([tag]))
            expect(result.current.authoringLoading).toBeNull()
            await act(async () => {
              if (outcome === 'resolve') pending.resolve(sourceProposal()); else pending.reject(new Error('STALE_RESOURCE_ERROR'))
              await proposing
            })
            expect(result.current.proposal).toBeNull()
            expect(result.current.authoringError).toBeNull()
            expect(callbacks.onApplyWorkflowProposal).not.toHaveBeenCalled()
          })
        }
      }
      for (const outcome of ['resolve', 'reject'] as const) {
        it(`${locale} old catalog ${outcome} cannot populate identity ABA or release the new catalog read`, async () => {
          await changeAppLanguage(locale)
          const old = deferred<typeof catalog>()
          const current = deferred<typeof catalog>()
          const callbacks = props({ onLoadAuthoringCapabilities: vi.fn<AiStudioPanelProps['onLoadAuthoringCapabilities']>()
            .mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise) })
          const { result } = renderHook(() => useAiStudioController(callbacks))
          act(() => transientBoundary('user'))
          await waitFor(() => expect(callbacks.onLoadAuthoringCapabilities).toHaveBeenCalledTimes(2))
          await act(async () => { if (outcome === 'resolve') old.resolve(catalog); else old.reject(new Error('STALE_CATALOG_ERROR')) })
          expect(result.current.catalog).toBeNull()
          expect(result.current.catalogError).toBeNull()
          expect(result.current.catalogLoading).toBe(true)
          const freshCatalog = { ...catalog, version: 'current-catalog' }
          await act(async () => current.resolve(freshCatalog))
          expect(result.current.catalog).toEqual(freshCatalog)
          expect(result.current.catalogLoading).toBe(false)
          expect(callbacks.onCompileWorkflowBrief).not.toHaveBeenCalled()
          expect(callbacks.onProposeWorkflow).not.toHaveBeenCalled()
        })
        for (const stage of ['compile', 'propose'] as const) {
          it(`${locale} old ${stage} ${outcome} after navigation ABA cannot release a new request`, async () => {
            await changeAppLanguage(locale)
            const oldCompile = deferred<WorkflowBriefCompilation>(), currentCompile = deferred<WorkflowBriefCompilation>()
            const oldProposal = deferred<WorkflowProposalResponse>(), currentProposal = deferred<WorkflowProposalResponse>()
            const callbacks = props(stage === 'compile'
              ? { onCompileWorkflowBrief: vi.fn<AiStudioPanelProps['onCompileWorkflowBrief']>().mockReturnValueOnce(oldCompile.promise).mockReturnValueOnce(currentCompile.promise) }
              : { onProposeWorkflow: vi.fn<AiStudioPanelProps['onProposeWorkflow']>().mockReturnValueOnce(oldProposal.promise).mockReturnValueOnce(currentProposal.promise) })
            const { result } = renderHook(() => useAiStudioController(callbacks))
            await waitFor(() => expect(result.current.catalog).toEqual(catalog))
            if (stage === 'propose') await act(async () => result.current.compileBrief())
            let oldRequest!: Promise<void>, currentRequest!: Promise<void>
            act(() => { oldRequest = stage === 'compile' ? result.current.compileBrief() : result.current.buildProposal() })
            act(() => transientBoundary('navigation'))
            act(() => { currentRequest = stage === 'compile' ? result.current.compileBrief() : result.current.buildProposal() })
            await act(async () => {
              if (stage === 'compile') {
                if (outcome === 'reject') oldCompile.reject(new Error('STALE_ERROR')); else oldCompile.resolve(compilation)
              } else if (outcome === 'reject') oldProposal.reject(new Error('STALE_ERROR')); else oldProposal.resolve(sourceProposal())
              await oldRequest
            })
            expect(result.current.authoringLoading).toBe(stage)
            expect(result.current.proposal).toBeNull()
            expect(result.current.authoringError).toBeNull()
            await act(async () => {
              if (stage === 'compile') currentCompile.resolve(compilation); else currentProposal.resolve(sourceProposal())
              await currentRequest
            })
            expect(result.current.authoringLoading).toBeNull()
            if (stage === 'compile') expect(result.current.briefCompilation?.brief).toEqual(compilation.brief)
            else expect(result.current.proposal).toEqual(sourceProposal())
          })
        }
      }
      it(`${locale} unmount disposes the store and resource observers without dispatching work`, async () => {
        await changeAppLanguage(locale)
        const callbacks = props()
        const unsubscribes: ReturnType<typeof vi.fn>[] = []
        const subscribe = useWorkflowStore.subscribe
        const spy = vi.spyOn(useWorkflowStore, 'subscribe').mockImplementation(listener => {
          const unsubscribe = vi.fn(subscribe(listener))
          unsubscribes.push(unsubscribe)
          return unsubscribe
        })
        try {
          const { result, unmount } = renderHook(() => useAiStudioController(callbacks))
          await waitFor(() => expect(result.current.catalog).toEqual(catalog))
          unmount()
          for (const unsubscribe of unsubscribes) expect(unsubscribe).toHaveBeenCalledOnce()
          act(() => { transientBoundary('user'); invalidateTags(['memory', 'authoring-experiences']) })
          expect(callbacks.onLoadAuthoringCapabilities).toHaveBeenCalledOnce()
          expect(callbacks.onProposeWorkflow).not.toHaveBeenCalled()
          expect(callbacks.onCompileWorkflowBrief).not.toHaveBeenCalled()
        } finally { spy.mockRestore() }
      })
      it(`${locale} a completed source proposal cannot regain Apply eligibility after identity ABA`, async () => {
        await changeAppLanguage(locale)
        const callbacks = props()
        const { result } = renderHook(() => useAiStudioController(callbacks))
        await waitFor(() => expect(result.current.catalog).toEqual(catalog))
        await act(async () => result.current.compileBrief())
        await act(async () => result.current.buildProposal())
        expect(result.current.proposal).not.toBeNull()
        act(() => transientBoundary('user'))
        expect(result.current.proposal).toBeNull()
        await act(async () => result.current.applyProposal())
        expect(callbacks.onApplyWorkflowProposal).not.toHaveBeenCalled()
      })
    }
  })
}
