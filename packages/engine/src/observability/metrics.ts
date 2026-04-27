import { metrics } from "@opentelemetry/api";

const meter = metrics.getMeter("janusly");

export const nodeDuration = meter.createHistogram("workflow_node_duration_ms", {
  description: "Execution time per node",
});

export const nodeFailures = meter.createCounter("workflow_node_failures_total", {
  description: "Total failed node executions",
});

export const nodeRetries = meter.createCounter("workflow_node_retries_total", {
  description: "Total retry attempts",
});

export function recordNodeDuration(value: number, attrs: Record<string, any>) {
  nodeDuration.record(value, attrs);
}

export function incNodeFailure(attrs: Record<string, any>) {
  nodeFailures.add(1, attrs);
}

export function incNodeRetry(attrs: Record<string, any>) {
  nodeRetries.add(1, attrs);
}
