import type { WorkflowEvent } from "./types";

export type WorkflowEventType =
  | "node.queued"
  | "node.running"
  | "node.retry"
  | "node.waiting"
  | "node.succeeded"
  | "node.failed"
  | "node.skipped"
  | "decision.made"
  | "run.status_checked";

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

export function nowIso() {
  return new Date().toISOString();
}
