/**
 * Stable compatibility surface for recovery metrics persistence.
 *
 * Implementation is partitioned by transaction and read-model responsibility
 * under `recovery-metrics/`. Consumers continue importing this module or the
 * `@janusly/data` package root.
 */

export {
  COST_BREAKDOWN_GROUP_CAP,
  COST_BREAKDOWN_OTHER_KEY,
  type CostProviderRowRepo,
  type MttrTrendPointRepo,
  type RecoveryHeatmapDay,
  type RecoveryImpactCompletion,
  type RecoveryLedgerRepo,
  type RecoveryMetricsSignals,
  type RecoveryRecurrenceRepo,
  type ReplayOutcomeCountsRepo,
  type ResolvedClustersRepo,
  type RunStatusCountsRepo,
  type SlaAttainmentRepo,
  type TimeToFirstActionRepo,
  type VerifiedRecoveryStatsRepo,
} from "./recovery-metrics/contracts";
export { queryFailureClustersResolved } from "./recovery-metrics/clusters";
export {
  queryRecoveryRecurrence,
  queryRecoverySlaAttainment,
  queryTimeToFirstAction,
} from "./recovery-metrics/effectiveness";
export { recordRecoveryImpactTx } from "./recovery-metrics/impact";
export {
  queryOperatorRecoveryCount,
  queryRecoveryLedger,
} from "./recovery-metrics/ledger";
export {
  queryRecoveryHeatmap,
  queryRecoveryMetricsSignals,
} from "./recovery-metrics/signals";
