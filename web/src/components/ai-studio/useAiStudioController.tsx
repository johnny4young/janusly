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
  onOpenRuns,
  onOpenTemplates,
}: AiStudioPanelProps) {
  const { t, i18n } = useT()
  const locale = i18n.resolvedLanguage
  const starterPrompts = useMemo(() => [
    t('aiStudio.starter1'),
    t('aiStudio.starter2'),
    t('aiStudio.starter3'),
  ], [locale, t])
  const primaryStarterPrompt = starterPrompts[0]

  const [prompt, setPrompt] = useState(primaryStarterPrompt)
  const [catalog, setCatalog] = useState<AuthoringCapabilityCatalog | null>(null)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [briefCompilation, setBriefCompilation] = useState<CompiledBriefState | null>(null)
  const [clarificationAnswers, setClarificationAnswers] = useState<Record<number, string>>({})
  const [proposal, setProposal] = useState<WorkflowProposalResponse | null>(null)
  const [authoringError, setAuthoringError] = useState<string | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(true)
  const [authoringLoading, setAuthoringLoading] = useState<AuthoringLoading | null>(null)
  const [applied, setApplied] = useState(false)
  const [briefCompileMs, setBriefCompileMs] = useState<number | null>(null)
  const [proposalBuildMs, setProposalBuildMs] = useState<number | null>(null)
  const [currentLoading, setCurrentLoading] = useState<CurrentWorkflowLoading | null>(null)
  const [result, setResult] = useState<ResultState | null>(null)
  const promptRef = useRef<HTMLTextAreaElement | null>(null)
  const starterPromptsRef = useRef(starterPrompts)
  const authoringRequestRef = useRef(0)
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
  const currentWorkflowId = useWorkflowStore((state) => state.currentWorkflowId)
  const workflowRevision = useWorkflowStore((state) => state.workflowRevision)
  const orgId = useWorkflowStore((state) => state.orgId)
  const userId = useWorkflowStore((state) => state.userId)
  const identityScope = `${orgId ?? ''}\u0000${userId ?? ''}`
  const previousIdentityScopeRef = useRef(identityScope)

  // Any edit to the intent discards the brief, the proposal and their timings:
  // they described a prompt that no longer exists.
  const replacePrompt = (next: string) => {
    authoringRequestRef.current += 1
    setPrompt(next)
    setBriefCompilation(null)
    setClarificationAnswers({})
    setProposal(null)
    setBriefCompileMs(null)
    setProposalBuildMs(null)
    setApplied(false)
    setAuthoringError(null)
  }

  const answerClarification = (index: number, value: string) => {
    setClarificationAnswers((current) => ({ ...current, [index]: value }))
  }

  // AI authoring state can contain tenant capability names and operator prose.
  // Clear it synchronously before paint when the authenticated identity or org
  // changes so neither data nor an actionable old catalog crosses the boundary.
  useLayoutEffect(() => {
    if (previousIdentityScopeRef.current === identityScope) return
    previousIdentityScopeRef.current = identityScope
    applyRequestRef.current += 1
    currentRequestRef.current += 1
    expectedAppliedWorkflowIDRef.current = null
    proposalSourceRef.current = null
    replacePrompt(primaryStarterPrompt)
    setResult(null)
    setAuthoringLoading(null)
    setCurrentLoading(null)
  }, [identityScope, primaryStarterPrompt])

  useEffect(() => {
    if (authoringLoading !== null) return
    const previousStarters = starterPromptsRef.current
    starterPromptsRef.current = starterPrompts
    const selectedStarterIndex = previousStarters.indexOf(prompt)
    const nextStarter = starterPrompts[selectedStarterIndex]
    if (selectedStarterIndex < 0 || !nextStarter || nextStarter === prompt) return
    replacePrompt(nextStarter)
    setAuthoringLoading(null)
  }, [authoringLoading, prompt, starterPrompts])

  useLayoutEffect(() => {
    let active = true
    setCatalog(null)
    setCatalogLoading(true)
    setCatalogError(null)
    void onLoadAuthoringCapabilities()
      .then((nextCatalog) => {
        if (active) setCatalog(nextCatalog)
      })
      .catch((error: unknown) => {
        if (active) setCatalogError(error instanceof Error ? error.message : t('aiStudio.catalog.loadFailed'))
      })
      .finally(() => {
        if (active) setCatalogLoading(false)
      })
    return () => { active = false }
  }, [identityScope, onLoadAuthoringCapabilities, t])

  // Proposals include a diff against the active canvas. Switching workflows or
  // editing the current canvas invalidates that diff and every prior analysis.
  useEffect(() => {
    const expectedAppliedWorkflowID = expectedAppliedWorkflowIDRef.current
    const isExpectedApply = expectedAppliedWorkflowID !== null && expectedAppliedWorkflowID === currentWorkflowId
    expectedAppliedWorkflowIDRef.current = null
    authoringRequestRef.current += 1
    currentRequestRef.current += 1
    if (!isExpectedApply) applyRequestRef.current += 1
    setAuthoringLoading((loading) => isExpectedApply && loading === 'apply' ? loading : null)
    setCurrentLoading(null)
    setResult(null)
    setProposal(null)
    setClarificationAnswers({})
    proposalSourceRef.current = null
    setAuthoringError(null)
    if (!isExpectedApply) setApplied(false)
  }, [currentWorkflowId, workflowRevision])

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
    if (!briefCompilation || !catalog) return
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
      const nextProposal = await onProposeWorkflow(
        briefCompilation.brief,
        catalog.version,
        briefCompilation.sourcePrompt,
      )
      if (authoringRequestRef.current !== requestID) return
      const current = useWorkflowStore.getState()
      if (current.currentWorkflowId !== sourceWorkflow.workflowId || current.workflowRevision !== sourceWorkflow.revision) return
      proposalSourceRef.current = sourceWorkflow
      setProposal(nextProposal)
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

  const explain = async () => {
    const requestID = ++currentRequestRef.current
    setCurrentLoading('explain')
    try {
      const response = await onExplainWorkflow()
      if (currentRequestRef.current !== requestID) return
      setResult({
        kind: 'explanation',
        mode: response.mode,
        title: response.aiError
          ? t('aiStudio.explanationLocal', { name: workflowName })
          : t('aiStudio.explanationOk', { name: workflowName }),
        body: response.explanation,
        aiError: response.aiError,
      })
    } catch (error) {
      if (currentRequestRef.current !== requestID) return
      setResult({
        kind: 'explanation',
        mode: 'error',
        title: t('aiStudio.explanationFailed'),
        body: error instanceof Error ? error.message : t('aiStudio.explanationFailedBody'),
      })
    } finally {
      if (currentRequestRef.current === requestID) setCurrentLoading(null)
    }
  }

  const review = async () => {
    const requestID = ++currentRequestRef.current
    setCurrentLoading('review')
    try {
      const response = await onReviewWorkflow()
      if (currentRequestRef.current !== requestID) return
      setResult({
        kind: 'review',
        mode: response.mode,
        title: response.aiError
          ? t('aiStudio.reviewLocal', { name: workflowName })
          : t('aiStudio.reviewOk', { name: workflowName }),
        review: response.review,
        aiError: response.aiError,
      })
    } catch (error) {
      if (currentRequestRef.current !== requestID) return
      setResult({
        kind: 'review',
        mode: 'error',
        title: t('aiStudio.reviewFailed'),
        review: { status: 'fail', issues: [] },
        aiError: error instanceof Error ? error.message : t('aiStudio.reviewFailedBody'),
      })
    } finally {
      if (currentRequestRef.current === requestID) setCurrentLoading(null)
    }
  }

  const fix = async () => {
    const requestID = ++currentRequestRef.current
    setCurrentLoading('fix')
    try {
      const response = await onSuggestWorkflowImprovement()
      if (currentRequestRef.current !== requestID) return
      setResult({
        kind: 'fix',
        mode: response.mode,
        title: response.mode === 'ai' ? t('aiStudio.fixReady') : t('aiStudio.fixUnavailable'),
        suggestions: response.mode === 'ai' ? response.suggestions : [],
        aiError: response.aiError,
      })
    } catch (error) {
      if (currentRequestRef.current !== requestID) return
      setResult({
        kind: 'fix',
        mode: 'error',
        title: t('aiStudio.fixFailed'),
        suggestions: [],
        aiError: error instanceof Error ? error.message : t('aiStudio.fixFailedBody'),
      })
    } finally {
      if (currentRequestRef.current === requestID) setCurrentLoading(null)
    }
  }

  requestedActionHandlersRef.current = { explain, review, fix }

  useEffect(() => {
    if (!actionRequest || processedRequestRef.current === actionRequest.id) return
    processedRequestRef.current = actionRequest.id
    if (actionRequest.action === 'generate') {
      const prefill = actionRequest.prompt?.trim()
      if (prefill) replacePrompt(prefill.slice(0, MAX_AUTHORING_PROMPT_CHARS))
      promptRef.current?.focus()
      return
    }
    void requestedActionHandlersRef.current?.[actionRequest.action]()
  }, [actionRequest])

  return {
    health,
    workflowName,
    onApplyWorkflowImprovement,
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
