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
 */

import React, { useMemo, useState } from 'react'
import { Bot, BrainCircuit, CheckCircle2, GitBranch, KeyRound, MessageSquareText, RefreshCw, Route, ShieldCheck, Sparkles, Workflow } from 'lucide-react'
import { formatAiModeLabel } from '../constants'
import type { AiHealth, AiMode, WorkflowDefinition } from '../types'
import { estimatePromptCostUsd, formatEstimateLabel } from '@janusly/shared/src/llm-pricing'

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
  onGenerateWorkflow: (prompt: string) => Promise<{ mode: AiMode; workflow: WorkflowDefinition; aiError?: string }>
  onExplainWorkflow: () => Promise<{ mode: AiMode; explanation: string; model?: string; aiError?: string }>
  onReviewWorkflow: () => Promise<{ mode: AiMode; review: ReviewFindings; model?: string; aiError?: string }>
  onOpenRuns: () => void
  onOpenTemplates: () => void
}

type ResultState =
  | { kind: 'workflow'; mode: AiMode; title: string; body: string; aiError?: string }
  | { kind: 'explanation'; mode: AiMode; title: string; body: string; aiError?: string }
  | { kind: 'review'; mode: AiMode; title: string; review: ReviewFindings; aiError?: string }

const starterPrompts = [
  'Watch a GitHub release, summarize what changed, and ask for approval when risk is high.',
  'Collect customer feedback, classify urgency, and route critical issues to a person.',
  'Check an order status, explain what changed, and retry failed handoff steps.',
]

const modeCopy: Record<AiMode, string> = {
  ai: 'Generated with the connected model.',
  fallback: 'Generated locally so the flow still works without external AI.',
  error: 'The AI request needs attention.',
}

