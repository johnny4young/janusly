import { useCallback } from 'react'
import { api, contractApi } from '../api'
import { useConfirm } from '../components/ConfirmDialog'
import type { WorkflowCreationMode } from '../components/WorkflowsDashboard'
import { getResolvedLocale } from '../i18n'
import { useWorkflowStore } from '../store'
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
  type WorkflowProposalResponse,
} from '../types'
import type { AppCommandsOptions } from './app-command-types'
import { clearDraft, readDraft } from './useDraftPersistence'

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

export function useWorkflowCommands(options: AppCommandsOptions) {
  const {
    store,
    permissions,
    refreshPlatform,
    setValidationIssues,
    setAiReviewIssues,
    setCurrentWorkflowVersion,
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

  const createNewWorkflow = useCallback(async (targetTab?: ActiveTab): Promise<void> => {
    if (!await confirmReplaceCanvas()) return
    newWorkflow()
    setValidationIssues([])
    setCurrentWorkflowVersion(null)
    if (targetTab) setActiveTab(targetTab)
  }, [
    confirmReplaceCanvas,
    newWorkflow,
    setActiveTab,
    setCurrentWorkflowVersion,
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
      hydrateWorkflow(draft.workflow, { saved: savedBase, dirty: true })
    } else {
      clearDraft(workflowId)
    }
  }, [confirm, hydrateWorkflow, t])

  const validateWorkflow = useCallback(async () => {
    if (!canWriteWorkflows) return false
    try {
      const revisionAtRequest = useWorkflowStore.getState().workflowRevision
      const workflow = getWorkflowJson()
      const result = await api('/validate', {
        method: 'POST',
        body: JSON.stringify(workflow),
      }) as ValidationResponse
      if (useWorkflowStore.getState().workflowRevision !== revisionAtRequest) return false
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
    if (!canWriteWorkflows || !await validateWorkflow()) return
    try {
      const workflow = getWorkflowJson()
      const result = await api('/workflows/save', {
        method: 'POST',
        body: JSON.stringify(workflow),
      }) as { version?: number }
      if (typeof result.version === 'number') setCurrentWorkflowVersion(result.version)
      markWorkflowSaved()
      addToast(t('toasts.savedVersion', { version: result.version ?? '?' }), 'success')
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
    setCurrentWorkflowVersion,
    t,
    validateWorkflow,
  ])

  const openWorkflow = useCallback(async (id: string) => {
    if (!await confirmReplaceCanvas()) return
    try {
      const data = await api(
        `/workflows/latest?workflowId=${encodeURIComponent(id)}`,
      ) as { dagJson?: WorkflowDefinition }
      if (!data.dagJson) return
      hydrateWorkflow(data.dagJson)
      setValidationIssues([])
      setActiveTab('inspector')
      await maybeRestoreDraft(id, true)
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('toasts.workflowOpenFailed'), 'error')
    }
  }, [
    addToast,
    confirmReplaceCanvas,
    hydrateWorkflow,
    maybeRestoreDraft,
    setActiveTab,
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
    const result = await api('/ai/workflow-briefs/compile', {
      method: 'POST',
      body: JSON.stringify({ prompt }),
    }) as WorkflowBriefCompilation
    if (!result?.brief || !Array.isArray(result.clarifyingQuestions)) {
      throw new Error(t('toasts.aiResponseInvalid'))
    }
    return result
  }, [t])

  const proposeWorkflow = useCallback(async (
    brief: WorkflowIntentBrief,
    catalogVersion: string,
  ): Promise<WorkflowProposalResponse> => {
    const result = await api('/ai/workflow-proposals', {
      method: 'POST',
      body: JSON.stringify({
        brief,
        catalogVersion,
        currentWorkflow: getWorkflowJson(),
      }),
    }) as WorkflowProposalResponse & { bonBackoff?: unknown }
    if (
      !result?.proposal
      || !result.bindings
      || !Array.isArray(result.proposal.workflow?.nodes)
      || !Array.isArray(result.proposal.workflow?.edges)
    ) {
      throw new Error(t('toasts.aiResponseInvalid'))
    }
    return {
      ...result,
      bonBackoff: parseAiCandidateBackoff(result.bonBackoff),
    }
  }, [getWorkflowJson, t])

  const applyWorkflowProposal = useCallback(async (
    response: WorkflowProposalResponse,
  ): Promise<boolean> => {
    if (!response.proposal.applicable || !response.bindings.complete) return false
    if (!await confirmReplaceCanvas()) return false
    hydrateWorkflow(response.proposal.workflow, { saved: false, dirty: true })
    setValidationIssues([])
    setAiReviewIssues([])
    addToast(t('toasts.aiProposalApplied'), 'success')
    return true
  }, [
    addToast,
    confirmReplaceCanvas,
    hydrateWorkflow,
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
    const revisionAtRequest = useWorkflowStore.getState().workflowRevision
    const workflow = getWorkflowJson()
    const result = await api('/ai/review-workflow', {
      method: 'POST',
      body: JSON.stringify({ workflow }),
    }) as ReviewWorkflowResponse
    if (result.error) throw new Error(result.error)
    const review = result.review ?? { status: 'fail' as const, issues: [] }
    if (useWorkflowStore.getState().workflowRevision === revisionAtRequest) {
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
    if (!await confirmReplaceCanvas()) return false
    hydrateWorkflow(suggestion.workflow, { saved: false, dirty: true })
    setValidationIssues([])
    setAiReviewIssues([])
    setActiveTab('inspector')
    addToast(t('toasts.aiImprovementApplied'), 'success')
    return true
  }, [
    addToast,
    confirmReplaceCanvas,
    hydrateWorkflow,
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
      if (!await confirmReplaceCanvas()) return
      hydrateWorkflow(workflow, { saved: false, dirty: true })
      setValidationIssues([])
      setActiveTab('inspector')
    })()
  }, [
    confirmReplaceCanvas,
    hydrateWorkflow,
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
