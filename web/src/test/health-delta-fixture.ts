import type { ApiResponses } from '../lib/api-types.generated'

type Delta = ApiResponses['GET /workflows/health/delta']
type Score = Delta['before']
type ScoreInput = { score: number; status: string; signals: Partial<Score['signals']> }

const entry = { score: 100, rationale: '', rationaleCode: 'ok' }

/** A manifest-complete health score from the fields the recovery UI reads. */
export function healthScore({ score, status, signals }: ScoreInput): Score {
  return {
    score,
    status: status as Score['status'],
    breakdown: { aiRisk: entry, cost: entry, latency: entry, maintainability: entry, reliability: entry, safety: entry },
    signals: {
      dlqOpenCount: 0, failureCount: 0, p95LatencyMs: null, retryCount: 0, successCount: 0,
      totalCostUsd: 0, totalRuns: 0, totalTokens: 0, versionCount: 1, ...signals,
    },
    slo: null,
  }
}

/** A manifest-complete health delta; `before`/`after` take the UI subset. */
export function healthDelta(value: Omit<Delta, 'before' | 'after'> & { before: ScoreInput; after: ScoreInput }): Delta {
  return { ...value, before: healthScore(value.before), after: healthScore(value.after) }
}
