import { useCallback } from 'react'
import { api, contractApi } from '../api'
import { useConfirm } from '../components/ConfirmDialog'
import type { WorkflowCreationMode } from '../components/WorkflowsDashboard'
import { getResolvedLocale } from '../i18n'
import { useWorkflowStore, type WorkflowVersionIdentity } from '../store'
import {
  parseAiCandidateBackoff,
  type ActiveTab,
  type AiMode,
  type AiReviewIssue,
  type AuthoringCapabilityCatalog,
  type ValidationIssue,
  type WorkflowBriefCompilation,
  type WorkflowIntentBrief,
  type WorkflowDefinition,
  type WorkflowImprovementResult,
  type WorkflowImprovementSuggestion,
  type WorkflowProposalApplyOutcome,
  type WorkflowProposalResponse,
} from '../types'
import type { AppCommandsOptions } from './app-command-types'
import { clearDraft, readDraft } from './useDraftPersistence'

const loadAuthoringContract = () => import('../lib/authoring-contract')

type ValidationResponse = {
  valid: boolean
  issues?: ValidationIssue[]
}

type ExplainWorkflowResponse = {
  mode?: AiMode
  explanation?: string
  model?: string
  error?: string
  aiError?: string
}

type ReviewWorkflowResponse = {
  mode?: AiMode
  model?: string
  review?: {
    status: 'pass' | 'warn' | 'fail'
    issues: AiReviewIssue[]
  }
  error?: string
  aiError?: string
}

type CanvasAuthority = {
  workflowId: string | null
  revision: number
  orgId: string | null
  userId: string | null
}

function workflowVersionIdentity(
  value: { workflowId?: unknown; versionId?: unknown; id?: unknown; version?: unknown },
  expectedWorkflowId: string,
): WorkflowVersionIdentity | null {
  const id = typeof value.versionId === 'string' ? value.versionId : value.id
  if (value.workflowId !== expectedWorkflowId
    || typeof id !== 'string' || id.length === 0 || id.length > 256
    || typeof value.version !== 'number' || !Number.isSafeInteger(value.version) || value.version < 1) {
    return null
  }
  return { id, version: value.version }
}

function currentCanvasAuthority(): CanvasAuthority {
  const current = useWorkflowStore.getState()
  return {
    workflowId: current.currentWorkflowId,
    revision: current.workflowRevision,
    orgId: current.orgId,
    userId: current.userId,
  }
}

function canvasAuthorityMatches(expected: CanvasAuthority): boolean {
  const current = currentCanvasAuthority()
  return current.workflowId === expected.workflowId
    && current.revision === expected.revision
    && current.orgId === expected.orgId
    && current.userId === expected.userId
}

