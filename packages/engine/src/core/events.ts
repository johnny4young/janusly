/**
 * Workflow event type catalogue + builder. The runtime emits these strings
 * from `core/runtime.ts` and `node-registry.ts`; the web's run timeline +
 * Multi-agent timeline parse them downstream.
 *
 * Used by `core/runtime.ts`, `node-registry.ts`, `start-run.ts`, and the web
 * panels that consume `run_events.type`.
 *
 * Invariants:
 * - Event-type strings are part of the cross-process contract. Renaming any
 *   string here means updating the web consumers (`MultiAgentTimeline.tsx`,
 *   `eventUtils.ts`) and any downstream analytics that filter on them.
 */

import type { WorkflowEvent } from "./types";

/** Closed enum of event types the runtime emits to `run_events`. */
export type WorkflowEventType =
  | "node.queued"
  | "node.running"
  | "node.retry"
  | "node.waiting"
  | "node.succeeded"
  | "node.failed"
  | "node.skipped"
  | "decision.made"
  | "improvement.evaluated"
  | "rollback.triggered"
  | "rollback.completed"
  | "run.status_checked";

/** Build a `WorkflowEvent` with a fresh timestamp and defaulted `payload`. */
export function workflowEvent(input: {
  runId: string;
  nodeId?: string;
  type: WorkflowEventType;
  payload?: unknown;
}): WorkflowEvent {
  return {
    runId: input.runId,
    nodeId: input.nodeId,
    type: input.type,
    payload: input.payload ?? {},
    timestamp: new Date(),
  };
}

/** Current time as an ISO-8601 string — used in event payload bodies. */
export function nowIso() {
  return new Date().toISOString();
}
