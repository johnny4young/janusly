export type LogLevel = "debug" | "info" | "warn" | "error";

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