function describeAiError(message: string) {
  if (/quota|billing|insufficient_quota/i.test(message)) {
    return 'Your OpenAI account has no quota left. Add a payment method at https://platform.openai.com/account/billing and retry.'
  }
  if (/rate limit/i.test(message)) {
    return 'Rate limit reached. Wait a few seconds and retry, or switch to a higher-tier model.'
  }
  if (/invalid api key|incorrect api key|unauthorized/i.test(message)) {
    return 'OpenAI rejected the API key. Re-check the value in the root .env and restart the API.'
  }
  return message
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
  const [prompt, setPrompt] = useState(starterPrompts[0])
  const [loading, setLoading] = useState<'generate' | 'explain' | 'review' | null>(null)
  const [result, setResult] = useState<ResultState | null>(null)

  const healthLabel = health?.enabled ? 'AI is connected' : 'Local mode is active'
  const healthDetail = health?.enabled
    ? `${health.model} can draft flows, explain runs, and power AI steps.`
    : 'Janusly still works locally. Add OPENAI_API_KEY to the root .env and restart the API to use full AI.'

  const useCases = useMemo(() => [
    {
      icon: <Workflow size={16} />,
      title: 'Prompt to workflow',
      body: 'Describe the business outcome. Janusly turns it into a runnable flow.',
      state: health?.enabled ? 'AI ready' : 'Starter flow',
    },
    {
      icon: <MessageSquareText size={16} />,
      title: 'Explain a workflow',
      body: 'Translate the current canvas into purpose, path, and next checks.',
      state: health?.enabled ? 'AI ready' : 'Local summary',
    },
    {
      icon: <Bot size={16} />,
      title: 'Explain a run',
      body: 'Ask what happened after execution, including failures, retries, skipped steps, and rollback signals.',
      state: health?.enabled ? 'AI chat' : 'Local chat',
    },
    {
      icon: <BrainCircuit size={16} />,
      title: 'Agent planning',
      body: 'Agent and team steps choose tools from a goal. With no key, they use rules.',
      state: health?.enabled ? 'AI planner' : 'Rules planner',
    },
    {
      icon: <Route size={16} />,
      title: 'Causal routing',
      body: 'Routing and counterfactual replay stay available without an LLM.',
      state: 'Always on',
    },
  ], [health?.enabled])

  const readinessSteps = useMemo(() => [
    {
      icon: <KeyRound size={15} />,
      title: 'Root .env has OPENAI_API_KEY',
      body: 'The API and worker load the repository root .env, not nested app env files.',
      ready: Boolean(health?.enabled),
    },
    {
      icon: <RefreshCw size={15} />,
      title: 'API and worker restarted',
      body: 'Restart both processes after changing AI environment variables.',
      ready: Boolean(health),
    },
    {
      icon: <CheckCircle2 size={15} />,
      title: '/ai/health returns enabled: true',
      body: health?.enabled ? `${health.model} is the active model.` : 'Current response is enabled: false.',
      ready: Boolean(health?.enabled),
    },
  ], [health])

  const generate = async () => {
    const trimmed = prompt.trim()
    if (!trimmed) return
    setLoading('generate')
    try {
      const response = await onGenerateWorkflow(trimmed)
      const draftedByAi = response.mode === 'ai'
      setResult({
        kind: 'workflow',
        mode: response.mode,
        title: draftedByAi
          ? 'Flow drafted by AI'
          : response.aiError
            ? 'Starter flow used because AI failed'
            : 'Starter flow loaded locally',
        body: `${response.workflow.name ?? response.workflow.id ?? 'Untitled workflow'} is now on the canvas. Review the setup, then run it when ready.`,
        aiError: response.aiError,
      })
    } catch (error) {
      setResult({
        kind: 'workflow',
        mode: 'error',
        title: 'Workflow draft failed',
        body: error instanceof Error ? error.message : 'Janusly could not draft a workflow.',
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
          ? `Local explanation for ${workflowName} (AI failed)`
          : `Explanation for ${workflowName}`,
        body: response.explanation,
        aiError: response.aiError,
      })
    } catch (error) {
      setResult({
        kind: 'explanation',
        mode: 'error',
        title: 'Explanation failed',
        body: error instanceof Error ? error.message : 'Janusly could not explain this workflow.',
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
          ? `Local readiness review for ${workflowName} (AI failed)`
          : `Production readiness review for ${workflowName}`,
        review: response.review,
        aiError: response.aiError,
      })
    } catch (error) {
      setResult({
        kind: 'review',
        mode: 'error',
        title: 'Review failed',
        review: { status: 'fail', issues: [] },
        aiError: error instanceof Error ? error.message : 'Janusly could not review this workflow.',
      })
    } finally {
      setLoading(null)
    }
  }

  return (
    <div className="panel-stack">
      <section className="copilot-hero">
        <div>
          <span className={health?.enabled ? 'mode-pill mode-pill-ai' : 'mode-pill mode-pill-fallback'}>
            {healthLabel}
          </span>
          <h2>Describe the outcome. Janusly builds the flow.</h2>
          <p>{healthDetail}</p>
        </div>
        <Sparkles size={28} aria-hidden="true" />
      </section>

      <section className="panel-card">
        <div className="split-row">
          <div>
            <div className="section-kicker">Create</div>
            <strong>Tell Janusly what should happen</strong>
          </div>
          <span className={health?.enabled ? 'mode-pill mode-pill-ai' : 'mode-pill mode-pill-neutral'}>
            {health?.enabled ? health.model : 'Local rules'}
          </span>
        </div>

        <textarea
          className="code-field code-field-short copilot-prompt"
          value={prompt}
          disabled={loading === 'generate'}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Example: when a customer asks for a refund, check policy, summarize risk, and ask for approval."
        />

        <div className="suggestion-row" aria-label="Prompt examples">
          {starterPrompts.map((starter) => (
            <button key={starter} className="small-command" onClick={() => setPrompt(starter)} type="button">
              {starter.slice(0, 34)}…
            </button>
          ))}
        </div>

        <div className="copilot-actions">
          <button className="command-button command-button-primary" disabled={loading === 'generate' || !prompt.trim()} onClick={generate}>
            <Sparkles size={16} aria-hidden="true" />
            <span>{loading === 'generate' ? 'Drafting…' : 'Draft flow'}</span>
            <CostEstimateChip action="generate" model={health?.model} />
          </button>
          <button className="command-button" disabled={loading === 'explain'} onClick={explain}>
            <CheckCircle2 size={16} aria-hidden="true" />
            <span>{loading === 'explain' ? 'Explaining…' : 'Explain this flow'}</span>
            <CostEstimateChip action="explain" model={health?.model} />
          </button>
          <button className="command-button" disabled={loading === 'review'} onClick={review}>
            <ShieldCheck size={16} aria-hidden="true" />
            <span>{loading === 'review' ? 'Reviewing…' : 'Review this flow'}</span>
            <CostEstimateChip action="review" model={health?.model} />
          </button>
        </div>
      </section>

      {result && result.kind !== 'review' && (
        <section className="panel-card result-panel">
          <div className="split-row">
            <strong>{result.title}</strong>
            <span className={`mode-pill mode-pill-${result.mode}`}>{formatAiModeLabel(result.mode)}</span>
          </div>
          <p className="helper-text">{modeCopy[result.mode]}</p>
          <div className="result-body">{result.body}</div>
          {result.aiError && (
            <div className="issue issue-warn" role="status">
              <strong>AI request failed.</strong>{' '}
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
          <p className="helper-text">
            {result.mode === 'error'
              ? 'The review could not be completed. Check the API connection and try again.'
              : result.review.status === 'pass'
              ? 'No production-readiness blockers found.'
              : result.review.status === 'warn'
                ? `${result.review.issues.length} issue${result.review.issues.length === 1 ? '' : 's'} worth reviewing before production.`
                : `${result.review.issues.filter((i) => i.severity === 'fail').length} blocker${result.review.issues.filter((i) => i.severity === 'fail').length === 1 ? '' : 's'} — fix before production-mode runs.`}
          </p>
          {result.aiError && (
            <div className={`issue ${result.mode === 'error' ? 'issue-error' : 'issue-warn'}`} role="status">
              <strong>{result.mode === 'error' ? 'Review request failed.' : 'AI review fell back to local rules.'}</strong>{' '}
              <span>{describeAiError(result.aiError)}</span>
            </div>
          )}
          {result.review.issues.length > 0 && (
            <ul className="we-readiness-badge__issues" style={{ position: 'static', maxWidth: 'none' }}>
              {result.review.issues.map((issue, index) => (
                <li key={`${issue.code}-${index}`} className={`we-readiness-issue we-readiness-issue--${issue.severity === 'info' ? 'warn' : issue.severity}`}>
                  <strong className="we-readiness-issue__code">{issue.code}</strong>
                  {issue.nodeId && <span className="we-readiness-issue__node"> · {issue.nodeId}</span>}
                  {issue.edgeId && <span className="we-readiness-issue__node"> · {issue.edgeId}</span>}
                  <p className="we-readiness-issue__message">{issue.message}</p>
                  <p className="we-readiness-issue__suggestion">Why: {issue.rationale}</p>
                  <p className="we-readiness-issue__suggestion">Fix: {issue.suggestion}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="panel-card">
        <div className="section-kicker">Supported AI use cases</div>
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
        <div className="section-kicker">Full AI readiness</div>
        <div className="usecase-list">
          {readinessSteps.map((step) => (
            <div key={step.title} className="usecase-row">
              <div className={step.ready ? 'usecase-icon usecase-icon-ready' : 'usecase-icon'}>{step.icon}</div>
              <div>
                <strong>{step.title}</strong>
                <p>{step.body}</p>
              </div>
              <span className={step.ready ? 'mode-pill mode-pill-ai' : 'mode-pill mode-pill-neutral'}>
                {step.ready ? 'Ready' : 'Check'}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="copilot-secondary-actions">
        <button className="command-button" onClick={onOpenRuns}>
          <MessageSquareText size={16} aria-hidden="true" />
          <span>Ask about a run</span>
        </button>
        <button className="command-button" onClick={onOpenTemplates}>
          <GitBranch size={16} aria-hidden="true" />
          <span>Browse recipes</span>
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
