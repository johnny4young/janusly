/**
 * AI Copilot panel — exposes `/ai/generate-workflow`,
 * `/ai/explain-workflow`, and `/ai/review-workflow` to the user. Surfaces
 * the `mode` chip ("AI" / "Fallback") + `aiError` per AGENTS.md fallback
 * contract whenever the underlying call degrades.
 *
 * Used by `RightPanel.tsx` (the `copilot` tab).
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

import { useEffect, useMemo, useState } from 'react'
import { Bot, BrainCircuit, CheckCircle2, GitBranch, KeyRound, MessageSquareText, RefreshCw, Route, ShieldCheck, Sparkles, Workflow } from 'lucide-react'
import { formatAiModeLabel } from '../constants'
import type { AiHealth, AiMode, WorkflowDefinition } from '../types'
import { estimatePromptCostUsd, formatEstimateLabel } from '@janusly/shared/src/llm-pricing'
import { tAiReviewIssue, useT } from '../i18n'
import { useWorkflowStore } from '../store'
import { BrandMark } from './BrandMark'

// Action-specific assumed token budgets used by the predicted-spend label.
// Real spend varies; these are order-of-magnitude indicators chosen from
// typical run sizes against `anthropic/claude-haiku-4-5-20251001`. Future
// tickets can refine these with measured medians from `usage_events`.
const ASSUMED_TOKEN_BUDGETS: Record<'generate' | 'explain' | 'review', { input: number; output: number }> = {
  generate: { input: 4_000, output: 2_000 },
  explain: { input: 2_000, output: 1_000 },
  review: { input: 4_000, output: 1_500 },
}

type ReviewSeverity = 'info' | 'warn' | 'fail'

type ReviewFinding = {
  code: string
  severity: ReviewSeverity
  message: string
  nodeId?: string
  edgeId?: string
  rationale: string
  suggestion: string
}

type ReviewFindings = {
  status: 'pass' | 'warn' | 'fail'
  issues: ReviewFinding[]
}

type AiCopilotPanelProps = {
  health: AiHealth | null
  workflowName: string
  /** Resolves `null` when the author declined the unsaved-canvas guard. */
  onGenerateWorkflow: (prompt: string) => Promise<{ mode: AiMode; workflow: WorkflowDefinition; aiError?: string } | null>
  onExplainWorkflow: () => Promise<{ mode: AiMode; explanation: string; model?: string; aiError?: string }>
  onReviewWorkflow: () => Promise<{ mode: AiMode; review: ReviewFindings; model?: string; aiError?: string }>
  onOpenRuns: () => void
  onOpenTemplates: () => void
}

type ResultState =
  | { kind: 'workflow'; mode: AiMode; title: string; body: string; aiError?: string }
  | { kind: 'explanation'; mode: AiMode; title: string; body: string; aiError?: string }
  | { kind: 'review'; mode: AiMode; title: string; review: ReviewFindings; aiError?: string }

const MODE_COPY_KEYS: Record<AiMode, string> = {
  ai: 'aiCopilot.modeCopy.ai',
  fallback: 'aiCopilot.modeCopy.fallback',
  error: 'aiCopilot.modeCopy.error',
}

