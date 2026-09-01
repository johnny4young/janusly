/**
 * AI Studio is the governed, contract-first authoring surface.
 *
 * Authoring is intentionally split into four operations:
 * Intent Brief → Capability Binding → Proposal → explicit Apply.
 * A proposal never mutates the canvas. Apply only copies an exact, bound
 * proposal into an unsaved dirty draft; save, validate, and run stay separate.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Bot,
  BrainCircuit,
  CheckCircle2,
  GitBranch,
  KeyRound,
  MessageSquareText,
  RefreshCw,
  Route,
  ShieldCheck,
  Sparkles,
  Workflow,
  Wrench,
} from 'lucide-react'
import { formatAiModeLabel } from '../constants'
import type {
  AiAuthoringActionRequest,
  AiHealth,
  AiMode,
  AuthoringCapabilityCatalog,
  ReviewFindings,
  WorkflowBriefCompilation,
  WorkflowImprovementResult,
  WorkflowImprovementSuggestion,
  WorkflowIntentBrief,
  WorkflowProposalResponse,
} from '../types'
import { estimatePromptCostUsd, formatEstimateLabel } from '@/lib/llm-pricing'
import { tAiReviewIssue, useT } from '../i18n'
import { useWorkflowStore } from '../store'
import { BrandMark } from './BrandMark'
import { Button } from './ui/Button'
import { FormActions, FormDisclosure, FormField } from './ui/Form'
import { StatusSummary } from './ui/StatusSummary'

const ASSUMED_TOKEN_BUDGETS: Record<'proposal' | 'explain' | 'review' | 'fix', { input: number; output: number }> = {
  proposal: { input: 4_000, output: 2_000 },
  explain: { input: 2_000, output: 1_000 },
  review: { input: 4_000, output: 1_500 },
  fix: { input: 5_000, output: 2_000 },
}

type AiStudioPanelProps = {
  health: AiHealth | null
  workflowName: string
  onLoadAuthoringCapabilities: () => Promise<AuthoringCapabilityCatalog>
  onCompileWorkflowBrief: (prompt: string) => Promise<WorkflowBriefCompilation>
  onProposeWorkflow: (brief: WorkflowIntentBrief, catalogVersion: string) => Promise<WorkflowProposalResponse>
  onApplyWorkflowProposal: (proposal: WorkflowProposalResponse) => Promise<boolean>
  onExplainWorkflow: () => Promise<{ mode: AiMode; explanation: string; model?: string; aiError?: string }>
  onReviewWorkflow: () => Promise<{ mode: AiMode; review: ReviewFindings; model?: string; aiError?: string }>
  actionRequest: AiAuthoringActionRequest | null
  onSuggestWorkflowImprovement: () => Promise<WorkflowImprovementResult>
  onApplyWorkflowImprovement: (suggestion: WorkflowImprovementSuggestion) => Promise<boolean>
  onOpenRuns: () => void
  onOpenTemplates: () => void
}

type AuthoringLoading = 'catalog' | 'compile' | 'propose' | 'apply'
type CurrentWorkflowLoading = 'explain' | 'review' | 'fix'
type ResultState =
  | { kind: 'explanation'; mode: AiMode; title: string; body: string; aiError?: string }
  | { kind: 'review'; mode: AiMode; title: string; review: ReviewFindings; aiError?: string }
  | { kind: 'fix'; mode: AiMode; title: string; suggestions: WorkflowImprovementSuggestion[]; aiError?: string }

const MODE_COPY_KEYS: Record<AiMode, string> = {
  ai: 'aiStudio.modeCopy.ai',
  fallback: 'aiStudio.modeCopy.fallback',
  error: 'aiStudio.modeCopy.error',
}

const SIGNAL_COPY_KEYS: Record<string, string> = {
  manual_trigger: 'aiStudio.proposal.signal.manualTrigger',
  deterministic_template: 'aiStudio.proposal.signal.deterministicTemplate',
  provider_output_guarded: 'aiStudio.proposal.signal.providerOutputGuarded',
  missing_capability_binding: 'aiStudio.proposal.signal.missingBinding',
  external_effect_without_declared_approval: 'aiStudio.proposal.signal.externalEffectApproval',
  readiness_blocked: 'aiStudio.proposal.signal.readinessBlocked',
  readiness_warning: 'aiStudio.proposal.signal.readinessWarning',
}

function totalCatalogCapabilities(catalog: AuthoringCapabilityCatalog): number {
  return catalog.builtinTools.length
    + catalog.mcpTools.length
    + catalog.triggers.length
    + catalog.credentials.length
    + catalog.subworkflows.length
    + catalog.primitives.length
}

export function AiStudioPanel({
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
  const starterPrompts = [
    t('aiStudio.starter1'),
    t('aiStudio.starter2'),
    t('aiStudio.starter3'),
  ]

  const [prompt, setPrompt] = useState(starterPrompts[0])
  const [catalog, setCatalog] = useState<AuthoringCapabilityCatalog | null>(null)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [briefCompilation, setBriefCompilation] = useState<WorkflowBriefCompilation | null>(null)
  const [proposal, setProposal] = useState<WorkflowProposalResponse | null>(null)
  const [authoringError, setAuthoringError] = useState<string | null>(null)
  const [authoringLoading, setAuthoringLoading] = useState<AuthoringLoading | null>('catalog')
  const [applied, setApplied] = useState(false)
  const [currentLoading, setCurrentLoading] = useState<CurrentWorkflowLoading | null>(null)
  const [result, setResult] = useState<ResultState | null>(null)
  const promptRef = useRef<HTMLTextAreaElement | null>(null)
  const processedRequestRef = useRef<number | null>(null)
  const skipNextWorkflowResetRef = useRef(false)
  const requestedActionHandlersRef = useRef<{
    explain: () => Promise<void>
    review: () => Promise<void>
    fix: () => Promise<void>
  } | null>(null)
  const currentWorkflowId = useWorkflowStore((state) => state.currentWorkflowId)

  useEffect(() => {
    let active = true
    setAuthoringLoading('catalog')
    setCatalogError(null)
    void onLoadAuthoringCapabilities()
      .then((nextCatalog) => {
        if (active) setCatalog(nextCatalog)
      })
      .catch((error: unknown) => {
        if (active) setCatalogError(error instanceof Error ? error.message : t('aiStudio.catalog.loadFailed'))
      })
      .finally(() => {
        if (active) setAuthoringLoading((loading) => loading === 'catalog' ? null : loading)
      })
    return () => { active = false }
  }, [onLoadAuthoringCapabilities, t])

  // Proposals include a diff against the active canvas. Switching workflows
  // invalidates that diff and every analysis of the old flow.
  useEffect(() => {
    setResult(null)
    setProposal(null)
    setAuthoringError(null)
    if (skipNextWorkflowResetRef.current) {
      skipNextWorkflowResetRef.current = false
      return
    }
    setApplied(false)
  }, [currentWorkflowId])

  const healthLabel = health?.enabled ? t('aiStudio.healthOn') : t('aiStudio.healthOff')
  const healthDetail = health?.enabled
    ? t('aiStudio.healthDetailOn', { model: health.model })
    : t('aiStudio.healthDetailOff')

  function describeAiError(message: string): string {
    if (/quota|billing|insufficient_quota/i.test(message)) return t('aiStudio.aiError.quota')
    if (/rate limit/i.test(message)) return t('aiStudio.aiError.rate')
    if (/invalid api key|incorrect api key|unauthorized/i.test(message)) return t('aiStudio.aiError.auth')
    return message
  }

  const useCases = useMemo(() => [
    {
      icon: <Workflow size={16} />,
      title: t('aiStudio.useCase.prompt.title'),
      body: t('aiStudio.useCase.prompt.body'),
      state: health?.enabled ? t('aiStudio.useCase.prompt.stateOn') : t('aiStudio.useCase.prompt.stateOff'),
    },
    {
      icon: <MessageSquareText size={16} />,
      title: t('aiStudio.useCase.explain.title'),
      body: t('aiStudio.useCase.explain.body'),
      state: health?.enabled ? t('aiStudio.useCase.prompt.stateOn') : t('aiStudio.useCase.explain.stateOff'),
    },
    {
      icon: <Bot size={16} />,
      title: t('aiStudio.useCase.explainRun.title'),
      body: t('aiStudio.useCase.explainRun.body'),
      state: health?.enabled ? t('aiStudio.useCase.explainRun.stateOn') : t('aiStudio.useCase.explainRun.stateOff'),
    },
    {
      icon: <BrainCircuit size={16} />,
      title: t('aiStudio.useCase.agent.title'),
      body: t('aiStudio.useCase.agent.body'),
      state: health?.enabled ? t('aiStudio.useCase.agent.stateOn') : t('aiStudio.useCase.agent.stateOff'),
    },
    {
      icon: <Route size={16} />,
      title: t('aiStudio.useCase.causal.title'),
      body: t('aiStudio.useCase.causal.body'),
      state: t('aiStudio.useCase.causal.alwaysOn'),
    },
  ], [health?.enabled, locale, t])

  const readinessSteps = useMemo(() => [
    {
      icon: <KeyRound size={15} />,
      title: t('aiStudio.readiness.envTitle'),
      body: t('aiStudio.readiness.envBody'),
      ready: Boolean(health?.enabled),
    },
    {
      icon: <RefreshCw size={15} />,
      title: t('aiStudio.readiness.restartTitle'),
      body: t('aiStudio.readiness.restartBody'),
      ready: Boolean(health),
    },
    {
      icon: <CheckCircle2 size={15} />,
      title: t('aiStudio.readiness.healthTitle'),
      body: health?.enabled
        ? t('aiStudio.readiness.healthBodyOn', { model: health.model })
        : t('aiStudio.readiness.healthBodyOff'),
      ready: Boolean(health?.enabled),
    },
  ], [health, locale, t])

  const compileBrief = async () => {
    const trimmed = prompt.trim()
    if (!trimmed) return
    setAuthoringLoading('compile')
    setAuthoringError(null)
    setProposal(null)
    setApplied(false)
    try {
      setBriefCompilation(await onCompileWorkflowBrief(trimmed))
    } catch (error) {
      setAuthoringError(error instanceof Error ? error.message : t('aiStudio.brief.failed'))
    } finally {
      setAuthoringLoading(null)
    }
  }

  const buildProposal = async () => {
    if (!briefCompilation || !catalog) return
    setAuthoringLoading('propose')
    setAuthoringError(null)
    setProposal(null)
    setApplied(false)
    try {
      setProposal(await onProposeWorkflow(briefCompilation.brief, catalog.version))
    } catch (error) {
      setAuthoringError(error instanceof Error ? error.message : t('aiStudio.proposal.failed'))
    } finally {
      setAuthoringLoading(null)
    }
  }

  const applyProposal = async () => {
    if (!proposal?.proposal.applicable || !proposal.bindings.complete) return
    setAuthoringLoading('apply')
    setAuthoringError(null)
    skipNextWorkflowResetRef.current = true
    try {
      const didApply = await onApplyWorkflowProposal(proposal)
      if (!didApply) skipNextWorkflowResetRef.current = false
      setApplied(didApply)
    } catch (error) {
      skipNextWorkflowResetRef.current = false
      setAuthoringError(error instanceof Error ? error.message : t('aiStudio.apply.failed'))
    } finally {
      setAuthoringLoading(null)
    }
  }

  const explain = async () => {
    setCurrentLoading('explain')
    try {
      const response = await onExplainWorkflow()
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
      setResult({
        kind: 'explanation',
        mode: 'error',
        title: t('aiStudio.explanationFailed'),
        body: error instanceof Error ? error.message : t('aiStudio.explanationFailedBody'),
      })
    } finally {
      setCurrentLoading(null)
    }
  }

  const review = async () => {
    setCurrentLoading('review')
    try {
      const response = await onReviewWorkflow()
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
      setResult({
        kind: 'review',
        mode: 'error',
        title: t('aiStudio.reviewFailed'),
        review: { status: 'fail', issues: [] },
        aiError: error instanceof Error ? error.message : t('aiStudio.reviewFailedBody'),
      })
    } finally {
      setCurrentLoading(null)
    }
  }

  const fix = async () => {
    setCurrentLoading('fix')
    try {
      const response = await onSuggestWorkflowImprovement()
      setResult({
        kind: 'fix',
        mode: response.mode,
        title: response.mode === 'ai' ? t('aiStudio.fixReady') : t('aiStudio.fixUnavailable'),
        suggestions: response.mode === 'ai' ? response.suggestions : [],
        aiError: response.aiError,
      })
    } catch (error) {
      setResult({
        kind: 'fix',
        mode: 'error',
        title: t('aiStudio.fixFailed'),
        suggestions: [],
        aiError: error instanceof Error ? error.message : t('aiStudio.fixFailedBody'),
      })
    } finally {
      setCurrentLoading(null)
    }
  }

  requestedActionHandlersRef.current = { explain, review, fix }

  useEffect(() => {
    if (!actionRequest || processedRequestRef.current === actionRequest.id) return
    processedRequestRef.current = actionRequest.id
    if (actionRequest.action === 'generate') {
      promptRef.current?.focus()
      return
    }
    void requestedActionHandlersRef.current?.[actionRequest.action]()
  }, [actionRequest])

  const reviewSummary = (reviewFindings: ReviewFindings, mode: AiMode): string => {
    if (mode === 'error') return t('aiStudio.reviewError')
    if (reviewFindings.status === 'pass') return t('aiStudio.reviewPass')
    if (reviewFindings.status === 'warn') return t('aiStudio.reviewWarn', { count: reviewFindings.issues.length })
    const blockerCount = reviewFindings.issues.filter((issue) => issue.severity === 'fail').length
    return t('aiStudio.reviewFail', { count: blockerCount })
  }

  const bindingComplete = Boolean(proposal?.bindings.complete)
  const proposalApplicable = Boolean(proposal?.proposal.applicable && bindingComplete)
  const authoringSteps = [
    { label: t('aiStudio.steps.intent'), complete: Boolean(briefCompilation) },
    { label: t('aiStudio.steps.binding'), complete: bindingComplete },
    { label: t('aiStudio.steps.proposal'), complete: Boolean(proposal) },
    { label: t('aiStudio.steps.apply'), complete: applied },
  ]

  return (
    <div className="panel-stack">
      <section className="ai-studio-hero ai-studio-hero--branded">
        <div>
          <span className={health?.enabled ? 'mode-pill mode-pill-ai' : 'mode-pill mode-pill-fallback'}>
            {healthLabel}
          </span>
          <h2>{t('aiStudio.heroTitle')}</h2>
          <p>{healthDetail}</p>
        </div>
        <BrandMark size={44} />
      </section>

      <ol className="ai-authoring-steps" aria-label={t('aiStudio.steps.aria')}>
        {authoringSteps.map((step, index) => (
          <li
            key={step.label}
            className={step.complete ? 'ai-authoring-step ai-authoring-step--complete' : 'ai-authoring-step'}
          >
            <span aria-hidden="true">{index + 1}</span>
            <strong>{step.label}</strong>
          </li>
        ))}
      </ol>

      <section className="we-card ai-authoring-stage">
        <div className="split-row">
          <div>
            <div className="section-kicker">{t('aiStudio.steps.intent')}</div>
            <strong>{t('aiStudio.tellHeading')}</strong>
          </div>
          <span className="mode-pill mode-pill-neutral">{t('aiStudio.brief.localCompiler')}</span>
        </div>

        <FormField
          id="ai-authoring-intent"
          label={t('aiStudio.brief.promptLabel')}
          hint={t('aiStudio.brief.promptHint')}
          required
        >
          {(controlProps) => (
            <textarea
              {...controlProps}
              ref={promptRef}
              className="ai-studio-prompt"
              value={prompt}
              disabled={authoringLoading === 'compile'}
              onChange={(event) => {
                setPrompt(event.target.value)
                setBriefCompilation(null)
                setProposal(null)
                setApplied(false)
              }}
              placeholder={t('aiStudio.placeholder')}
            />
          )}
        </FormField>

        <div className="suggestion-row" aria-label={t('aiStudio.examplesAria')}>
          {starterPrompts.map((starter) => (
            <Button
              key={starter}
              size="sm"
              variant="ghost"
              onClick={() => {
                setPrompt(starter)
                setBriefCompilation(null)
                setProposal(null)
                setApplied(false)
              }}
            >
              {starter.slice(0, 34)}…
            </Button>
          ))}
        </div>

        <FormActions>
          <Button
            variant="primary"
            leadingIcon={<Sparkles size={16} />}
            loading={authoringLoading === 'compile'}
            loadingLabel={t('aiStudio.brief.compiling')}
            disabled={!prompt.trim()}
            onClick={() => { void compileBrief() }}
          >
            {t('aiStudio.brief.compile')}
          </Button>
        </FormActions>

        {briefCompilation && (
          <div className="ai-brief-summary" data-testid="intent-brief">
            <dl>
              <div><dt>{t('aiStudio.brief.objective')}</dt><dd>{briefCompilation.brief.objective}</dd></div>
              <div><dt>{t('aiStudio.brief.trigger')}</dt><dd>{briefCompilation.brief.trigger}</dd></div>
              <div><dt>{t('aiStudio.brief.outcome')}</dt><dd>{briefCompilation.brief.expectedOutcome}</dd></div>
              <div><dt>{t('aiStudio.brief.failurePolicy')}</dt><dd>{briefCompilation.brief.failurePolicy}</dd></div>
            </dl>
            {briefCompilation.clarifyingQuestions.length > 0 && (
              <StatusSummary
                tone="info"
                title={t('aiStudio.brief.questions')}
                description={(
                  <ol className="ai-brief-questions">
                    {briefCompilation.clarifyingQuestions.slice(0, 3).map((question) => (
                      <li key={question}>{question}</li>
                    ))}
                  </ol>
                )}
              />
            )}
            <FormDisclosure summary={t('aiStudio.brief.details')}>
              <dl>
                <div><dt>{t('aiStudio.brief.inputs')}</dt><dd>{briefCompilation.brief.inputs.join(', ') || t('common.none')}</dd></div>
                <div><dt>{t('aiStudio.brief.effects')}</dt><dd>{briefCompilation.brief.externalEffects.join(', ') || t('common.none')}</dd></div>
                <div><dt>{t('aiStudio.brief.approvals')}</dt><dd>{briefCompilation.brief.approvals.join(', ') || t('common.none')}</dd></div>
                <div><dt>{t('aiStudio.brief.examples')}</dt><dd>{briefCompilation.brief.examples.join(', ') || t('common.none')}</dd></div>
              </dl>
            </FormDisclosure>
          </div>
        )}
      </section>

      <section className="we-card ai-authoring-stage">
        <div className="split-row">
          <div>
            <div className="section-kicker">{t('aiStudio.steps.binding')}</div>
            <strong>{t('aiStudio.binding.heading')}</strong>
          </div>
          {catalog && (
            <span className="mode-pill mode-pill-neutral">
              {t('aiStudio.catalog.count', { count: totalCatalogCapabilities(catalog) })}
            </span>
          )}
        </div>

        {authoringLoading === 'catalog' && <StatusSummary title={t('aiStudio.catalog.loading')} />}
        {catalogError && (
          <StatusSummary
            role="alert"
            tone="danger"
            title={t('aiStudio.catalog.loadFailed')}
            description={catalogError}
          />
        )}
        {catalog && (
          <>
            <dl className="ai-catalog-summary" data-testid="capability-catalog-summary">
              <div><dt>{t('aiStudio.catalog.tools')}</dt><dd>{catalog.builtinTools.length}</dd></div>
              <div><dt>{t('aiStudio.catalog.mcp')}</dt><dd>{catalog.mcpTools.length}</dd></div>
              <div><dt>{t('aiStudio.catalog.credentials')}</dt><dd>{catalog.credentials.length}</dd></div>
              <div><dt>{t('aiStudio.catalog.workflows')}</dt><dd>{catalog.subworkflows.length}</dd></div>
            </dl>
            {catalog.warnings.length > 0 && (
              <StatusSummary
                tone="warning"
                icon={<AlertTriangle size={16} />}
                title={t('aiStudio.catalog.degraded')}
                description={catalog.warnings.join(' · ')}
              />
            )}
          </>
        )}

        {proposal && (
          <div className="ai-binding-report" data-testid="capability-binding-report">
            <StatusSummary
              tone={proposal.bindings.complete ? 'success' : 'warning'}
              title={proposal.bindings.complete ? t('aiStudio.binding.complete') : t('aiStudio.binding.incomplete')}
              description={t('aiStudio.binding.summary', {
                resolved: proposal.bindings.resolved.length,
                missing: proposal.bindings.missing.length,
              })}
            />
            {proposal.bindings.resolved.length > 0 && (
              <FormDisclosure summary={t('aiStudio.binding.resolved')}>
                <ul>
                  {proposal.bindings.resolved.map((binding, index) => (
                    <li key={[binding.nodeId, binding.field, index].join('-')}>
                      <strong>{binding.nodeId}</strong>
                      <span>{binding.resolvedId ?? binding.requested}</span>
                    </li>
                  ))}
                </ul>
              </FormDisclosure>
            )}
            {proposal.bindings.missing.map((binding, index) => (
              <article className="ai-binding-missing" key={[binding.nodeId, binding.field, index].join('-')}>
                <strong>
                  {t('aiStudio.binding.missingAt', { node: binding.nodeId || t('common.unknown'), field: binding.field })}
                </strong>
                <span>{binding.requested ?? binding.reason ?? t('common.unknown')}</span>
                {binding.alternatives.length > 0 && (
                  <small>{t('aiStudio.binding.alternatives', { alternatives: binding.alternatives.join(', ') })}</small>
                )}
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="we-card ai-authoring-stage">
        <div className="split-row">
          <div>
            <div className="section-kicker">{t('aiStudio.steps.proposal')}</div>
            <strong>{t('aiStudio.proposal.heading')}</strong>
          </div>
          {proposal && (
            <span className={'mode-pill mode-pill-' + proposal.mode}>
              {formatAiModeLabel(proposal.mode)}
            </span>
          )}
        </div>

        <p className="helper-text">{t('aiStudio.proposal.body')}</p>
        <FormActions>
          <Button
            variant="primary"
            leadingIcon={<Workflow size={16} />}
            loading={authoringLoading === 'propose'}
            loadingLabel={t('aiStudio.proposal.building')}
            disabled={!briefCompilation || !catalog}
            onClick={() => { void buildProposal() }}
            trailingIcon={<CostEstimateChip action="proposal" model={health?.model} />}
          >
            {t('aiStudio.proposal.build')}
          </Button>
        </FormActions>

        {proposal && (
          <div className="ai-proposal" data-testid="workflow-proposal">
            {proposal.providerGuarded ? (
              <div data-testid="provider-output-guarded">
                <StatusSummary
                  role="status"
                  tone="warning"
                  title={t('aiStudio.proposal.guardedTitle')}
                  description={t('aiStudio.proposal.guardedBody')}
                />
              </div>
            ) : proposal.mode === 'fallback' && (
              <StatusSummary
                role="status"
                tone="info"
                title={t('aiStudio.proposal.localTitle')}
                description={t('aiStudio.proposal.localBody')}
              />
            )}
            {proposal.aiError && (
              <StatusSummary
                role="status"
                tone="warning"
                title={t('aiStudio.aiFailedTitle')}
                description={describeAiError(proposal.aiError)}
              />
            )}
            {proposal.bonBackoff && (
              <div data-testid="ai-candidate-backoff">
                <StatusSummary
                  role="status"
                  tone="warning"
                  title={t('aiStudio.backoff.title')}
                  description={t('aiStudio.backoff.body', proposal.bonBackoff)}
                />
              </div>
            )}
            <dl className="ai-proposal-facts">
              <div><dt>{t('aiStudio.proposal.readiness')}</dt><dd>{proposal.proposal.readiness.status}</dd></div>
              <div><dt>{t('aiStudio.proposal.nodes')}</dt><dd>{proposal.proposal.workflow.nodes.length}</dd></div>
              <div><dt>{t('aiStudio.proposal.edges')}</dt><dd>{proposal.proposal.workflow.edges.length}</dd></div>
              <div>
                <dt>{t('aiStudio.proposal.diff')}</dt>
                <dd>{t('aiStudio.proposal.diffValue', {
                  added: proposal.proposal.diff.nodesAdded.length,
                  changed: proposal.proposal.diff.nodesChanged.length,
                  removed: proposal.proposal.diff.nodesRemoved.length,
                })}</dd>
              </div>
            </dl>

            <div className="ai-assurance-summary" role="status" data-testid="workflow-assurance-summary">
              <span className="helper-text">{t('aiStudio.assurance.heading')}</span>
              {proposal.proposal.qualification.intent && <span className="mode-pill mode-pill-ai">{t('aiStudio.assurance.intent')}</span>}
              {proposal.proposal.qualification.recovery && <span className="mode-pill mode-pill-ai">{t('aiStudio.assurance.recovery')}</span>}
              {proposal.proposal.qualification.semantic && <span className="mode-pill mode-pill-ai">{t('aiStudio.assurance.qualification')}</span>}
            </div>

            {proposal.proposal.readiness.issues.length > 0 && (
              <FormDisclosure summary={t('aiStudio.proposal.readinessIssues')}>
                <ul className="ai-proposal-issues">
                  {proposal.proposal.readiness.issues.map((issue, index) => (
                    <li key={[issue.code, index].join('-')}>
                      <strong>{issue.code}</strong>
                      <span>{issue.message}</span>
                      {issue.suggestion && <small>{issue.suggestion}</small>}
                    </li>
                  ))}
                </ul>
              </FormDisclosure>
            )}

            {(proposal.proposal.assumptions.length > 0 || proposal.proposal.risks.length > 0) && (
              <FormDisclosure summary={t('aiStudio.proposal.assumptionsRisks')}>
                <ul className="ai-proposal-signals">
                  {[...proposal.proposal.assumptions, ...proposal.proposal.risks].map((signal) => (
                    <li key={signal}>{t(SIGNAL_COPY_KEYS[signal] ?? 'aiStudio.proposal.signal.other', { signal })}</li>
                  ))}
                </ul>
              </FormDisclosure>
            )}
          </div>
        )}
      </section>

      <section className="we-card ai-authoring-stage ai-proposal-apply">
        <div>
          <div className="section-kicker">{t('aiStudio.steps.apply')}</div>
          <strong>{t('aiStudio.apply.heading')}</strong>
          <p className="helper-text">{t('aiStudio.apply.body')}</p>
        </div>
        {proposal && !proposalApplicable && (
          <StatusSummary
            role="status"
            tone="warning"
            title={t('aiStudio.apply.blocked')}
            description={t('aiStudio.apply.blockedBody')}
          />
        )}
        {applied && (
          <StatusSummary
            role="status"
            tone="success"
            title={t('aiStudio.apply.applied')}
            description={t('aiStudio.apply.appliedBody')}
          />
        )}
        <FormActions>
          <Button
            variant="primary"
            leadingIcon={<CheckCircle2 size={16} />}
            loading={authoringLoading === 'apply'}
            loadingLabel={t('aiStudio.apply.applying')}
            disabled={!proposalApplicable}
            onClick={() => { void applyProposal() }}
          >
            {t('aiStudio.apply.action')}
          </Button>
        </FormActions>
      </section>

      {authoringError && (
        <StatusSummary role="alert" tone="danger" title={t('aiStudio.authoring.failed')} description={authoringError} />
      )}

      <section className="we-card">
        <div className="split-row">
          <div>
            <div className="section-kicker">{t('aiStudio.current.heading')}</div>
            <strong>{workflowName}</strong>
          </div>
          <span className={health?.enabled ? 'mode-pill mode-pill-ai' : 'mode-pill mode-pill-neutral'}>
            {health?.enabled ? health.model : t('aiStudio.localRules')}
          </span>
        </div>
        <p className="helper-text">{t('aiStudio.current.body')}</p>
        <FormActions>
          <Button
            leadingIcon={<CheckCircle2 size={16} />}
            loading={currentLoading === 'explain'}
            loadingLabel={t('aiStudio.explaining')}
            onClick={() => { void explain() }}
            trailingIcon={<CostEstimateChip action="explain" model={health?.model} />}
          >
            {t('aiStudio.explain')}
          </Button>
          <Button
            leadingIcon={<ShieldCheck size={16} />}
            loading={currentLoading === 'review'}
            loadingLabel={t('aiStudio.reviewing')}
            onClick={() => { void review() }}
            trailingIcon={<CostEstimateChip action="review" model={health?.model} />}
          >
            {t('aiStudio.review')}
          </Button>
          <Button
            leadingIcon={<Wrench size={16} />}
            loading={currentLoading === 'fix'}
            loadingLabel={t('aiStudio.fixing')}
            onClick={() => { void fix() }}
            trailingIcon={<CostEstimateChip action="fix" model={health?.model} />}
          >
            {t('aiStudio.fix')}
          </Button>
        </FormActions>
      </section>

      {/* Persistently mounted so assistive technology announces async results. */}
      <div className="ai-ai-studio__results" aria-live="polite">
        {result?.kind === 'explanation' && (
          <section className="we-card result-panel">
            <div className="split-row">
              <strong>{result.title}</strong>
              <span className={'mode-pill mode-pill-' + result.mode}>{formatAiModeLabel(result.mode)}</span>
            </div>
            {result.mode === 'fallback' && (
              <StatusSummary
                role="status"
                tone="info"
                title={t('aiStudio.fallbackBannerTitle')}
                description={t('aiStudio.fallbackBannerBody')}
              />
            )}
            <p className="helper-text">{t(MODE_COPY_KEYS[result.mode])}</p>
            <div className="result-body">{result.body}</div>
            {result.aiError && (
              <StatusSummary
                role="status"
                tone="warning"
                title={t('aiStudio.aiFailedTitle')}
                description={describeAiError(result.aiError)}
              />
            )}
          </section>
        )}

        {result?.kind === 'review' && (
          <section className="we-card result-panel">
            <div className="split-row">
              <strong>{result.title}</strong>
              <span className={'mode-pill mode-pill-' + result.mode}>{formatAiModeLabel(result.mode)}</span>
            </div>
            <p className="helper-text">{reviewSummary(result.review, result.mode)}</p>
            {result.aiError && (
              <StatusSummary
                role="status"
                tone={result.mode === 'error' ? 'danger' : 'warning'}
                title={result.mode === 'error' ? t('aiStudio.reviewErrorTitle') : t('aiStudio.reviewFallbackTitle')}
                description={describeAiError(result.aiError)}
              />
            )}
            {result.review.issues.length > 0 && (
              <ul className="we-readiness-badge__issues ai-review-issues">
                {result.review.issues.map((issue, index) => (
                  <li key={[issue.code, index].join('-')} className={'we-readiness-issue we-readiness-issue--' + (issue.severity === 'info' ? 'warn' : issue.severity)}>
                    <strong className="we-readiness-issue__code">{issue.code}</strong>
                    {issue.nodeId && <span className="we-readiness-issue__node"> · {issue.nodeId}</span>}
                    {issue.edgeId && <span className="we-readiness-issue__node"> · {issue.edgeId}</span>}
                    <p className="we-readiness-issue__message">{tAiReviewIssue(issue)}</p>
                    <p className="we-readiness-issue__suggestion">{t('aiStudio.reviewWhy', { rationale: issue.rationale })}</p>
                    <p className="we-readiness-issue__suggestion">{t('aiStudio.reviewFix', { suggestion: issue.suggestion })}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {result?.kind === 'fix' && (
          <section className="we-card result-panel">
            <div className="split-row">
              <strong>{result.title}</strong>
              <span className={'mode-pill mode-pill-' + result.mode}>{formatAiModeLabel(result.mode)}</span>
            </div>
            {result.suggestions.length > 0 ? (
              <div className="ai-fix-list">
                {result.suggestions.map((suggestion, index) => (
                  <article className="ai-fix-card" key={[suggestion.approachLabel, index].join('-')}>
                    <div className="split-row">
                      <strong>{suggestion.approachLabel}</strong>
                      <span className="mode-pill mode-pill-neutral">
                        {t('aiStudio.fixConfidence', { percent: Math.round(suggestion.confidence * 100) })}
                      </span>
                    </div>
                    <p>{suggestion.rationale}</p>
                    <Button
                      size="sm"
                      variant="primary"
                      leadingIcon={<Wrench size={13} />}
                      onClick={() => { void onApplyWorkflowImprovement(suggestion) }}
                    >
                      {t('aiStudio.fixApply')}
                    </Button>
                  </article>
                ))}
              </div>
            ) : (
              <p className="helper-text">{t('aiStudio.fixNoSuggestion')}</p>
            )}
            {result.aiError && (
              <StatusSummary
                role="status"
                tone={result.mode === 'error' ? 'danger' : 'warning'}
                title={t('aiStudio.aiFailedTitle')}
                description={describeAiError(result.aiError)}
              />
            )}
          </section>
        )}
      </div>

      <section className="we-card">
        <div className="section-kicker">{t('aiStudio.useCases')}</div>
        <div className="usecase-list">
          {useCases.map((useCase) => (
            <div key={useCase.title} className="usecase-row">
              <div className="usecase-icon">{useCase.icon}</div>
              <div>
                <strong>{useCase.title}</strong>
                <p>{useCase.body}</p>
              </div>
              <span className="mode-pill mode-pill-neutral">{useCase.state}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="we-card">
        <div className="section-kicker">{t('aiStudio.readiness.heading')}</div>
        <div className="usecase-list">
          {readinessSteps.map((step) => (
            <div key={step.title} className="usecase-row">
              <div className={step.ready ? 'usecase-icon usecase-icon-ready' : 'usecase-icon'}>{step.icon}</div>
              <div>
                <strong>{step.title}</strong>
                <p>{step.body}</p>
              </div>
              <span className={step.ready ? 'mode-pill mode-pill-ai' : 'mode-pill mode-pill-neutral'}>
                {step.ready ? t('aiStudio.readiness.ready') : t('aiStudio.readiness.check')}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="ai-studio-secondary-actions">
        <Button leadingIcon={<MessageSquareText size={16} />} onClick={onOpenRuns}>
          {t('aiStudio.askAboutRun')}
        </Button>
        <Button leadingIcon={<GitBranch size={16} />} onClick={onOpenTemplates}>
          {t('aiStudio.browseRecipes')}
        </Button>
      </section>
    </div>
  )
}

function CostEstimateChip({
  action,
  model,
}: {
  action: 'proposal' | 'explain' | 'review' | 'fix'
  model?: string
}) {
  const label = useMemo(() => {
    if (!model) return null
    const budget = ASSUMED_TOKEN_BUDGETS[action]
    const cost = estimatePromptCostUsd(model, budget.input, budget.output)
    if (cost === null) return null
    return formatEstimateLabel(cost)
  }, [action, model])
  if (!label) return null
  return <small className="ai-studio-cost-chip" data-testid={'ai-cost-' + action} aria-hidden="true">{label}</small>
}
