import { AiStudioPanel } from '@janusly/web'
import { workflowDefinition } from './_fixtures'

/**
 * AI Studio: the panel that turns a prompt into a workflow, then explains,
 * reviews and improves the one on the canvas.
 *
 * Every AI result carries a `mode`. `ai` means the model answered; `fallback`
 * means it did not and Janusly produced a deterministic result anyway; `error`
 * means the action failed. A design must keep all three legible — a fallback
 * that looks like a model answer is the failure mode this panel exists to
 * avoid, which is why `aiError` travels alongside a usable result rather than
 * replacing it.
 *
 * `actionRequest.id` is a bump counter: the panel runs `action` when the id
 * changes, so an unchanged id (as here) leaves the panel idle and ready.
 */

const improvement = {
  workflow: workflowDefinition,
  rationale: 'The invoice fetch has no retry, so a single upstream 5xx fails the whole run.',
  approachLabel: 'add_retry',
  confidence: 78,
}

const handlers = {
  onGenerateWorkflow: async () => ({ mode: 'ai' as const, workflow: workflowDefinition }),
  onExplainWorkflow: async () => ({
    mode: 'ai' as const,
    model: 'claude-sonnet-5',
    explanation:
      'This workflow fetches an invoice, compares it against the purchase order, and posts a message to billing when the two disagree.',
  }),
  onReviewWorkflow: async () => ({
    mode: 'ai' as const,
    model: 'claude-sonnet-5',
    review: {
      status: 'warn' as const,
      issues: [
        {
          code: 'missing_retry_policy',
          severity: 'warn' as const,
          message: 'Step "Fetch invoice" calls an external host with no retry policy.',
          rationale: 'A single 5xx from the provider fails the run even though the call is safe to repeat.',
          suggestion: 'Add a retry with exponential backoff.',
          nodeId: 'fetch_invoice',
        },
      ],
    },
  }),
  onSuggestWorkflowImprovement: async () => ({
    mode: 'ai' as const,
    model: 'claude-sonnet-5',
    suggestions: [improvement],
  }),
  onApplyWorkflowImprovement: async () => true,
  onOpenRuns: () => {},
  onOpenTemplates: () => {},
}

const health = {
  enabled: true,
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  timeoutMs: 30000,
  maxRetries: 2,
}

/** A workspace with a provider key configured. */
export function AiAvailable() {
  return (
    <AiStudioPanel
      health={health}
      workflowName="Invoice reconciliation"
      actionRequest={{ id: 0, action: 'generate' }}
      {...handlers}
    />
  )
}

/**
 * No provider key. Janusly still runs — the panel says so and keeps the
 * deterministic paths reachable instead of presenting a dead surface.
 */
export function AiDisabled() {
  return (
    <AiStudioPanel
      health={{ enabled: false, model: 'claude-sonnet-5', timeoutMs: 30000, maxRetries: 2 }}
      workflowName="Invoice reconciliation"
      actionRequest={{ id: 0, action: 'generate' }}
      {...handlers}
      onGenerateWorkflow={async () => ({
        mode: 'fallback' as const,
        workflow: workflowDefinition,
        aiError: 'No AI provider is configured for this workspace.',
      })}
    />
  )
}
