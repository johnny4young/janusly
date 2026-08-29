import { ExperimentSummaryDetail } from '@janusly/web'

/**
 * The result of one offline experiment: a control prompt or model against a
 * candidate, scored over an eval dataset.
 *
 * `summaryJson` arrives as raw jsonb, so the component validates it before
 * displaying anything — a malformed or truncated summary renders as
 * unavailable rather than as partial numbers. `recommendation` is the payload's
 * own verdict (`promote_candidate`, `keep_control`, `inconclusive`), not
 * something the UI derives from the deltas.
 *
 * `status` matters for more than a pill: the component builds an i18n key from
 * it (`experiments.status.<status>`), so an experiment without one renders the
 * raw key.
 */

const base = {
  id: 'exp_5c81a0',
  name: 'Tighter classifier prompt',
  kind: 'prompt' as const,
  controlRef: 'prompt_v3',
  candidateRef: 'prompt_v4',
  evalDatasetId: 'ds_invoice_120',
  scorerKind: 'llm_judge',
  createdAt: '2026-08-26T08:00:00.000Z',
}

const side = (
  meanScore: number,
  totalCostUsd: number,
  meanLatencyMs: number,
  errorCount: number,
) => ({
  meanScore,
  totalCostUsd,
  costKnownCount: 120,
  meanLatencyMs,
  errorCount,
  judgedByLlmCount: 120,
})

/** A finished run where the candidate wins on score and costs less. */
export function CandidateWins() {
  return (
    <ExperimentSummaryDetail
      loading={false}
      onCopyCandidate={() => {}}
      experiment={{
        ...base,
        status: 'completed',
        completedAt: '2026-08-26T08:41:00.000Z',
        summaryJson: {
          scorerKind: 'llm_judge',
          exampleCount: 120,
          control: side(0.812, 1.94, 2140, 2),
          candidate: side(0.907, 1.41, 1680, 0),
          scoreDelta: 0.095,
          costDelta: -0.53,
          recommendation: 'promote_candidate',
        },
      }}
    />
  )
}

/** Still running — the summary is not there yet, and the card says so. */
export function Running() {
  return (
    <ExperimentSummaryDetail
      loading
      onCopyCandidate={() => {}}
      experiment={{ ...base, status: 'running', completedAt: null, summaryJson: null }}
    />
  )
}

/** A failed run: no summary to validate, so nothing is presented as a result. */
export function Failed() {
  return (
    <ExperimentSummaryDetail
      loading={false}
      onCopyCandidate={() => {}}
      experiment={{
        ...base,
        status: 'failed',
        completedAt: '2026-08-26T08:12:00.000Z',
        summaryJson: null,
      }}
    />
  )
}
