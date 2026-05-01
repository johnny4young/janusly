/**
 * Minimal structured logger — emits one JSON line per call to stdout/stderr
 * so the standard log shipper picks the entries up. No log-level filtering;
 * callers decide when to log. The OTel tracer + meter live next door
 * (`otel.ts`, `prometheus.ts`); use those for metrics rather than `log()`.
 *
 * Used by `core/runtime.ts` for run/node lifecycle entries.
 */

/** Severity filter consumed by `log`. `error` writes to stderr; others to stdout. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Emit one structured JSON log line. `meta` is shallow-merged into the entry. */
export function log(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    ...meta,
  };

  if (level === "error") {
    console.error(JSON.stringify(entry));
  } else if (level === "warn") {
    console.warn(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

/** Convenience wrapper that emits a `workflow.node` event with the standard payload shape. */
export function logNodeEvent(event: {
  runId: string;
  nodeId?: string;
  type: string;
  attempt?: number;
  durationMs?: number;
  error?: unknown;
}) {
  log("info", "workflow.node", event);
}
