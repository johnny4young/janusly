export type RecoveryTimeMetrics<T> = {
  mttr: T
  verifiedRecovery?: T
}

/**
 * Prefer the versioned production-only metric while keeping older API
 * responses usable during rolling upgrades.
 */
export function selectRecoveryTimeMetric<T>(metrics: RecoveryTimeMetrics<T>): T {
  return metrics.verifiedRecovery ?? metrics.mttr
}
