/**
 * Pure scorecard math for a recovery playbook — the "87% success (23 uses)"
 * line an ops lead can point at in a renewal conversation. Derived at
 * read time from the counters the substrate already keeps
 * (`recovery_playbooks.successful_uses` / `.regressions`); no new storage.
 *
 * The rate is withheld below MIN_SAMPLES total outcomes: "100%" over one use
 * is noise wearing a percent sign, and a playbook's first impression should
 * be its raw history, not a statistically empty flourish.
 *
 * Used by: `PlaybookMatchCard.tsx`, `RecoveryPassportCard.tsx`.
 */

/** Outcomes required before a percentage is honest enough to show. */
export const PLAYBOOK_SCORECARD_MIN_SAMPLES = 3

export type PlaybookScorecard = {
  /** Whole-number success percentage, or null below the sample floor. */
  ratePercent: number | null
  /** Total recorded outcomes (successes + regressions). */
  total: number
}

/** Derive the scorecard from the two persisted counters. */
export function resolvePlaybookScorecard(successfulUses: number, regressions: number): PlaybookScorecard {
  const uses = Math.max(0, successfulUses)
  const regressed = Math.max(0, regressions)
  const total = uses + regressed
  if (total < PLAYBOOK_SCORECARD_MIN_SAMPLES) return { ratePercent: null, total }
  return { ratePercent: Math.round((uses / total) * 100), total }
}