/** Renders the Copilot panel: prompt → workflow generator + explain-current-workflow surface. */
export function AiCopilotPanel({
  health,
  workflowName,
  onGenerateWorkflow,
  onExplainWorkflow,
  onReviewWorkflow,
  onOpenRuns,
  onOpenTemplates,
}: AiCopilotPanelProps) {
  const { t } = useT()

  const starterPrompts = [
    t('aiCopilot.starter1') as string,
    t('aiCopilot.starter2') as string,
    t('aiCopilot.starter3') as string,
  ]

  const [prompt, setPrompt] = useState(starterPrompts[0])
  const [loading, setLoading] = useState<'generate' | 'explain' | 'review' | null>(null)
  const [result, setResult] = useState<ResultState | null>(null)
  const currentWorkflowId = useWorkflowStore((state) => state.currentWorkflowId)
  // Clear a stale explain/review result when the operator switches workflows so
  // they don't read another flow's analysis. A freshly generated draft (kind
  // 'workflow') is preserved — generating ALSO changes the active workflow id
  // (via hydrateWorkflow), and wiping it would drop the draft just asked for.
  useEffect(() => {
    setResult((prev) => (prev && prev.kind === 'workflow' ? prev : null))
  }, [currentWorkflowId])

  const healthLabel = health?.enabled ? t('aiCopilot.healthOn') : t('aiCopilot.healthOff')
  const healthDetail = health?.enabled
    ? t('aiCopilot.healthDetailOn', { model: health.model })
    : t('aiCopilot.healthDetailOff')

  function describeAiError(message: string): string {
    if (/quota|billing|insufficient_quota/i.test(message)) return t('aiCopilot.aiError.quota') as string
    if (/rate limit/i.test(message)) return t('aiCopilot.aiError.rate') as string
    if (/invalid api key|incorrect api key|unauthorized/i.test(message)) return t('aiCopilot.aiError.auth') as string
    return message
  }

  const useCases = useMemo(() => [
    {
      icon: <Workflow size={16} />,
      title: t('aiCopilot.useCase.prompt.title') as string,
      body: t('aiCopilot.useCase.prompt.body') as string,
      state: (health?.enabled ? t('aiCopilot.useCase.prompt.stateOn') : t('aiCopilot.useCase.prompt.stateOff')) as string,
    },
    {
      icon: <MessageSquareText size={16} />,
      title: t('aiCopilot.useCase.explain.title') as string,
      body: t('aiCopilot.useCase.explain.body') as string,
      state: (health?.enabled ? t('aiCopilot.useCase.prompt.stateOn') : t('aiCopilot.useCase.explain.stateOff')) as string,
    },
    {
      icon: <Bot size={16} />,
      title: t('aiCopilot.useCase.explainRun.title') as string,
      body: t('aiCopilot.useCase.explainRun.body') as string,
      state: (health?.enabled ? t('aiCopilot.useCase.explainRun.stateOn') : t('aiCopilot.useCase.explainRun.stateOff')) as string,
    },
    {
      icon: <BrainCircuit size={16} />,
      title: t('aiCopilot.useCase.agent.title') as string,
      body: t('aiCopilot.useCase.agent.body') as string,
      state: (health?.enabled ? t('aiCopilot.useCase.agent.stateOn') : t('aiCopilot.useCase.agent.stateOff')) as string,
    },
    {
      icon: <Route size={16} />,
      title: t('aiCopilot.useCase.causal.title') as string,
      body: t('aiCopilot.useCase.causal.body') as string,
      state: t('aiCopilot.useCase.causal.alwaysOn') as string,
    },
  ], [health?.enabled, t])

  const readinessSteps = useMemo(() => [
    {
      icon: <KeyRound size={15} />,
      title: t('aiCopilot.readiness.envTitle') as string,
      body: t('aiCopilot.readiness.envBody') as string,
      ready: Boolean(health?.enabled),
    },
    {
      icon: <RefreshCw size={15} />,
      title: t('aiCopilot.readiness.restartTitle') as string,
      body: t('aiCopilot.readiness.restartBody') as string,
      ready: Boolean(health),
    },
    {
      icon: <CheckCircle2 size={15} />,
      title: t('aiCopilot.readiness.healthTitle') as string,
      body: (health?.enabled
        ? t('aiCopilot.readiness.healthBodyOn', { model: health.model })
        : t('aiCopilot.readiness.healthBodyOff')) as string,
      ready: Boolean(health?.enabled),
    },
  ], [health, t])

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
        ? 'aiCopilot.draftedAi'
        : response.aiError
          ? 'aiCopilot.draftedFallback'
          : 'aiCopilot.draftedLocal'
      setResult({
        kind: 'workflow',
        mode: response.mode,
        title: t(titleKey as never) as string,
        body: t('aiCopilot.draftedBody', {
          name: response.workflow.name ?? response.workflow.id ?? (t('aiCopilot.untitledWorkflow') as string),
        }) as string,
        aiError: response.aiError,
      })
    } catch (error) {
      setResult({
        kind: 'workflow',
        mode: 'error',
        title: t('aiCopilot.draftFailed') as string,
        body: error instanceof Error ? error.message : (t('aiCopilot.draftFailedBody') as string),
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
          ? (t('aiCopilot.explanationLocal', { name: workflowName }) as string)
          : (t('aiCopilot.explanationOk', { name: workflowName }) as string),
        body: response.explanation,
        aiError: response.aiError,
      })
    } catch (error) {
      setResult({
        kind: 'explanation',
        mode: 'error',
        title: t('aiCopilot.explanationFailed') as string,
        body: error instanceof Error ? error.message : (t('aiCopilot.explanationFailedBody') as string),
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
          ? (t('aiCopilot.reviewLocal', { name: workflowName }) as string)
          : (t('aiCopilot.reviewOk', { name: workflowName }) as string),
        review: response.review,
        aiError: response.aiError,
      })
    } catch (error) {
      setResult({
        kind: 'review',
        mode: 'error',
        title: t('aiCopilot.reviewFailed') as string,
        review: { status: 'fail', issues: [] },
        aiError: error instanceof Error ? error.message : (t('aiCopilot.reviewFailedBody') as string),
      })
    } finally {
      setLoading(null)
    }
  }

  const reviewSummary = (review: ReviewFindings, mode: AiMode): string => {
    if (mode === 'error') return t('aiCopilot.reviewError') as string
    if (review.status === 'pass') return t('aiCopilot.reviewPass') as string
    if (review.status === 'warn') return t('aiCopilot.reviewWarn', { count: review.issues.length }) as string
    const blockerCount = review.issues.filter((i) => i.severity === 'fail').length
    return t('aiCopilot.reviewFail', { count: blockerCount }) as string
  }

  return (
    <div className="panel-stack">
      <section className="copilot-hero copilot-hero--branded">
        <div>
          <span className={health?.enabled ? 'mode-pill mode-pill-ai' : 'mode-pill mode-pill-fallback'}>
            {healthLabel}
          </span>
          <h2>{t('aiCopilot.heroTitle')}</h2>
          <p>{healthDetail}</p>
        </div>
        <BrandMark size={44} />
      </section>

      <section className="panel-card">
        <div className="split-row">
          <div>
            <div className="section-kicker">{t('aiCopilot.create')}</div>
            <strong>{t('aiCopilot.tellHeading')}</strong>
          </div>
          <span className={health?.enabled ? 'mode-pill mode-pill-ai' : 'mode-pill mode-pill-neutral'}>
            {health?.enabled ? health.model : t('aiCopilot.localRules')}
          </span>
        </div>

        <textarea
          className="code-field code-field-short copilot-prompt"
          value={prompt}
          disabled={loading === 'generate'}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={t('aiCopilot.placeholder') as string}
        />

        <div className="suggestion-row" aria-label={t('aiCopilot.examplesAria') as string}>
          {starterPrompts.map((starter) => (
            <button key={starter} className="small-command" onClick={() => setPrompt(starter)} type="button">
              {starter.slice(0, 34)}…
            </button>
          ))}
        </div>

        <div className="copilot-actions">
          <button className="command-button command-button-primary" disabled={loading === 'generate' || !prompt.trim()} onClick={generate}>
            <Sparkles size={16} aria-hidden="true" />
            <span>{loading === 'generate' ? t('aiCopilot.drafting') : t('aiCopilot.draft')}</span>
            <CostEstimateChip action="generate" model={health?.model} />
          </button>
          <button className="command-button" disabled={loading === 'explain'} onClick={explain}>
            <CheckCircle2 size={16} aria-hidden="true" />
            <span>{loading === 'explain' ? t('aiCopilot.explaining') : t('aiCopilot.explain')}</span>
            <CostEstimateChip action="explain" model={health?.model} />
          </button>
          <button className="command-button" disabled={loading === 'review'} onClick={review}>
            <ShieldCheck size={16} aria-hidden="true" />
            <span>{loading === 'review' ? t('aiCopilot.reviewing') : t('aiCopilot.review')}</span>
            <CostEstimateChip action="review" model={health?.model} />
          </button>
        </div>
      </section>

      {/* Persistent live region so a screen reader announces the explain /
          generate / review result when it appears — a conditionally-mounted
          live region doesn't reliably announce. The fallback / error sub-blocks
          keep their own role="alert" / role="status". */}
      <div className="ai-copilot__results" aria-live="polite">
      {result && result.kind !== 'review' && (
        <section className="panel-card result-panel">
          <div className="split-row">
            <strong>{result.title}</strong>
            <span className={`mode-pill mode-pill-${result.mode}`}>{formatAiModeLabel(result.mode)}</span>
          </div>
          {result.mode === 'fallback' && (
            // Surface degraded mode prominently above the body so the reader
            // doesn't mistake a heuristic fallback for an AI-generated answer.
            <div className="issue issue-warn" role="alert">
              <strong>{t('aiCopilot.fallbackBannerTitle')}</strong>{' '}
              <span>{t('aiCopilot.fallbackBannerBody')}</span>
            </div>
          )}
          <p className="helper-text">{t(MODE_COPY_KEYS[result.mode] as never) as string}</p>
          <div className="result-body">{result.body}</div>
          {result.aiError && (
            <div className="issue issue-warn" role="status">
              <strong>{t('aiCopilot.aiFailedTitle')}</strong>{' '}
              <span>{describeAiError(result.aiError)}</span>
            </div>
          )}
        </section>
      )}

      {result && result.kind === 'review' && (
        <section className="panel-card result-panel">
          <div className="split-row">
            <strong>{result.title}</strong>
            <span className={`mode-pill mode-pill-${result.mode}`}>{formatAiModeLabel(result.mode)}</span>
          </div>
          <p className="helper-text">{reviewSummary(result.review, result.mode)}</p>
          {result.aiError && (
            <div className={`issue ${result.mode === 'error' ? 'issue-error' : 'issue-warn'}`} role="status">
              <strong>{result.mode === 'error' ? t('aiCopilot.reviewErrorTitle') : t('aiCopilot.reviewFallbackTitle')}</strong>{' '}
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
                    <p className="we-readiness-issue__suggestion">{t('aiCopilot.reviewWhy', { rationale: issue.rationale })}</p>
                    <p className="we-readiness-issue__suggestion">{t('aiCopilot.reviewFix', { suggestion: issue.suggestion })}</p>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      )}
      </div>

      <section className="panel-card">
        <div className="section-kicker">{t('aiCopilot.useCases')}</div>
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

      <section className="panel-card">
        <div className="section-kicker">{t('aiCopilot.readiness.heading')}</div>
        <div className="usecase-list">
          {readinessSteps.map((step) => (
            <div key={step.title} className="usecase-row">
              <div className={step.ready ? 'usecase-icon usecase-icon-ready' : 'usecase-icon'}>{step.icon}</div>
              <div>
                <strong>{step.title}</strong>
                <p>{step.body}</p>
              </div>
              <span className={step.ready ? 'mode-pill mode-pill-ai' : 'mode-pill mode-pill-neutral'}>
                {step.ready ? t('aiCopilot.readiness.ready') : t('aiCopilot.readiness.check')}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="copilot-secondary-actions">
        <button className="command-button" onClick={onOpenRuns}>
          <MessageSquareText size={16} aria-hidden="true" />
          <span>{t('aiCopilot.askAboutRun')}</span>
        </button>
        <button className="command-button" onClick={onOpenTemplates}>
          <GitBranch size={16} aria-hidden="true" />
          <span>{t('aiCopilot.browseRecipes')}</span>
        </button>
      </section>
    </div>
  )
}

/**
 * Small inline label next to AI Studio primary CTAs that surfaces the
 * predicted USD cost for the action. Uses the zero-dep pricing helper
 * in `@janusly/shared/src/llm-pricing` so there's no API round-trip.
 *
 * Honest UX: "(~$0.05)" is an order-of-magnitude indicator (assumed
 * token budgets per action live in `ASSUMED_TOKEN_BUDGETS` at the top
 * of this file). Real spend varies; the audit + Recovery Center Budget tile
 * show the truth post-call.
 */
function CostEstimateChip({ action, model }: { action: 'generate' | 'explain' | 'review'; model?: string }) {
  const label = useMemo(() => {
    if (!model) return null
    const budget = ASSUMED_TOKEN_BUDGETS[action]
    const cost = estimatePromptCostUsd(model, budget.input, budget.output)
    if (cost === null) return null
    return formatEstimateLabel(cost)
  }, [action, model])
  if (!label) return null
  return (
    <small className="copilot-cost-chip" data-testid={`ai-cost-${action}`} aria-hidden="true">{label}</small>
  )
}
