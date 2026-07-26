/**
 * OpenTelemetry metric instruments + their thin update helpers. The meter
 * provider is configured in `prometheus.ts` (Prometheus exporter) and
 * carries the `service.name="janusly"` resource attribute via
 * `observability/resource.ts`.
 *
 * Used by:
 * - `core/runtime.ts` after each node terminal status transition.
 * - `worker.ts` for workflow/maintenance queue and rate-limiter gauges.
 * - `apps/api/src/index.ts` for the API process's rate-limiter gauge.
 *
 * Invariants:
 * - `attrs` keys must match the labels Prometheus dashboards filter on.
 *   Don't drop `node_type`, `org_id`, or `status` without coordinating
 *   with the dashboard owner.
 */

import {
  metrics,
  type BatchObservableResult,
  type Counter,
  type Histogram,
  type Meter,
  type ObservableGauge,
} from "@opentelemetry/api";

type Instruments = {
  meter: Meter;
  nodeDuration: Histogram;
  nodeFailures: Counter;
  nodeRetries: Counter;
  queueWaiting: ObservableGauge;
  queueActive: ObservableGauge;
  maintenanceQueueWaiting: ObservableGauge;
  maintenanceQueueActive: ObservableGauge;
  rateLimiterDegradedBuckets: ObservableGauge;
};

let instruments: Instruments | null = null;

/**
 * Create instruments on first use, after process boot registers its provider.
 * Static imports reach this module before migration checks and provider setup;
 * eager creation would permanently bind the instruments to the no-op provider.
 */
function getInstruments(): Instruments {
  if (instruments) return instruments;
  const meter = metrics.getMeter("janusly");
  instruments = {
    meter,
    nodeDuration: meter.createHistogram("workflow_node_duration_ms", {
      description: "Execution time per node",
    }),
    nodeFailures: meter.createCounter("workflow_node_failures_total", {
      description: "Total failed node executions",
    }),
    nodeRetries: meter.createCounter("workflow_node_retries_total", {
      description: "Total retry attempts",
    }),
    queueWaiting: meter.createObservableGauge("workflow_queue_waiting_jobs", {
      description: "Jobs waiting in the workflow queue",
    }),
    queueActive: meter.createObservableGauge("workflow_queue_active_jobs", {
      description: "Jobs currently being processed",
    }),
    maintenanceQueueWaiting: meter.createObservableGauge("maintenance_queue_waiting_jobs", {
      description: "Jobs waiting in the maintenance queue",
    }),
    maintenanceQueueActive: meter.createObservableGauge("maintenance_queue_active_jobs", {
      description: "Jobs currently being processed by maintenance workers",
    }),
    rateLimiterDegradedBuckets: meter.createObservableGauge(
      "janusly_rate_limit_degraded_buckets",
      { description: "Rate-limiter buckets currently degraded in this process" },
    ),
  };
  return instruments;
}

type QueueCounts = { waiting: number; active: number };

function isGaugeCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Register asynchronous observations for one named delivery lane.
 *
 * Collection is deliberately fail-soft: Redis faults or malformed adapter
 * values omit this scrape's observations instead of rejecting the complete
 * metrics collection. Returns an unregister function for graceful shutdown.
 */
export function registerQueueObservables(
  getCounts: () => QueueCounts | Promise<QueueCounts>,
  queueKind: "workflow" | "maintenance" = "workflow",
): () => void {
  const instruments = getInstruments();
  const { meter } = instruments;
  const queueWaiting = queueKind === "workflow"
    ? instruments.queueWaiting
    : instruments.maintenanceQueueWaiting;
  const queueActive = queueKind === "workflow"
    ? instruments.queueActive
    : instruments.maintenanceQueueActive;
  const callback = async (result: BatchObservableResult) => {
    try {
      const counts = await getCounts();
      if (!isGaugeCount(counts.waiting) || !isGaugeCount(counts.active)) return;
      result.observe(queueWaiting, counts.waiting);
      result.observe(queueActive, counts.active);
    } catch {
      // Metrics must never interfere with queue execution or worker health.
    }
  };
  meter.addBatchObservableCallback(callback, [queueWaiting, queueActive]);
  return () => meter.removeBatchObservableCallback(callback, [queueWaiting, queueActive]);
}

/**
 * Register the process-local count of rate-limiter buckets failing open.
 * Invalid values and snapshot failures omit the observation for that scrape.
 */
export function registerRateLimiterObservables(
  getDegradedBucketCount: () => number | Promise<number>,
): () => void {
  const { meter, rateLimiterDegradedBuckets } = getInstruments();
  const callback = async (result: BatchObservableResult) => {
    try {
      const count = await getDegradedBucketCount();
      if (!isGaugeCount(count)) return;
      result.observe(rateLimiterDegradedBuckets, count);
    } catch {
      // The limiter's fail-open posture includes its observability path.
    }
  };
  meter.addBatchObservableCallback(callback, [rateLimiterDegradedBuckets]);
  return () => meter.removeBatchObservableCallback(callback, [rateLimiterDegradedBuckets]);
}

/** Record one observation against `nodeDuration`. */
export function recordNodeDuration(value: number, attrs: Record<string, any>) {
  getInstruments().nodeDuration.record(value, attrs);
}

/** Increment `nodeFailures` by one. */
export function incNodeFailure(attrs: Record<string, any>) {
  getInstruments().nodeFailures.add(1, attrs);
}

/** Increment `nodeRetries` by one. */
export function incNodeRetry(attrs: Record<string, any>) {
  getInstruments().nodeRetries.add(1, attrs);
}
