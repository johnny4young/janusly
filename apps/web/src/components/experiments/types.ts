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

export type ExperimentKind = 'prompt' | 'model' | 'prompt_and_model'
export type ExperimentStatus = 'pending' | 'running' | 'completed' | 'failed'
export type Recommendation = 'promote_candidate' | 'keep_control' | 'inconclusive'

export type Experiment = {
  id: string
  name: string
  kind: ExperimentKind
  controlRef: string
  candidateRef: string
  evalDatasetId: string
  scorerKind: string
  status: ExperimentStatus
  summaryJson: unknown
  createdAt: string | null
  completedAt: string | null
}

export type EvalDataset = {
  id: string
  name: string
  description: string
  exampleCount: number
}

export type SideSummary = {
  meanScore: number
  totalCostUsd: number
  costKnownCount: number
  meanLatencyMs: number
  errorCount: number
  judgedByLlmCount: number
}

export type ExperimentSummary = {
  scorerKind: string
  exampleCount: number
  control: SideSummary
  candidate: SideSummary
  scoreDelta: number
  costDelta: number
  recommendation: Recommendation
}

export type RunForm = {
  name: string
  kind: ExperimentKind
  controlRef: string
  candidateRef: string
  evalDatasetId: string
  scorerKind: 'string_equality' | 'json_schema' | 'llm_judge'
  judgeModelHint: string
}

export const INITIAL_RUN_FORM: RunForm = {
  name: '',
  kind: 'prompt',
  controlRef: '',
  candidateRef: '',
  evalDatasetId: '',
  scorerKind: 'string_equality',
  judgeModelHint: '',
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function parseSide(value: unknown): SideSummary | null {
  const record = asRecord(value)
  if (!record) return null
  const fields = ['meanScore', 'totalCostUsd', 'costKnownCount', 'meanLatencyMs', 'errorCount', 'judgedByLlmCount'] as const
  if (!fields.every((field) => isFiniteNumber(record[field]))) return null
  return {
    meanScore: record.meanScore as number,
    totalCostUsd: record.totalCostUsd as number,
    costKnownCount: record.costKnownCount as number,
    meanLatencyMs: record.meanLatencyMs as number,
    errorCount: record.errorCount as number,
    judgedByLlmCount: record.judgedByLlmCount as number,
  }
}

export function parseSummary(value: unknown): ExperimentSummary | null {
  const record = asRecord(value)
  if (!record || typeof record.scorerKind !== 'string') return null
  const control = parseSide(record.control)
  const candidate = parseSide(record.candidate)
  const recommendation = record.recommendation
  if (!control || !candidate || !isFiniteNumber(record.exampleCount) || !isFiniteNumber(record.scoreDelta) || !isFiniteNumber(record.costDelta)) return null
  if (recommendation !== 'promote_candidate' && recommendation !== 'keep_control' && recommendation !== 'inconclusive') return null
  return {
    scorerKind: record.scorerKind,
    exampleCount: record.exampleCount,
    control,
    candidate,
    scoreDelta: record.scoreDelta,
    costDelta: record.costDelta,
    recommendation,
  }
}

export function formatCurrency(value: number): string {
  return new Intl.NumberFormat(getResolvedLocale(), { style: 'currency', currency: 'USD', maximumFractionDigits: 4 }).format(value)
}

export function formatPercent(value: number): string {
  return `${new Intl.NumberFormat(getResolvedLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value)}%`
}

export function formatScorePoints(value: number): string {
  return new Intl.NumberFormat(getResolvedLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value)
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
