// Types, limits and pure helpers shared by the AI Studio controller and views.
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
  WorkflowProposalApplyOutcome,
  WorkflowProposalResponse,
} from '../../types'

export const ASSUMED_TOKEN_BUDGETS: Record<'proposal' | 'explain' | 'review' | 'fix', { input: number; output: number }> = {
  proposal: { input: 4_000, output: 2_000 },
  explain: { input: 2_000, output: 1_000 },
  review: { input: 4_000, output: 1_500 },
  fix: { input: 5_000, output: 2_000 },
}
export const MAX_PROPOSAL_INPUT_DEFAULTS = 12
const MAX_PROPOSAL_INPUT_DEFAULT_CHARS = 240
export const MAX_AUTHORING_PROMPT_CHARS = 4000
export const MAX_CLARIFICATION_ANSWER_CHARS = 500

export function composeAuthoringPrompt(
  prompt: string,
  questions: string[],
  answers: Record<number, string>,
): string {
  const base = prompt.trim()
  const clarificationLines = questions.slice(0, 3).flatMap((_, index) => {
    const answer = answers[index]?.trim()
    if (!answer) return []
    return [`Clarification ${index + 1}: ${answer}`]
  })
  if (clarificationLines.length === 0) return base
  return `${base}\n\n${clarificationLines.join('\n')}`
}

export type AiStudioPanelProps = {
  health: AiHealth | null
  workflowName: string
  onLoadAuthoringCapabilities: () => Promise<AuthoringCapabilityCatalog>
  onCompileWorkflowBrief: (prompt: string) => Promise<WorkflowBriefCompilation>
  onProposeWorkflow: (brief: WorkflowIntentBrief, catalogVersion: string, sourcePrompt: string) => Promise<WorkflowProposalResponse>
  onApplyWorkflowProposal: (proposal: WorkflowProposalResponse) => Promise<WorkflowProposalApplyOutcome>
  onExplainWorkflow: () => Promise<{ mode: AiMode; explanation: string; model?: string; aiError?: string }>
  onReviewWorkflow: () => Promise<{ mode: AiMode; review: ReviewFindings; model?: string; aiError?: string }>
  actionRequest: AiAuthoringActionRequest | null
  onSuggestWorkflowImprovement: () => Promise<WorkflowImprovementResult>
  onApplyWorkflowImprovement: (suggestion: WorkflowImprovementSuggestion) => Promise<boolean>
  onOpenRuns: () => void
  onOpenTemplates: () => void
}

export type AuthoringLoading = 'compile' | 'propose' | 'apply'
export type CurrentWorkflowLoading = 'explain' | 'review' | 'fix'
export type CompiledBriefState = WorkflowBriefCompilation & { sourcePrompt: string }
export type ResultState =
  | { kind: 'explanation'; mode: AiMode; title: string; body: string; aiError?: string }
  | { kind: 'review'; mode: AiMode; title: string; review: ReviewFindings; aiError?: string }
  | { kind: 'fix'; mode: AiMode; title: string; suggestions: WorkflowImprovementSuggestion[]; aiError?: string }

export const MODE_COPY_KEYS: Record<AiMode, string> = {
  ai: 'aiStudio.modeCopy.ai',
  fallback: 'aiStudio.modeCopy.fallback',
  error: 'aiStudio.modeCopy.error',
}

export const SIGNAL_COPY_KEYS: Record<string, string> = {
  manual_trigger: 'aiStudio.proposal.signal.manualTrigger',
  deterministic_template: 'aiStudio.proposal.signal.deterministicTemplate',
  provider_output_guarded: 'aiStudio.proposal.signal.providerOutputGuarded',
  missing_capability_binding: 'aiStudio.proposal.signal.missingBinding',
  external_effect_without_declared_approval: 'aiStudio.proposal.signal.externalEffectApproval',
  readiness_blocked: 'aiStudio.proposal.signal.readinessBlocked',
  readiness_warning: 'aiStudio.proposal.signal.readinessWarning',
}

export const CATALOG_WARNING_COPY: Record<string, [string, string]> = {
  mcp_tools_unavailable: ['aiStudio.catalog.mcp', 'recoveryCase.autonomy.unavailable'],
  mcp_tools_truncated: ['aiStudio.catalog.mcp', 'home.health.unavailable'],
  credentials_unavailable: ['aiStudio.catalog.credentials', 'recoveryCase.autonomy.unavailable'],
  credentials_truncated: ['aiStudio.catalog.credentials', 'home.health.unavailable'],
  subworkflows_unavailable: ['aiStudio.catalog.workflows', 'recoveryCase.autonomy.unavailable'],
  subworkflows_truncated: ['aiStudio.catalog.workflows', 'home.health.unavailable'],
}

export function totalCatalogCapabilities(catalog: AuthoringCapabilityCatalog): number {
  return catalog.builtinTools.length
    + catalog.mcpTools.filter((tool) => (
      tool.connectionAlias !== '_truncated' && tool.toolName !== '_truncated'
    )).length
    + catalog.triggers.length
    + catalog.credentials.length
    + catalog.subworkflows.length
    + catalog.primitives.length
}

export function formatAuthoringDuration(milliseconds: number | null): string {
  if (milliseconds === null) return '—'
  if (milliseconds < 100) return '< 0.1 s'
  return `${(milliseconds / 1000).toFixed(1)} s`
}

export function formatWorkflowInputDefault(value: unknown): string {
  let formatted: string
  if (typeof value === 'string') {
    formatted = value || '""'
  } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    formatted = String(value)
  } else {
    try {
      formatted = JSON.stringify(value) ?? '—'
    } catch {
      formatted = '—'
    }
  }
  const characters = Array.from(formatted)
  return characters.length > MAX_PROPOSAL_INPUT_DEFAULT_CHARS
    ? `${characters.slice(0, MAX_PROPOSAL_INPUT_DEFAULT_CHARS).join('')}…`
    : formatted
}

type Translate = (key: string, options?: Record<string, unknown>) => string

export function describeAiError(t: Translate, message: string): string {
  if (/quota|billing|insufficient_quota/i.test(message)) return t('aiStudio.aiError.quota')
  if (/rate limit/i.test(message)) return t('aiStudio.aiError.rate')
  if (/invalid api key|incorrect api key|unauthorized/i.test(message)) return t('aiStudio.aiError.auth')
  return message
}

export function reviewSummary(t: Translate, reviewFindings: ReviewFindings, mode: AiMode): string {
  if (mode === 'error') return t('aiStudio.reviewError')
  if (reviewFindings.status === 'pass') return t('aiStudio.reviewPass')
  if (reviewFindings.status === 'warn') return t('aiStudio.reviewWarn', { count: reviewFindings.issues.length })
  const blockerCount = reviewFindings.issues.filter((issue) => issue.severity === 'fail').length
  return t('aiStudio.reviewFail', { count: blockerCount })
}