export function useWorkflowCommands(options: AppCommandsOptions) {
  const {
    store,
    permissions,
    refreshPlatform,
    setValidationIssues,
    setAiReviewIssues,
    t,
  } = options
  const {
    addToast,
    bumpPlatformVersion,
    getWorkflowJson,
    hydrateWorkflow,
    markWorkflowSaved,
    newWorkflow,
    setActiveTab,
    updateEdgeCondition: storeUpdateEdgeCondition,
    updateEdgeOnError: storeUpdateEdgeOnError,
  } = store
  const canWriteWorkflows = permissions.includes('workflows.write')
  const confirm = useConfirm()

  const confirmReplaceCanvas = useCallback(async (): Promise<boolean> => {
    if (!useWorkflowStore.getState().workflowDirty) return true
    return confirm({
      title: t('unsavedGuard.title'),
      body: t('unsavedGuard.body'),
      confirmLabel: t('unsavedGuard.discard'),
      tone: 'danger',
    })
  }, [confirm, t])

  const prepareCanvasReplacement = useCallback(async (): Promise<CanvasAuthority | null> => {
    const expected = currentCanvasAuthority()
    if (!await confirmReplaceCanvas()) return null
    if (!canvasAuthorityMatches(expected)) {
      addToast(t('toasts.workflowOpenFailed'), 'info')
      return null
    }
    return expected
  }, [addToast, confirmReplaceCanvas, t])

  const createNewWorkflow = useCallback(async (targetTab?: ActiveTab): Promise<void> => {
    if (!await prepareCanvasReplacement()) return
    newWorkflow()
    setValidationIssues([])
    if (targetTab) setActiveTab(targetTab)
  }, [
    newWorkflow,
    prepareCanvasReplacement,
    setActiveTab,
    setValidationIssues,
  ])

  const beginWorkflowCreation = useCallback((mode: WorkflowCreationMode): void => {
    if (mode === 'template') {
      setActiveTab('templates')
      return
    }
    void createNewWorkflow(mode === 'describe' ? 'ai-studio' : 'inspector')
  }, [createNewWorkflow, setActiveTab])

  const maybeRestoreDraft = useCallback(async (
    workflowId: string,
    savedBase = false,
    version: WorkflowVersionIdentity | null = null,
  ): Promise<void> => {
    const draft = readDraft(workflowId)
    if (!draft) return
    const restore = await confirm({
      title: t('draftRestore.title'),
      body: t('draftRestore.body', {
        time: new Date(draft.savedAt).toLocaleString(getResolvedLocale()),
      }),
      confirmLabel: t('draftRestore.restore'),
      cancelLabel: t('draftRestore.discard'),
    })
    if (restore) {
      hydrateWorkflow(draft.workflow, { saved: savedBase, dirty: true, version })
    } else {
      clearDraft(workflowId)
    }
  }, [confirm, hydrateWorkflow, t])

  const validateWorkflow = useCallback(async () => {
    if (!canWriteWorkflows) return false
    try {
      const authorityAtRequest = currentCanvasAuthority()
      const workflow = getWorkflowJson()
      const result = await api('/validate', {
        method: 'POST',
        body: JSON.stringify(workflow),
      }) as ValidationResponse
      if (!canvasAuthorityMatches(authorityAtRequest)) return false
      setValidationIssues(result.issues ?? [])
      addToast(
        result.valid ? t('toasts.validationOk') : t('toasts.validationNeedsFix'),
        result.valid ? 'success' : 'error',
      )
      return result.valid
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('toasts.validationFailed'), 'error')
      return false
    }
  }, [addToast, canWriteWorkflows, getWorkflowJson, setValidationIssues, t])

  const saveWorkflow = useCallback(async () => {
    const authorityBeforeValidation = currentCanvasAuthority()
    if (!canWriteWorkflows || !await validateWorkflow()) return
    if (!canvasAuthorityMatches(authorityBeforeValidation)) return
    try {
      const workflow = getWorkflowJson()
      const authorityAtSave = currentCanvasAuthority()
      const result = await api('/workflows/save', {
        method: 'POST',
        body: JSON.stringify(workflow),
      }) as { workflowId?: unknown; versionId?: unknown; version?: unknown }
      const committedVersion = workflowVersionIdentity(result, workflow.id ?? '')
      if (!committedVersion) throw new Error(t('apiErrors.workflows_version_malformed'))
      if (canvasAuthorityMatches(authorityAtSave)) {
        markWorkflowSaved(committedVersion)
      }
      addToast(t('toasts.savedVersion', { version: committedVersion.version }), 'success')
      bumpPlatformVersion()
      await refreshPlatform()
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('toasts.saveFailed'), 'error')
    }
  }, [
    addToast,
    bumpPlatformVersion,
    canWriteWorkflows,
    getWorkflowJson,
    markWorkflowSaved,
    refreshPlatform,
    t,
    validateWorkflow,
  ])

  const openWorkflow = useCallback(async (id: string): Promise<boolean> => {
    const authority = await prepareCanvasReplacement()
    if (!authority) return false
    try {
      const [data, { isWorkflowDefinition }] = await Promise.all([
        contractApi('GET /workflows/latest', `/workflows/latest?workflowId=${encodeURIComponent(id)}`, undefined) as unknown as Promise<{
          id?: unknown
          workflowId?: unknown
          dagJson?: unknown
          version?: unknown
        }>,
        loadAuthoringContract(),
      ])
      if (!canvasAuthorityMatches(authority)) {
        addToast(t('toasts.workflowOpenFailed'), 'info')
        return false
      }
      if (!isWorkflowDefinition(data.dagJson) || data.dagJson.id !== id
        || !workflowVersionIdentity(data, id)) {
        throw new Error(t('apiErrors.workflows_version_malformed'))
      }
      const version = workflowVersionIdentity(data, id)!
      hydrateWorkflow(structuredClone(data.dagJson), { version })
      setValidationIssues([])
      setAiReviewIssues([])
      setActiveTab('inspector')
      await maybeRestoreDraft(id, true, version)
      return true
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('toasts.workflowOpenFailed'), 'error')
      return false
    }
  }, [
    addToast,
    hydrateWorkflow,
    maybeRestoreDraft,
    prepareCanvasReplacement,
    setActiveTab,
    setAiReviewIssues,
    setValidationIssues,
    t,
  ])

  const openWorkflowVersion = useCallback(async (
    workflowId: string,
    versionId: string,
    targetTab: ActiveTab = 'inspector',
  ): Promise<boolean> => {
    if (!workflowId || workflowId.length > 256 || !versionId || versionId.length > 256) {
      addToast(t('apiErrors.workflows_version_malformed'), 'error')
      return false
    }
    const authority = await prepareCanvasReplacement()
    if (!authority) return false
    try {
      const path = `/workflows/versions/${encodeURIComponent(versionId)}?workflowId=${encodeURIComponent(workflowId)}`
      const [response, { parseWorkflowVersionSnapshot }] = await Promise.all([
        contractApi(
          'GET /workflows/versions/{versionId}',
          path,
          undefined,
        ),
        loadAuthoringContract(),
      ])
      if (!canvasAuthorityMatches(authority)) {
        addToast(t('toasts.workflowOpenFailed'), 'info')
        return false
      }
      const snapshot = parseWorkflowVersionSnapshot(response, workflowId, versionId)
      if (!snapshot) throw new Error(t('apiErrors.workflows_version_malformed'))
      hydrateWorkflow(structuredClone(snapshot.dagJson), {
        version: { id: snapshot.id, version: snapshot.version },
      })
      setValidationIssues([])
      setAiReviewIssues([])
      setActiveTab(targetTab)
      addToast(t('versionHistory.loaded', { version: snapshot.version }), 'info')
      return true
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('toasts.workflowOpenFailed'), 'error')
      return false
    }
  }, [
    addToast,
    hydrateWorkflow,
    prepareCanvasReplacement,
    setActiveTab,
    setAiReviewIssues,
    setValidationIssues,
    t,
  ])

  const loadAuthoringCapabilities = useCallback(async (): Promise<AuthoringCapabilityCatalog> => {
    return await contractApi(
      'GET /authoring/capabilities',
      '/authoring/capabilities',
      undefined,
    )
  }, [])

  const compileWorkflowBrief = useCallback(async (prompt: string): Promise<WorkflowBriefCompilation> => {
    const [result, { isWorkflowBriefCompilation }] = await Promise.all([
      contractApi(
        'POST /ai/workflow-briefs/compile',
        '/ai/workflow-briefs/compile',
        { prompt },
      ),
      loadAuthoringContract(),
    ])
    if (!isWorkflowBriefCompilation(result)) {
      throw new Error(t('toasts.aiResponseInvalid'))
    }
    return result
  }, [t])

  const proposeWorkflow = useCallback(async (
    brief: WorkflowIntentBrief,
    catalogVersion: string,
    sourcePrompt: string,
  ): Promise<WorkflowProposalResponse> => {
    const [result, { isWorkflowProposalResponse }] = await Promise.all([
      contractApi(
        'POST /ai/workflow-proposals',
        '/ai/workflow-proposals',
        {
          prompt: sourcePrompt,
          brief,
          catalogVersion,
          currentWorkflow: getWorkflowJson(),
        },
      ),
      loadAuthoringContract(),
    ])
    if (!isWorkflowProposalResponse(result)) {
      throw new Error(t('toasts.aiResponseInvalid'))
    }
    return {
      ...result,
      bonBackoff: parseAiCandidateBackoff(result.bonBackoff),
    }
  }, [getWorkflowJson, t])

  const applyWorkflowProposal = useCallback(async (
    response: WorkflowProposalResponse,
  ): Promise<WorkflowProposalApplyOutcome> => {
    const sourceAuthority = currentCanvasAuthority()
    // Detach Apply from the review component's live object before the first
    // asynchronous import, confirmation, or catalog boundary. The exact
    // snapshot validated below, not a later mutation of shared UI state, is
    // the only object that may eventually be copied to the canvas.
    let proposalSnapshot: WorkflowProposalResponse
    try {
      proposalSnapshot = structuredClone(response)
    } catch {
      addToast(t('toasts.aiResponseInvalid'), 'error')
      return { status: 'blocked' }
    }
    if (!proposalSnapshot.proposal.applicable || !proposalSnapshot.bindings.complete) {
      return { status: 'blocked' }
    }
    const { isWorkflowProposalApplySafe } = await loadAuthoringContract()
    if (!await isWorkflowProposalApplySafe(proposalSnapshot)) {
      addToast(t('toasts.aiResponseInvalid'), 'error')
      return { status: 'blocked' }
    }
    if (!canvasAuthorityMatches(sourceAuthority)) return { status: 'canvas_changed' }
    if (!await confirmReplaceCanvas()) return { status: 'cancelled' }
    // The confirmation is asynchronous. Never replace a different or newly
    // edited canvas if the operator navigated while the dialog was open.
    if (!canvasAuthorityMatches(sourceAuthority)) return { status: 'canvas_changed' }

    // Capability membership can change after Proposal or while the unsaved
    // canvas confirmation is open. Re-read it after confirmation and then
    // re-check the canvas again at the final synchronous copy boundary.
    const currentCatalog = await loadAuthoringCapabilities()
    if (!canvasAuthorityMatches(sourceAuthority)) return { status: 'canvas_changed' }
    if (currentCatalog.version !== proposalSnapshot.bindings.catalogVersion) {
      return { status: 'catalog_changed', catalog: currentCatalog }
    }
    hydrateWorkflow(proposalSnapshot.proposal.workflow, { saved: false, dirty: true })
    setValidationIssues([])
    setAiReviewIssues([])
    addToast(t('toasts.aiProposalApplied'), 'success')
    return { status: 'applied' }
  }, [
    addToast,
    confirmReplaceCanvas,
    hydrateWorkflow,
    loadAuthoringCapabilities,
    setAiReviewIssues,
    setValidationIssues,
    t,
  ])

  const explainWorkflow = useCallback(async () => {
    const workflow = getWorkflowJson()
    const result = await api('/ai/explain-workflow', {
      method: 'POST',
      body: JSON.stringify({ workflow }),
    }) as ExplainWorkflowResponse
    if (result.error) throw new Error(result.error)
    return {
      mode: result.mode ?? 'fallback',
      explanation: result.explanation ?? t('toasts.noWorkflowExplanation'),
      model: result.model,
      aiError: result.aiError,
    }
  }, [getWorkflowJson, t])

  const reviewWorkflow = useCallback(async () => {
    setAiReviewIssues([])
    const authorityAtRequest = currentCanvasAuthority()
    const workflow = getWorkflowJson()
    const result = await api('/ai/review-workflow', {
      method: 'POST',
      body: JSON.stringify({ workflow }),
    }) as ReviewWorkflowResponse
    if (result.error) throw new Error(result.error)
    const review = result.review ?? { status: 'fail' as const, issues: [] }
    if (canvasAuthorityMatches(authorityAtRequest)) {
      setAiReviewIssues(review.issues)
    }
    return {
      mode: result.mode ?? 'fallback',
      review,
      model: result.model,
      aiError: result.aiError,
    }
  }, [getWorkflowJson, setAiReviewIssues])

  const suggestWorkflowImprovement = useCallback(async (): Promise<WorkflowImprovementResult> => {
    const workflow = getWorkflowJson()
    const result = await api('/ai/suggest-improvement', {
      method: 'POST',
      body: JSON.stringify({ workflow }),
    }) as {
      mode?: AiMode
      suggestions?: WorkflowImprovementSuggestion[]
      model?: string
      aiError?: string
      error?: string
    }
    if (result.error) throw new Error(result.error)
    return {
      mode: result.mode ?? 'fallback',
      suggestions: Array.isArray(result.suggestions) ? result.suggestions : [],
      model: result.model,
      aiError: result.aiError,
    }
  }, [getWorkflowJson])

  const applyWorkflowImprovement = useCallback(async (
    suggestion: WorkflowImprovementSuggestion,
  ): Promise<boolean> => {
    if (!await prepareCanvasReplacement()) return false
    hydrateWorkflow(suggestion.workflow, { saved: false, dirty: true })
    setValidationIssues([])
    setAiReviewIssues([])
    setActiveTab('inspector')
    addToast(t('toasts.aiImprovementApplied'), 'success')
    return true
  }, [
    addToast,
    hydrateWorkflow,
    prepareCanvasReplacement,
    setActiveTab,
    setAiReviewIssues,
    setValidationIssues,
    t,
  ])

  const updateEdgeCondition = useCallback((edgeId: string, condition: string) => {
    storeUpdateEdgeCondition(edgeId, condition || null)
  }, [storeUpdateEdgeCondition])

  const updateEdgeOnError = useCallback((edgeId: string, onError: boolean) => {
    storeUpdateEdgeOnError(edgeId, onError)
  }, [storeUpdateEdgeOnError])

  const useTemplate = useCallback((workflow: WorkflowDefinition) => {
    void (async () => {
      if (!await prepareCanvasReplacement()) return
      hydrateWorkflow(workflow, { saved: false, dirty: true })
      setValidationIssues([])
      setActiveTab('inspector')
    })()
  }, [
    hydrateWorkflow,
    prepareCanvasReplacement,
    setActiveTab,
    setValidationIssues,
  ])

  return {
    applyWorkflowProposal,
    applyWorkflowImprovement,
    beginWorkflowCreation,
    compileWorkflowBrief,
    confirmReplaceCanvas,
    createNewWorkflow,
    explainWorkflow,
    loadAuthoringCapabilities,
    maybeRestoreDraft,
    openWorkflow,
    openWorkflowVersion,
    proposeWorkflow,
    reviewWorkflow,
    saveWorkflow,
    suggestWorkflowImprovement,
    updateEdgeCondition,
    updateEdgeOnError,
    useTemplate,
    validateWorkflow,
  }
}
