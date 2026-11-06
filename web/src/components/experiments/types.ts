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
import { asRecord, isFiniteNumber } from '../../lib/guards'

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

/** experiment.MinScoreDelta: smaller mean-score changes are noise to the recommendation. */
export const MIN_SCORE_DELTA = 0.05

export function formatList(items: string[]): string {
  return new Intl.ListFormat(getResolvedLocale(), { type: 'conjunction' }).format(items)
}

/** Byte limits the API enforces on the trimmed values the panel sends. */
export const TEXT_LIMITS = { name: 120, ref: 256, datasetName: 120, datasetDescription: 2000 } as const

const utf8 = new TextEncoder()
export function utf8Length(value: string): number {
  return utf8.encode(value.trim()).length
}

export const SETUP_STEPS = ['dataset', 'arms', 'run'] as const
export type SetupStep = typeof SETUP_STEPS[number]
export type DatasetsState = 'loading' | 'failed' | 'ready'

export type RunBlocker = {
  step: SetupStep
  reason: 'datasetsLoading' | 'datasetsFailed' | 'noDataset' | 'chooseDataset' | 'emptyDataset' | 'datasetTooLarge' | 'control' | 'candidate' | 'refTooLong' | 'callLimit' | 'name' | 'nameTooLong'
  field: string
}

/** Everything still missing, in step order. The first entry names the run button's blocker. */
export function getRunBlockers(
  form: RunForm,
  datasets: readonly EvalDataset[],
  datasetsState: DatasetsState,
  maxProviderCalls: number,
): RunBlocker[] {
  const blockers: RunBlocker[] = []
  const dataset = datasets.find((item) => item.id === form.evalDatasetId)
  if (!dataset) {
    const reason = datasets.length > 0 ? 'chooseDataset'
      : datasetsState === 'loading' ? 'datasetsLoading'
        : datasetsState === 'failed' ? 'datasetsFailed' : 'noDataset'
    const field = reason === 'noDataset' ? 'experiment-dataset-name'
      : reason === 'datasetsFailed' ? 'experiment-datasets-retry' : 'experiment-dataset'
    blockers.push({ step: 'dataset', reason, field })
  } else if (!(dataset.exampleCount > 0)) {
    blockers.push({ step: 'dataset', reason: 'emptyDataset', field: 'experiment-dataset' })
  } else if (estimateProviderCalls(dataset.exampleCount, 'string_equality') > maxProviderCalls) {
    blockers.push({ step: 'dataset', reason: 'datasetTooLarge', field: 'experiment-dataset' })
  }
  for (const [key, field] of [['controlRef', 'experiment-control'], ['candidateRef', 'experiment-candidate']] as const) {
    if (!form[key].trim()) blockers.push({ step: 'arms', reason: key === 'controlRef' ? 'control' : 'candidate', field })
    else if (utf8Length(form[key]) > TEXT_LIMITS.ref) blockers.push({ step: 'arms', reason: 'refTooLong', field })
  }
  if (dataset && estimateProviderCalls(dataset.exampleCount, 'string_equality') <= maxProviderCalls
    && estimateProviderCalls(dataset.exampleCount, form.scorerKind) > maxProviderCalls) {
    blockers.push({ step: 'run', reason: 'callLimit', field: 'experiment-scorer' })
  }
  if (!form.name.trim()) blockers.push({ step: 'run', reason: 'name', field: 'experiment-name' })
  else if (utf8Length(form.name) > TEXT_LIMITS.name) blockers.push({ step: 'run', reason: 'nameTooLong', field: 'experiment-name' })
  return blockers
}

export function estimateProviderCalls(exampleCount: number, scorerKind: RunForm['scorerKind']): number {
  if (!Number.isFinite(exampleCount) || exampleCount <= 0) return 0
  return Math.floor(exampleCount) * (scorerKind === 'llm_judge' ? 4 : 2)
}

export { asRecord }

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
