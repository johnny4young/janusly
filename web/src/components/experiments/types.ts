/**
 * Transport-safe types and display helpers for the experiment harness UI.
 *
 * Used by:
 * - `ExperimentsPanel.tsx` — list loading and mutation forms.
 * - `ExperimentSummary.tsx` — resilient summary rendering.
 *
 * Invariants:
 * - API summaries are jsonb payloads, so every nested field is validated
 *   before display. A malformed or truncated summary renders as unavailable.
 * - These types mirror API payloads without importing server packages into
 *   the browser bundle.
 */

import { getResolvedLocale } from '../../i18n'

export type ExperimentKind = 'prompt' | 'model'
export type ExperimentStatus = 'pending' | 'running' | 'completed' | 'failed'
export type Recommendation = 'promote_candidate' | 'keep_control' | 'inconclusive'
export type RecommendationReasonCode =
  | 'empty_dataset'
  | 'all_arms_failed'
  | 'scoring_fallback'
  | 'candidate_error_regression'
  | 'candidate_score_improved'
  | 'control_score_improved'
  | 'within_noise'

export type Experiment = {
  id: string
  name: string
  kind: ExperimentKind
  controlRef: string
  candidateRef: string
  evalDatasetId: string
  scorerKind: string
  status: ExperimentStatus
  summary: unknown
  createdAt: string | null
  completedAt: string | null
}

export type EvalDataset = {
  id: string
  name: string
  description: string
  exampleCount: number
  retentionDays: number | null
}

export type SideSummary = {
  meanScore: number
  totalCostUsd: number
  costKnownCount: number
  meanLatencyMs: number
  errorCount: number
  judgedByLlmCount: number
  scoringFallbackCount: number
}

export type ExperimentSummary = {
  scorerKind: string
  exampleCount: number
  control: SideSummary
  candidate: SideSummary
  scoreDelta: number
  costDelta: number
  recommendation: Recommendation
  recommendationReasonCode: RecommendationReasonCode | null
}

export type RunForm = {
  name: string
  kind: ExperimentKind
  controlRef: string
  candidateRef: string
  evalDatasetId: string
  scorerKind: 'string_equality' | 'json_schema' | 'llm_judge'
}

export const INITIAL_RUN_FORM: RunForm = {
  name: '',
  kind: 'prompt',
  controlRef: '',
  candidateRef: '',
  evalDatasetId: '',
  scorerKind: 'string_equality',
}

export const DEFAULT_MAX_PROVIDER_CALLS = 20

export function estimateProviderCalls(exampleCount: number, scorerKind: RunForm['scorerKind']): number {
  if (!Number.isFinite(exampleCount) || exampleCount <= 0) return 0
  return Math.floor(exampleCount) * (scorerKind === 'llm_judge' ? 4 : 2)
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0
}

function isNonNegativeInteger(value: unknown): value is number {
  return isNonNegativeNumber(value) && Number.isSafeInteger(value)
}

const recommendationReasonCodes: readonly string[] = [
  'empty_dataset',
  'all_arms_failed',
  'scoring_fallback',
  'candidate_error_regression',
  'candidate_score_improved',
  'control_score_improved',
  'within_noise',
]

function parseSide(value: unknown): SideSummary | null {
  const record = asRecord(value)
  if (!record) return null
  if (!isNonNegativeNumber(record.meanScore) || record.meanScore > 1 ||
      !isNonNegativeNumber(record.totalCostUsd) || !isNonNegativeNumber(record.meanLatencyMs) ||
      !isNonNegativeInteger(record.costKnownCount) || !isNonNegativeInteger(record.errorCount) ||
      !isNonNegativeInteger(record.judgedByLlmCount)) return null
  // Summaries persisted before scoring provenance was introduced remain
  // renderable and explicitly mean zero recorded fallbacks.
  const scoringFallbackCount = record.scoringFallbackCount === undefined
    ? 0
    : record.scoringFallbackCount
  if (!isNonNegativeInteger(scoringFallbackCount)) return null
  return { ...record, scoringFallbackCount } as SideSummary
}

export function parseSummary(value: unknown): ExperimentSummary | null {
  const record = asRecord(value)
  if (!record || typeof record.scorerKind !== 'string') return null
  const control = parseSide(record.control)
  const candidate = parseSide(record.candidate)
  const recommendation = record.recommendation
  if (!control || !candidate || !isNonNegativeInteger(record.exampleCount) ||
      !isFiniteNumber(record.scoreDelta) || record.scoreDelta < -1 || record.scoreDelta > 1 ||
      !isFiniteNumber(record.costDelta)) return null
  if (!['promote_candidate', 'keep_control', 'inconclusive'].includes(recommendation as string)) return null
  const reasonCode = record.recommendationReasonCode
  if (reasonCode !== undefined && (typeof reasonCode !== 'string' || !recommendationReasonCodes.includes(reasonCode))) return null
  return {
    ...record,
    control,
    candidate,
    recommendationReasonCode: reasonCode ?? null,
  } as ExperimentSummary
}

export function formatCurrency(value: number): string {
  return value.toLocaleString(getResolvedLocale(), { style: 'currency', currency: 'USD', maximumFractionDigits: 4 })
}

export function formatPercent(value: number): string {
  return `${formatScorePoints(value)}%`
}

export function formatScorePoints(value: number): string {
  return value.toLocaleString(getResolvedLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })
}

export function formatDate(value: string | null): string | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString(getResolvedLocale())
}

export function formatDelta(value: number, format: (value: number) => string): string {
  return `${value > 0 ? '+' : ''}${format(value)}`
}

export function updateExperiment(list: Experiment[], next: Experiment): Experiment[] {
  return [next, ...list.filter((experiment) => experiment.id !== next.id)]
}
