/**
 * AI Studio panel — exposes `/ai/generate-workflow`,
 * `/ai/explain-workflow`, and `/ai/review-workflow` to the user. Surfaces
 * the `mode` chip ("AI" / "Fallback") + `aiError` per AGENTS.md fallback
 * contract whenever the underlying call degrades.
 *
 * Used by `RightPanel.tsx` (the `ai-studio` tab).
 *
 * Invariants:
 * - When `mode === "fallback"`, `aiError` is rendered prominently so the
 *   user knows why we degraded (billing / quota / network).
 * - The review action falls back to the deterministic readiness check
 *   from the API engine when the LLM is unavailable, so the findings
 *   list is never empty just because the model is down.
 * - All user-visible strings flow through the i18n module — never raw
 *   literals; engine-emitted review issue codes go through tAiReviewIssue.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Bot, BrainCircuit, CheckCircle2, GitBranch, KeyRound, MessageSquareText, RefreshCw, Route, ShieldCheck, Sparkles, Workflow, Wrench } from 'lucide-react'
import { formatAiModeLabel } from '../constants'
import type { AiAuthoringActionRequest, AiCandidateBackoff, AiHealth, AiMode, ReviewFindings, WorkflowDefinition, WorkflowImprovementResult, WorkflowImprovementSuggestion } from '../types'
import { estimatePromptCostUsd, formatEstimateLabel } from '@/lib/llm-pricing'
import { tAiReviewIssue, useT } from '../i18n'
import { useWorkflowStore } from '../store'
import { BrandMark } from './BrandMark'

// Action-specific assumed token budgets used by the predicted-spend label.
// Real spend varies; these are order-of-magnitude indicators chosen from
// typical run sizes against `anthropic/claude-haiku-4-5-20251001`. Refine
// these values only with measured medians from `usage_events`.
const ASSUMED_TOKEN_BUDGETS: Record<'generate' | 'explain' | 'review' | 'fix', { input: number; output: number }> = {
  generate: { input: 4_000, output: 2_000 },
  explain: { input: 2_000, output: 1_000 },
  review: { input: 4_000, output: 1_500 },
  fix: { input: 5_000, output: 2_000 },
}

type AiStudioPanelProps = {
  health: AiHealth | null
  workflowName: string
  /** Resolves `null` when the author declined the unsaved-canvas guard. */
  onGenerateWorkflow: (prompt: string) => Promise<{
    mode: AiMode
    workflow: WorkflowDefinition
    aiError?: string
    bonBackoff?: AiCandidateBackoff
  } | null>
  onExplainWorkflow: () => Promise<{ mode: AiMode; explanation: string; model?: string; aiError?: string }>
  onReviewWorkflow: () => Promise<{ mode: AiMode; review: ReviewFindings; model?: string; aiError?: string }>
  actionRequest: AiAuthoringActionRequest | null
  onSuggestWorkflowImprovement: () => Promise<WorkflowImprovementResult>
  onApplyWorkflowImprovement: (suggestion: WorkflowImprovementSuggestion) => Promise<boolean>
  onOpenRuns: () => void
  onOpenTemplates: () => void
}

type ResultState =
  | { kind: 'workflow'; mode: AiMode; title: string; body: string; assurance: WorkflowAssuranceState; aiError?: string; bonBackoff?: AiCandidateBackoff }
  | { kind: 'explanation'; mode: AiMode; title: string; body: string; aiError?: string }
  | { kind: 'review'; mode: AiMode; title: string; review: ReviewFindings; aiError?: string }
  | { kind: 'fix'; mode: AiMode; title: string; suggestions: WorkflowImprovementSuggestion[]; aiError?: string }

const MODE_COPY_KEYS: Record<AiMode, string> = {
  ai: 'aiStudio.modeCopy.ai',
  fallback: 'aiStudio.modeCopy.fallback',
  error: 'aiStudio.modeCopy.error',
}

type WorkflowAssuranceState = {
  intent: boolean
  recovery: boolean
  qualification: boolean
}

function workflowAssuranceState(workflow: WorkflowDefinition): WorkflowAssuranceState {
  const contract = workflow.recovery?.contract
  return {
    intent: Object.keys(workflow.outputs ?? {}).length > 0,
    recovery: Boolean(contract),
    qualification: contract?.version === '2',
  }
}

