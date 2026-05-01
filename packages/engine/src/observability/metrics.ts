/**
 * OpenTelemetry metric instruments + their thin update helpers. The meter
 * provider is configured in `prometheus.ts` (Prometheus exporter) and
 * carries the `service.name="janusly"` resource attribute via
 * `observability/resource.ts`.
 *
 * Used by `core/runtime.ts` after each node terminal status transition.
 *
 * Invariants:
 * - `attrs` keys must match the labels Prometheus dashboards filter on.
 *   Don't drop `node_type`, `org_id`, or `status` without coordinating
 *   with the dashboard owner.
 */

import { metrics } from "@opentelemetry/api";

const meter = metrics.getMeter("janusly");

/** Histogram of per-node execution time in milliseconds. */
export const nodeDuration = meter.createHistogram("workflow_node_duration_ms", {
  description: "Execution time per node",
});

/** Counter of failed node executions (all retry attempts inclusive). */
export const nodeFailures = meter.createCounter("workflow_node_failures_total", {
  description: "Total failed node executions",
});

/** Counter of retry attempts (incremented per re-enqueue, not per terminal failure). */
export const nodeRetries = meter.createCounter("workflow_node_retries_total", {
  description: "Total retry attempts",
});

/** Record one observation against `nodeDuration`. */
export function recordNodeDuration(value: number, attrs: Record<string, any>) {
  nodeDuration.record(value, attrs);
}

/** Increment `nodeFailures` by one. */
export function incNodeFailure(attrs: Record<string, any>) {
  nodeFailures.add(1, attrs);
}

/** Increment `nodeRetries` by one. */
export function incNodeRetry(attrs: Record<string, any>) {
  nodeRetries.add(1, attrs);
}
