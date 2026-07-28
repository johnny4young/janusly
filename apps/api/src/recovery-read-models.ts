/**
 * Shared read models used by both focused recovery endpoints and the
 * coalesced Home snapshot. Keeping composition here prevents the two delivery
 * shapes from drifting while preserving the existing focused routes.
 */

import {
  getOrgConfigSnapshot,
  queryFailureSamples,
  queryRecoveryMetricsSignals,
  queryRecoveryRecurrence,
} from "@janusly/data";
import { clusterFailureSamples } from "@janusly/engine/src/cluster-failures";
import { composeRecoveryMetrics } from "@janusly/engine/src/recovery-metrics";

import {
  getCachedRecoveryMetrics,
  setCachedRecoveryMetrics,
} from "./metrics-cache";

export async function queryRecoveryMetricsReadModel(
  orgId: string,
  windowDays: number,
): Promise<ReturnType<typeof composeRecoveryMetrics>> {
  const cached = getCachedRecoveryMetrics(orgId, windowDays);
  if (cached) {
    return cached as ReturnType<typeof composeRecoveryMetrics>;
  }
  const [signals, snapshot] = await Promise.all([
    queryRecoveryMetricsSignals(orgId, windowDays),
    getOrgConfigSnapshot(orgId),
  ]);
  const metrics = composeRecoveryMetrics(
    signals,
    windowDays,
    snapshot.value,
  );
  setCachedRecoveryMetrics(orgId, windowDays, metrics);
  return metrics;
}

export async function queryFailureClustersReadModel(
  orgId: string,
  windowDays: number,
  now = new Date(),
) {
  const since = new Date(
    now.getTime() - windowDays * 24 * 60 * 60 * 1000,
  );
  const [samples, recurrence] = await Promise.all([
    queryFailureSamples(orgId, windowDays),
    queryRecoveryRecurrence(orgId, since),
  ]);
  const recurredSignatures = new Set(
    recurrence.recurredSignatures,
  );
  const clusters = clusterFailureSamples(samples).map((cluster) => ({
    ...cluster,
    recurredAfterRecovery: recurredSignatures.has(cluster.signature),
  }));
  return { clusters, totalSamples: samples.length, windowDays };
}
