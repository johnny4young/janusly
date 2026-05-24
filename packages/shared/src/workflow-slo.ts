/**
 * Workflow SLO contract — per-workflow reliability targets the operator can
 * declare against the same signals `computeWorkflowHealth` already collects.
 *
 * Two layers:
 *   - `WorkflowSloSchema` validates the persisted blob on `workflow_versions.slo_json`.
 *     All fields are nullable so the operator can declare any subset.
 *   - `evaluateWorkflowSlo(slo, signals)` returns boolean breaches. Pure — no I/O.
 *
 * v1 evaluates `successRatePercent` and `p95DurationMs` against the shipped
 * `HealthSignals` shape. `mttrSeconds`, `budgetBlocksPerWindow`, and
 * `stuckWaitingNodesMax` are accepted in the schema and persisted (forward-compat
 * for when the corresponding signals are wired) but their breach flags always
 * return `false` in v1. This keeps the schema stable so a future signal-wiring
 * change does not require a column migration.
 *
 * Sample-size guard: success-rate and p95 breaches do not fire when
 * `totalRuns < MIN_SAMPLE_SIZE` (mirrors the neutral-default rule in
 * `computeWorkflowHealth` — a never-run workflow is untested, not breaching).
 */

import { z } from 'zod'

/** Minimum runs in the window before success-rate / p95 SLO breaches can fire. */
export const MIN_SAMPLE_SIZE = 5

export const WORKFLOW_SLO_WINDOW_DAYS = [7, 14, 30] as const

export const WorkflowSloSchema = z.object({
  successRatePercent: z.number().min(0).max(100).nullable(),
  mttrSeconds: z.number().int().min(0).nullable(),
  p95DurationMs: z.number().int().min(0).nullable(),
  budgetBlocksPerWindow: z.number().int().min(0).nullable(),
  stuckWaitingNodesMax: z.number().int().min(0).nullable(),
  windowDays: z.union([z.literal(7), z.literal(14), z.literal(30)]),
})

export type WorkflowSlo = z.infer<typeof WorkflowSloSchema>

export const WorkflowSloBreachesSchema = z.object({
  successRatePercent: z.boolean(),
  mttrSeconds: z.boolean(),
  p95DurationMs: z.boolean(),
  budgetBlocksPerWindow: z.boolean(),
  stuckWaitingNodesMax: z.boolean(),
  anyBreach: z.boolean(),
})

export type WorkflowSloBreaches = z.infer<typeof WorkflowSloBreachesSchema>

/**
 * Minimal signal shape consumed by SLO evaluation. Structurally compatible
 * with the engine's `HealthSignals` so callers can pass it through directly.
 * Optional fields are forward-compat hooks for v2 signal wiring.
 */
export type WorkflowSloSignals = {
  totalRuns: number
  successCount: number
  p95LatencyMs: number | null
  mttrSeconds?: number | null
  budgetBlocksInWindow?: number | null
  stuckWaitingNodesCount?: number | null
}

const EMPTY_BREACHES: WorkflowSloBreaches = {
  successRatePercent: false,
  mttrSeconds: false,
  p95DurationMs: false,
  budgetBlocksPerWindow: false,
  stuckWaitingNodesMax: false,
  anyBreach: false,
}

/**
 * Evaluate the SLO against the latest signals. Returns per-metric breach
 * booleans plus a top-level `anyBreach` rollup. A `null` threshold means
 * "the operator did not declare this metric" — never a breach.
 */
export function evaluateWorkflowSlo(
  slo: WorkflowSlo | null,
  signals: WorkflowSloSignals,
): WorkflowSloBreaches {
  if (slo === null) return EMPTY_BREACHES

  const hasSamples = signals.totalRuns >= MIN_SAMPLE_SIZE

  const successRateBreach =
    slo.successRatePercent !== null && hasSamples
      ? (signals.successCount / Math.max(signals.totalRuns, 1)) * 100 < slo.successRatePercent
      : false

  const p95Breach =
    slo.p95DurationMs !== null && hasSamples && signals.p95LatencyMs !== null
      ? signals.p95LatencyMs > slo.p95DurationMs
      : false

  const mttrBreach =
    slo.mttrSeconds !== null &&
    signals.mttrSeconds !== undefined &&
    signals.mttrSeconds !== null
      ? signals.mttrSeconds > slo.mttrSeconds
      : false

  const budgetBreach =
    slo.budgetBlocksPerWindow !== null &&
    signals.budgetBlocksInWindow !== undefined &&
    signals.budgetBlocksInWindow !== null
      ? signals.budgetBlocksInWindow > slo.budgetBlocksPerWindow
      : false

  const stuckBreach =
    slo.stuckWaitingNodesMax !== null &&
    signals.stuckWaitingNodesCount !== undefined &&
    signals.stuckWaitingNodesCount !== null
      ? signals.stuckWaitingNodesCount > slo.stuckWaitingNodesMax
      : false

  const anyBreach =
    successRateBreach || p95Breach || mttrBreach || budgetBreach || stuckBreach

  return {
    successRatePercent: successRateBreach,
    mttrSeconds: mttrBreach,
    p95DurationMs: p95Breach,
    budgetBlocksPerWindow: budgetBreach,
    stuckWaitingNodesMax: stuckBreach,
    anyBreach,
  }
}