/** Renders the AI Studio panel: prompt → workflow generator + explain-current-workflow surface. */
export function AiStudioPanel({
  health,
  workflowName,
  onGenerateWorkflow,
  onExplainWorkflow,
  onReviewWorkflow,
  actionRequest,
  onSuggestWorkflowImprovement,
  onApplyWorkflowImprovement,
  onOpenRuns,
  onOpenTemplates,
}: AiStudioPanelProps) {
  const { t, i18n } = useT()
  // `t` is intentionally reference-stable; the resolved locale is therefore
  // the dependency that invalidates translated memo values after an in-app
  // language switch.
  const locale = i18n.resolvedLanguage

  const starterPrompts = [
    t('aiStudio.starter1'),
    t('aiStudio.starter2'),
    t('aiStudio.starter3'),
  ]

  const [prompt, setPrompt] = useState(starterPrompts[0])
  const [loading, setLoading] = useState<'generate' | 'explain' | 'review' | 'fix' | null>(null)
  const [result, setResult] = useState<ResultState | null>(null)
  const promptRef = useRef<HTMLTextAreaElement | null>(null)
  const processedRequestRef = useRef<number | null>(null)
  const requestedActionHandlersRef = useRef<{
    explain: () => Promise<void>
    review: () => Promise<void>
    fix: () => Promise<void>
  } | null>(null)
  const currentWorkflowId = useWorkflowStore((state) => state.currentWorkflowId)
  // Clear a stale explain/review result when the operator switches workflows so
  // they don't read another flow's analysis. A freshly generated draft (kind
  // 'workflow') is preserved — generating ALSO changes the active workflow id
  // (via hydrateWorkflow), and wiping it would drop the draft just asked for.
  useEffect(() => {
    setResult((prev) => (prev && prev.kind === 'workflow' ? prev : null))
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

  const generate = async () => {
    const trimmed = prompt.trim()
    if (!trimmed) return
    setLoading('generate')
    try {
      const response = await onGenerateWorkflow(trimmed)
      // Author declined the unsaved-canvas guard — keep the prompt, no result card.
      if (!response) return
      const draftedByAi = response.mode === 'ai'
      const titleKey = draftedByAi
        ? 'aiStudio.draftedAi'
        : response.aiError
          ? 'aiStudio.draftedFallback'
          : 'aiStudio.draftedLocal'
      setResult({
        kind: 'workflow',
        mode: response.mode,
        title: t(titleKey),
        body: t('aiStudio.draftedBody', {
          name: response.workflow.name ?? response.workflow.id ?? (t('aiStudio.untitledWorkflow')),
        }),
        assurance: workflowAssuranceState(response.workflow),
        aiError: response.aiError,
        bonBackoff: response.bonBackoff,
      })
    } catch (error) {
      setResult({
        kind: 'workflow',
        mode: 'error',
        title: t('aiStudio.draftFailed'),
        body: error instanceof Error ? error.message : (t('aiStudio.draftFailedBody')),
        assurance: { intent: false, recovery: false, qualification: false },
      })
    } finally {
      setLoading(null)
    }
  }

  const explain = async () => {
    setLoading('explain')
    try {
      const response = await onExplainWorkflow()
      setResult({
        kind: 'explanation',
        mode: response.mode,
        title: response.aiError
          ? (t('aiStudio.explanationLocal', { name: workflowName }))
          : (t('aiStudio.explanationOk', { name: workflowName })),
        body: response.explanation,
        aiError: response.aiError,
      })
    } catch (error) {
      setResult({
        kind: 'explanation',
        mode: 'error',
        title: t('aiStudio.explanationFailed'),
        body: error instanceof Error ? error.message : (t('aiStudio.explanationFailedBody')),
      })
    } finally {
      setLoading(null)
    }
  }

  const review = async () => {
    setLoading('review')
    try {
      const response = await onReviewWorkflow()
      setResult({
        kind: 'review',
        mode: response.mode,
        title: response.aiError
          ? (t('aiStudio.reviewLocal', { name: workflowName }))
          : (t('aiStudio.reviewOk', { name: workflowName })),
        review: response.review,
        aiError: response.aiError,
      })
    } catch (error) {
      setResult({
        kind: 'review',
        mode: 'error',
        title: t('aiStudio.reviewFailed'),
        review: { status: 'fail', issues: [] },
        aiError: error instanceof Error ? error.message : (t('aiStudio.reviewFailedBody')),
      })
    } finally {
      setLoading(null)
    }
  }

  const fix = async () => {
    setLoading('fix')
    try {
      const response = await onSuggestWorkflowImprovement()
      setResult({
        kind: 'fix',
        mode: response.mode,
        title: response.mode === 'ai'
          ? t('aiStudio.fixReady')
          : t('aiStudio.fixUnavailable'),
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
      setLoading(null)
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

  const reviewSummary = (review: ReviewFindings, mode: AiMode): string => {
    if (mode === 'error') return t('aiStudio.reviewError')
    if (review.status === 'pass') return t('aiStudio.reviewPass')
    if (review.status === 'warn') return t('aiStudio.reviewWarn', { count: review.issues.length })
    const blockerCount = review.issues.filter((i) => i.severity === 'fail').length
    return t('aiStudio.reviewFail', { count: blockerCount })
  }

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

      <section className="we-card">
        <div className="split-row">
          <div>
            <div className="section-kicker">{t('aiStudio.create')}</div>
            <strong>{t('aiStudio.tellHeading')}</strong>
          </div>
          <span className={health?.enabled ? 'mode-pill mode-pill-ai' : 'mode-pill mode-pill-neutral'}>
            {health?.enabled ? health.model : t('aiStudio.localRules')}
          </span>
        </div>

        <textarea
          ref={promptRef}
          className="code-field code-field-short ai-studio-prompt"
          value={prompt}
          disabled={loading === 'generate'}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={t('aiStudio.placeholder')}
        />

        <div className="suggestion-row" aria-label={t('aiStudio.examplesAria')}>
          {starterPrompts.map((starter) => (
            <button key={starter} className="small-command" onClick={() => setPrompt(starter)} type="button">
              {starter.slice(0, 34)}…
            </button>
          ))}
        </div>

        <div className="ai-studio-actions">
          <button className="command-button command-button-primary" disabled={loading === 'generate' || !prompt.trim()} onClick={generate}>
            <Sparkles size={16} aria-hidden="true" />
            <span>{loading === 'generate' ? t('aiStudio.drafting') : t('aiStudio.draft')}</span>
            <CostEstimateChip action="generate" model={health?.model} />
          </button>
          <button className="command-button" disabled={loading === 'explain'} onClick={explain}>
            <CheckCircle2 size={16} aria-hidden="true" />
            <span>{loading === 'explain' ? t('aiStudio.explaining') : t('aiStudio.explain')}</span>
            <CostEstimateChip action="explain" model={health?.model} />
          </button>
          <button className="command-button" disabled={loading === 'review'} onClick={review}>
            <ShieldCheck size={16} aria-hidden="true" />
            <span>{loading === 'review' ? t('aiStudio.reviewing') : t('aiStudio.review')}</span>
            <CostEstimateChip action="review" model={health?.model} />
          </button>
          <button className="command-button" disabled={loading === 'fix'} onClick={fix}>
            <Wrench size={16} aria-hidden="true" />
            <span>{loading === 'fix' ? t('aiStudio.fixing') : t('aiStudio.fix')}</span>
            <CostEstimateChip action="fix" model={health?.model} />
          </button>
        </div>
      </section>

      {/* Persistent live region so a screen reader announces the explain /
          generate / review result when it appears — a conditionally-mounted
          live region doesn't reliably announce. The fallback / error sub-blocks
          keep their own role="alert" / role="status". */}
      <div className="ai-ai-studio__results" aria-live="polite">
      {result && result.kind !== 'review' && result.kind !== 'fix' && (
        <section className="we-card result-panel">
          <div className="split-row">
            <strong>{result.title}</strong>
            <span className={`mode-pill mode-pill-${result.mode}`}>{formatAiModeLabel(result.mode)}</span>
          </div>
          {result.mode === 'fallback' && (
            // Surface degraded mode prominently above the body so the reader
            // doesn't mistake a heuristic fallback for an AI-generated answer.
            <div className="issue issue-warn" role="alert">
              <strong>{t('aiStudio.fallbackBannerTitle')}</strong>{' '}
              <span>{t('aiStudio.fallbackBannerBody')}</span>
            </div>
          )}
          <p className="helper-text">{t(MODE_COPY_KEYS[result.mode])}</p>
          <div className="result-body">{result.body}</div>
          {result.kind === 'workflow' && result.assurance.intent && (
            <div className="ai-assurance-summary" role="status" data-testid="workflow-assurance-summary">
              <span className="helper-text">{t('aiStudio.assurance.heading')}</span>
              <span className="mode-pill mode-pill-ai">{t('aiStudio.assurance.intent')}</span>
              {result.assurance.recovery && (
                <span className="mode-pill mode-pill-ai">{t('aiStudio.assurance.recovery')}</span>
              )}
              {result.assurance.qualification && (
                <span className="mode-pill mode-pill-ai">{t('aiStudio.assurance.qualification')}</span>
              )}
            </div>
          )}
          {result.kind === 'workflow' && result.bonBackoff && (
            <div className="issue" role="status" data-testid="ai-candidate-backoff">
              <strong>{t('aiStudio.backoff.title')}</strong>{' '}
              <span>{t('aiStudio.backoff.body', result.bonBackoff)}</span>
            </div>
          )}
          {result.aiError && (
            <div className="issue issue-warn" role="status">
              <strong>{t('aiStudio.aiFailedTitle')}</strong>{' '}
              <span>{describeAiError(result.aiError)}</span>
            </div>
          )}
        </section>
      )}

      {result && result.kind === 'review' && (
        <section className="we-card result-panel">
          <div className="split-row">
            <strong>{result.title}</strong>
            <span className={`mode-pill mode-pill-${result.mode}`}>{formatAiModeLabel(result.mode)}</span>
          </div>
          <p className="helper-text">{reviewSummary(result.review, result.mode)}</p>
          {result.aiError && (
            <div className={`issue ${result.mode === 'error' ? 'issue-error' : 'issue-warn'}`} role="status">
              <strong>{result.mode === 'error' ? t('aiStudio.reviewErrorTitle') : t('aiStudio.reviewFallbackTitle')}</strong>{' '}
              <span>{describeAiError(result.aiError)}</span>
            </div>
          )}
          {result.review.issues.length > 0 && (
            <ul className="we-readiness-badge__issues" style={{ position: 'static', maxWidth: 'none' }}>
              {result.review.issues.map((issue, index) => {
                // Translate the engine-emitted code via the AI-review helper;
                // falls back to the original `issue.message` when no catalog
                // entry matches.
                const localised = tAiReviewIssue(issue)
                return (
                  <li key={`${issue.code}-${index}`} className={`we-readiness-issue we-readiness-issue--${issue.severity === 'info' ? 'warn' : issue.severity}`}>
                    <strong className="we-readiness-issue__code">{issue.code}</strong>
                    {issue.nodeId && <span className="we-readiness-issue__node"> · {issue.nodeId}</span>}
                    {issue.edgeId && <span className="we-readiness-issue__node"> · {issue.edgeId}</span>}
                    <p className="we-readiness-issue__message">{localised}</p>
                    <p className="we-readiness-issue__suggestion">{t('aiStudio.reviewWhy', { rationale: issue.rationale })}</p>
                    <p className="we-readiness-issue__suggestion">{t('aiStudio.reviewFix', { suggestion: issue.suggestion })}</p>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      )}

      {result && result.kind === 'fix' && (
        <section className="we-card result-panel">
          <div className="split-row">
            <strong>{result.title}</strong>
            <span className={`mode-pill mode-pill-${result.mode}`}>{formatAiModeLabel(result.mode)}</span>
          </div>
          {result.suggestions.length > 0 ? (
            <div className="ai-fix-list">
              {result.suggestions.map((suggestion, index) => (
                <article className="ai-fix-card" key={`${suggestion.approachLabel}-${index}`}>
                  <div className="split-row">
                    <strong>{suggestion.approachLabel}</strong>
                    <span className="mode-pill mode-pill-neutral">
                      {t('aiStudio.fixConfidence', { percent: Math.round(suggestion.confidence * 100) })}
                    </span>
                  </div>
                  <p>{suggestion.rationale}</p>
                  <button
                    type="button"
                    className="command-button command-button-primary"
                    onClick={() => { void onApplyWorkflowImprovement(suggestion) }}
                  >
                    <Wrench size={13} aria-hidden="true" />
                    <span>{t('aiStudio.fixApply')}</span>
                  </button>
                </article>
              ))}
            </div>
          ) : (
            <p className="helper-text">{t('aiStudio.fixNoSuggestion')}</p>
          )}
          {result.aiError && (
            <div className={`issue ${result.mode === 'error' ? 'issue-error' : 'issue-warn'}`} role="status">
              <strong>{t('aiStudio.aiFailedTitle')}</strong>{' '}
              <span>{describeAiError(result.aiError)}</span>
            </div>
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
        <button className="command-button" onClick={onOpenRuns}>
          <MessageSquareText size={16} aria-hidden="true" />
          <span>{t('aiStudio.askAboutRun')}</span>
        </button>
        <button className="command-button" onClick={onOpenTemplates}>
          <GitBranch size={16} aria-hidden="true" />
          <span>{t('aiStudio.browseRecipes')}</span>
        </button>
      </section>
    </div>
  )
}

/**
 * Small inline label next to AI Studio primary CTAs that surfaces the
 * predicted USD cost for the action. Uses the zero-dep pricing helper
 * in `@/lib/llm-pricing` so there's no API round-trip.
 *
 * Honest UX: "(~$0.05)" is an order-of-magnitude indicator (assumed
 * token budgets per action live in `ASSUMED_TOKEN_BUDGETS` at the top
 * of this file). Real spend varies; the audit + Recovery Center Budget tile
 * show the truth post-call.
 */
function CostEstimateChip({ action, model }: { action: 'generate' | 'explain' | 'review' | 'fix'; model?: string }) {
  const label = useMemo(() => {
    if (!model) return null
    const budget = ASSUMED_TOKEN_BUDGETS[action]
    const cost = estimatePromptCostUsd(model, budget.input, budget.output)
    if (cost === null) return null
    return formatEstimateLabel(cost)
  }, [action, model])
  if (!label) return null
  return (
    <small className="ai-studio-cost-chip" data-testid={`ai-cost-${action}`} aria-hidden="true">{label}</small>
  )
}
