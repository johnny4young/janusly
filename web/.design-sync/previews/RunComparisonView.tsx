import { RunComparisonView } from '@janusly/web'
import { runComparison } from './_fixtures'

/**
 * A run against its replay, node by node. Each node reports status, latency,
 * cost and tokens on both sides, so the view answers two questions at once:
 * did the replay fix it, and what did fixing it cost.
 *
 * `context` only changes the framing — `replay` presents the second run as the
 * remedy for the first, `history` presents both as peers being compared.
 */

/** Opened from the replay flow: the fix worked and the skipped steps ran. */
export function AfterReplay() {
  return <RunComparisonView payload={runComparison} context="replay" />
}

/** The same data reached from run history, where neither run is "the fix". */
export function FromHistory() {
  return <RunComparisonView payload={runComparison} context="history" />
}
