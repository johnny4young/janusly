import { HomeInsights } from '@janusly/web'
import {
  NOW_MS,
  clustersResponse,
  heatmapCells,
  heatmapDays,
  operatorWins,
  recoveryLedger,
  recoveryMetrics,
  validationReport,
} from './_fixtures'

/**
 * The expandable evidence section under the Recovery Center hero: the 30-day
 * metrics, the failure heatmap, the clustered causes, and the drill validation
 * report — everything that backs the single health number above it.
 *
 * `nowMs` is passed in rather than read from the clock so the relative times
 * and the heatmap window stay deterministic; this preview pins it.
 *
 * `showRecoveryLab` is the invitation to run a recovery drill; dismissing it
 * (`onDismissRecoveryLab`) removes that one card and leaves the rest of the
 * section unchanged, which is why only the showing state gets a cell.
 *
 * Several tiles are driven by OPTIONAL metrics (`timeToFirstAction`,
 * `recurrenceRate`, `clustersResolved`). Older API responses omit them and the
 * tiles fall back to an em dash — correct, but it means a partial metrics
 * payload renders a half-empty card.
 */

const shared = {
  metrics: recoveryMetrics,
  openFailureCount: 12,
  waitingApprovals: 3,
  clusters: clustersResponse,
  heatmap: heatmapDays,
  heatmapCells,
  nowMs: NOW_MS,
  validation: validationReport,
  ledger: recoveryLedger,
  personalWins: operatorWins,
  recentDlqRunId: 'run_9f21c4',
  onOpenTab: () => {},
  onOpenRecoveryQueue: () => {},
  onStartRecoveryDrill: () => {},
  onDismissRecoveryLab: () => {},
}

/** A full window of evidence, with the recovery-drill invitation showing. */
export function FullWindow() {
  return <HomeInsights {...shared} showRecoveryLab />
}
