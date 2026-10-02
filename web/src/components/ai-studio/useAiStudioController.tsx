import { sessionCan } from '../../identity-context'
import { currentAuthoringAuthority } from '../../lib/canvas-authority'
import { AUTHORING_EXPERIENCE_TAGS } from '../../lib/experience-authority'
import { subscribeToTags } from '../../lib/query-cache'
// The AI Studio controller: every piece of authoring state, the request
// generations that discard stale responses, and the derived facts the views
// render. Views receive the returned model and stay presentational.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AuthoringCapabilityCatalog, WorkflowProposalResponse } from '../../types'
import { useT } from '../../i18n'
import { useWorkflowStore } from '../../store'
import {
  MAX_AUTHORING_PROMPT_CHARS,
  composeAuthoringPrompt,
  type AiStudioPanelProps,
  type AuthoringLoading,
  type CompiledBriefState,
  type CurrentWorkflowLoading,
  type ResultState,
} from './model'

export type AiStudioModel = ReturnType<typeof useAiStudioController>

export function useAiStudioController({
  health,
  workflowName,
  onLoadAuthoringCapabilities,
  onCompileWorkflowBrief,
  onProposeWorkflow,
  onApplyWorkflowProposal,
  onExplainWorkflow,
  onReviewWorkflow,
  actionRequest,
  onSuggestWorkflowImprovement,
  onApplyWorkflowImprovement,
  onViewCanvas,
  onOpenRuns,
  onOpenTemplates,
}: AiStudioPanelProps) {
  const { t, i18n } = useT()
  const locale = i18n.resolvedLanguage
  // t is reference-stable but reads the mutable runtime locale. Keep locale
  // as an explicit invalidation key so untouched starter text can be relocalized.
  /* oxlint-disable react/exhaustive-deps -- stable translator reads the runtime locale */
  const starterPrompts = useMemo(() => [
    t('aiStudio.starter1'),
    t('aiStudio.starter2'),
    t('aiStudio.starter3'),
  ], [locale, t])
  /* oxlint-enable react/exhaustive-deps */
  const primaryStarterPrompt = starterPrompts[0]

  const [prompt, setPrompt] = useState(primaryStarterPrompt)
  const [catalog, setCatalog] = useState<AuthoringCapabilityCatalog | null>(null)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [briefCompilation, setBriefCompilation] = useState<CompiledBriefState | null>(null)
  const [clarificationAnswers, setClarificationAnswers] = useState<Record<number, string>>({})
  const [proposal, setProposal] = useState<WorkflowProposalResponse | null>(null)
  const [experienceAvailable, setExperienceAvailable] = useState(false)
  const [experienceName, setExperienceName] = useState('')
  const normalizedExperienceName = experienceName.trim()
  const experienceNameValid = !normalizedExperienceName || (new TextEncoder().encode(normalizedExperienceName).length <= 200
    && !normalizedExperienceName.includes('\0'))
  const [authoringError, setAuthoringError] = useState<string | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [catalogEpoch, setCatalogEpoch] = useState(0)
  const [authoringLoading, setAuthoringLoading] = useState<AuthoringLoading | null>(null)
  const [applied, setApplied] = useState(false)
  const [briefCompileMs, setBriefCompileMs] = useState<number | null>(null)
  const [proposalBuildMs, setProposalBuildMs] = useState<number | null>(null)
  const [currentLoading, setCurrentLoading] = useState<CurrentWorkflowLoading | null>(null)
  const [result, setResult] = useState<ResultState | null>(null)
  const promptRef = useRef<HTMLTextAreaElement | null>(null)
  const pendingPromptFocusRef = useRef(false)
  const starterPromptsRef = useRef(starterPrompts)
  const authoringRequestRef = useRef(0)
  const catalogRequestRef = useRef(0)
  const primaryStarterPromptRef = useRef(primaryStarterPrompt)
  primaryStarterPromptRef.current = primaryStarterPrompt
  const applyRequestRef = useRef(0)
  const currentRequestRef = useRef(0)
  const processedRequestRef = useRef<number | null>(null)
  const expectedAppliedWorkflowIDRef = useRef<string | null>(null)
  const proposalSourceRef = useRef<{ workflowId: string; revision: number } | null>(null)
  const requestedActionHandlersRef = useRef<{
    explain: () => Promise<void>
    review: () => Promise<void>
    fix: () => Promise<void>
  } | null>(null)
  const orgId = useWorkflowStore((state) => state.orgId)
  const userId = useWorkflowStore((state) => state.userId)
  const identityScope = `${orgId ?? ''}\u0000${userId ?? ''}`

  // Any edit to the intent discards the brief, the proposal and their timings:
  // they described a prompt that no longer exists.
  const replacePrompt = (next: string) => {
    authoringRequestRef.current += 1
    pendingPromptFocusRef.current = false
    // An invalidated compile/propose cannot clear its old loading in finally.
    // Apply owns a separate snapshot and must remain pending until it settles.
    setAuthoringLoading((loading) => loading === 'apply' ? loading : null)
    setPrompt(next)
    setExperienceName('')
    setExperienceAvailable(false)
    setBriefCompilation(null)
    setClarificationAnswers({})
    setProposal(null)
    setBriefCompileMs(null)
    setProposalBuildMs(null)
    setApplied(false)
    setAuthoringError(null)
  }

  const replaceExperienceName = (next: string) => {
    authoringRequestRef.current += 1
    setAuthoringLoading(loading => loading === 'apply' ? loading : null)
    setExperienceName(next)
    setProposal(null)
    proposalSourceRef.current = null
    setProposalBuildMs(null)
    setApplied(false)
    setAuthoringError(null)
  }

  const answerClarification = (index: number, value: string) => {
    setClarificationAnswers((current) => ({ ...current, [index]: value }))
  }

  // Store subscriptions observe the first authority change, including a
  // transient change batched back to the original values before React paints.
  useLayoutEffect(() => {
    const clearReview = () => {
      authoringRequestRef.current += 1
      currentRequestRef.current += 1
      proposalSourceRef.current = null
      setProposal(null)
      setProposalBuildMs(null)
      setExperienceAvailable(false)
      setExperienceName('')
      setClarificationAnswers({})
      setAuthoringError(null)
      setResult(null)
      setCurrentLoading(null)
    }
    const reloadCatalog = () => {
      catalogRequestRef.current += 1
      setCatalog(null)
      setCatalogError(null)
      setCatalogLoading(true)
      setCatalogEpoch(epoch => epoch + 1)
    }
    const unsubscribe = useWorkflowStore.subscribe((next, previous) => {
      if (currentAuthoringAuthority(next) === currentAuthoringAuthority(previous)) return
      const identityChanged = next.orgId !== previous.orgId || next.userId !== previous.userId
        || ['ai.write', 'workflows.read', 'workflows.write'].some(permission =>
          sessionCan(next.identityContext, permission) !== sessionCan(previous.identityContext, permission))
      const isExpectedApply = expectedAppliedWorkflowIDRef.current !== null
        && next.currentWorkflowId === expectedAppliedWorkflowIDRef.current
        && currentAuthoringAuthority({ ...next, currentWorkflowId: previous.currentWorkflowId,
          workflowRevision: previous.workflowRevision }) === currentAuthoringAuthority(previous)
      clearReview()
      setAuthoringLoading(loading => isExpectedApply && loading === 'apply' ? loading : null)
      if (!isExpectedApply) {
        applyRequestRef.current += 1
        expectedAppliedWorkflowIDRef.current = null
        pendingPromptFocusRef.current = false
        setApplied(false)
      }
      if (identityChanged) {
        // Prose and capability identities may not cross tenant/grant boundaries.
        setPrompt(primaryStarterPromptRef.current)
        setBriefCompilation(null)
        setBriefCompileMs(null)
        reloadCatalog()
      }
    })
    const unsubscribeTags = subscribeToTags(AUTHORING_EXPERIENCE_TAGS, () => {
      clearReview()
      // A resource change expires review, not an in-flight Apply's snapshot.
      // Its command boundary owns the result and the loading ends on settlement.
      setAuthoringLoading(loading => loading === 'apply' ? loading : null)
      reloadCatalog()
    })
    return () => {
      unsubscribe()
      unsubscribeTags()
      authoringRequestRef.current += 1
      catalogRequestRef.current += 1
      currentRequestRef.current += 1
      applyRequestRef.current += 1
      pendingPromptFocusRef.current = false
    }
  }, [])

  useEffect(() => {
    if (authoringLoading !== null) return
    const previousStarters = starterPromptsRef.current
    starterPromptsRef.current = starterPrompts
    const selectedStarterIndex = previousStarters.indexOf(prompt)
    const nextStarter = starterPrompts[selectedStarterIndex]
    if (selectedStarterIndex < 0 || !nextStarter || nextStarter === prompt) return
    replacePrompt(nextStarter)
  }, [authoringLoading, prompt, starterPrompts])

  useLayoutEffect(() => {
    let active = true
    const owner = new AbortController()
    const requestID = ++catalogRequestRef.current
    const ownsCatalog = () => !owner.signal.aborted && active && catalogRequestRef.current === requestID
    setCatalog(null)
    setCatalogLoading(true)
    setCatalogError(null)
    void onLoadAuthoringCapabilities(owner.signal)
      .then((nextCatalog) => {
        if (ownsCatalog()) setCatalog(nextCatalog)
      })
      .catch((error: unknown) => {
        if (ownsCatalog()) setCatalogError(error instanceof Error ? error.message : t('aiStudio.catalog.loadFailed'))
      })
      .finally(() => {
        if (ownsCatalog()) setCatalogLoading(false)
      })
    return () => { active = false; owner.abort() }
  }, [catalogEpoch, identityScope, onLoadAuthoringCapabilities, t])

  useLayoutEffect(() => {
    if (authoringLoading !== null || !pendingPromptFocusRef.current) return
    pendingPromptFocusRef.current = false
    promptRef.current?.focus()
  }, [authoringLoading, prompt])

  const compileBrief = async () => {
    const questions = briefCompilation?.clarifyingQuestions.slice(0, 3) ?? []
    const trimmed = composeAuthoringPrompt(prompt, questions, clarificationAnswers)
    if (!trimmed) return
    if (trimmed.length > MAX_AUTHORING_PROMPT_CHARS) {
      setAuthoringError(t('aiStudio.brief.tooLong', { max: MAX_AUTHORING_PROMPT_CHARS }))
      return
    }
    const startedAt = performance.now()
    // Keep every submitted clarification visible and cumulative, even if this
    // request fails or the compiler needs another round of missing details.
    replacePrompt(trimmed)
    const requestID = authoringRequestRef.current
    setAuthoringLoading('compile')
    try {
      const compiled = await onCompileWorkflowBrief(trimmed)
      if (authoringRequestRef.current !== requestID) return
      setBriefCompilation({ ...compiled, sourcePrompt: trimmed })
      setBriefCompileMs(Math.max(0, Math.round(performance.now() - startedAt)))
    } catch (error) {
      if (authoringRequestRef.current !== requestID) return
      setAuthoringError(error instanceof Error ? error.message : t('aiStudio.brief.failed'))
    } finally {
      if (authoringRequestRef.current === requestID) setAuthoringLoading(null)
    }
  }

  const buildProposal = async () => {
    if (!briefCompilation || !catalog || !experienceNameValid) return
    const source = useWorkflowStore.getState()
    const sourceWorkflow = { workflowId: source.currentWorkflowId, revision: source.workflowRevision }
    const requestID = ++authoringRequestRef.current
    const startedAt = performance.now()
    setAuthoringLoading('propose')
    setAuthoringError(null)
    setProposal(null)
    setProposalBuildMs(null)
    setApplied(false)
    try {
      const args = [briefCompilation.brief, catalog.version, briefCompilation.sourcePrompt] as const
      // Legacy requests keep their original wire shape. Only an explicit,
      // reviewed name edit asks for the closed descriptive adaptation path.
      const nextProposal = await (experienceAvailable && normalizedExperienceName
        ? onProposeWorkflow(...args, [{ field: 'workflow_name', value: normalizedExperienceName }])
        : onProposeWorkflow(...args))
      if (authoringRequestRef.current !== requestID) return
      const current = useWorkflowStore.getState()
      if (current.currentWorkflowId !== sourceWorkflow.workflowId || current.workflowRevision !== sourceWorkflow.revision) return
      proposalSourceRef.current = sourceWorkflow
      setProposal(nextProposal)
      setExperienceAvailable(nextProposal.experienceDecision?.mode === 'REUSE' || nextProposal.experienceDecision?.mode === 'ADAPT')
      setProposalBuildMs(Math.max(0, Math.round(performance.now() - startedAt)))
    } catch (error) {
      if (authoringRequestRef.current !== requestID) return
      setAuthoringError(error instanceof Error ? error.message : t('aiStudio.proposal.failed'))
    } finally {
      if (authoringRequestRef.current === requestID) setAuthoringLoading(null)
    }
  }

  const applyProposal = async () => {
    if (
      !proposal?.proposal.applicable
      || !proposal.bindings.complete
      || !catalog
      || proposal.bindings.catalogVersion !== catalog.version
    ) return
    const proposalToApply = proposal
    const proposalSource = proposalSourceRef.current
    const current = useWorkflowStore.getState()
    if (
      !proposalSource
      || current.currentWorkflowId !== proposalSource.workflowId
      || current.workflowRevision !== proposalSource.revision
    ) {
      proposalSourceRef.current = null
      setProposal(null)
      setApplied(false)
      return
    }
    const expectedWorkflowID = proposalToApply.proposal.workflow.id ?? 'ui-test'
    const requestID = ++applyRequestRef.current
    setAuthoringLoading('apply')
    setAuthoringError(null)
    try {
      expectedAppliedWorkflowIDRef.current = expectedWorkflowID
      const outcome = await onApplyWorkflowProposal(proposalToApply)
      if (applyRequestRef.current !== requestID) return
      if (outcome.status === 'catalog_changed') setCatalog(outcome.catalog)
      if (outcome.status !== 'applied') {
        expectedAppliedWorkflowIDRef.current = null
        setApplied(false)
        return
      }
      setApplied(true)
    } catch (error) {
      if (applyRequestRef.current !== requestID) return
      expectedAppliedWorkflowIDRef.current = null
      setAuthoringError(error instanceof Error ? error.message : t('aiStudio.apply.failed'))
    } finally {
      if (applyRequestRef.current === requestID) {
        if (expectedAppliedWorkflowIDRef.current === expectedWorkflowID) expectedAppliedWorkflowIDRef.current = null
        setAuthoringLoading(null)
      }
    }
  }

  const currentAction = async <Response,>(
    kind: CurrentWorkflowLoading,
    request: () => Promise<Response>,
    success: (response: Response) => ResultState,
    failure: (error: unknown) => ResultState,
  ) => {
    const requestID = ++currentRequestRef.current
    setCurrentLoading(kind)
    try {
      const response = await request()
      if (currentRequestRef.current === requestID) setResult(success(response))
    } catch (error) {
      if (currentRequestRef.current === requestID) setResult(failure(error))
    } finally {
      if (currentRequestRef.current === requestID) setCurrentLoading(null)
    }
  }

  const explain = () => currentAction('explain', onExplainWorkflow, response => ({
    kind: 'explanation',
    mode: response.mode,
    title: response.aiError
      ? t('aiStudio.explanationLocal', { name: workflowName })
      : t('aiStudio.explanationOk', { name: workflowName }),
    body: response.explanation,
    aiError: response.aiError,
  }), error => ({
    kind: 'explanation',
    mode: 'error',
    title: t('aiStudio.explanationFailed'),
    body: error instanceof Error ? error.message : t('aiStudio.explanationFailedBody'),
  }))

  const review = () => currentAction('review', onReviewWorkflow, response => ({
    kind: 'review',
    mode: response.mode,
    title: response.aiError
      ? t('aiStudio.reviewLocal', { name: workflowName })
      : t('aiStudio.reviewOk', { name: workflowName }),
    review: response.review,
    aiError: response.aiError,
  }), error => ({
    kind: 'review',
    mode: 'error',
    title: t('aiStudio.reviewFailed'),
    review: { status: 'fail', issues: [] },
    aiError: error instanceof Error ? error.message : t('aiStudio.reviewFailedBody'),
  }))

  const fix = () => currentAction('fix', onSuggestWorkflowImprovement, response => ({
    kind: 'fix',
    mode: response.mode,
    title: response.mode === 'ai' ? t('aiStudio.fixReady') : t('aiStudio.fixUnavailable'),
    suggestions: response.mode === 'ai' ? response.suggestions : [],
    aiError: response.aiError,
  }), error => ({
    kind: 'fix',
    mode: 'error',
    title: t('aiStudio.fixFailed'),
    suggestions: [],
    aiError: error instanceof Error ? error.message : t('aiStudio.fixFailedBody'),
  }))

  requestedActionHandlersRef.current = { explain, review, fix }

  useEffect(() => {
    if (!actionRequest || processedRequestRef.current === actionRequest.id) return
    processedRequestRef.current = actionRequest.id
    if (actionRequest.action === 'generate') {
      const prefill = actionRequest.prompt?.trim()
      if (prefill) replacePrompt(prefill.slice(0, MAX_AUTHORING_PROMPT_CHARS))
      if (promptRef.current?.disabled) pendingPromptFocusRef.current = true
      else promptRef.current?.focus()
      return
    }
    void requestedActionHandlersRef.current?.[actionRequest.action]()
  }, [actionRequest])

  return {
    health,
    workflowName,
    onApplyWorkflowImprovement,
    onViewCanvas,
    onOpenRuns,
    onOpenTemplates,
    starterPrompts,
    prompt,
    promptRef,
    replacePrompt,
    catalog,
    catalogError,
    catalogLoading,
    briefCompilation,
    clarificationAnswers,
    answerClarification,
    proposal,
    experienceAvailable,
    experienceName,
    experienceNameValid,
    replaceExperienceName,
    authoringError,
    authoringLoading,
    applied,
    currentLoading,
    result,
    compileBrief,
    buildProposal,
    applyProposal,
    explain,
    review,
    fix,
    briefCompileMs,
    proposalBuildMs,
  }
}
