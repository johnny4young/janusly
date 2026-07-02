/**
 * `ExecutionStore` implementation backed by Postgres via Drizzle. Thin
 * pass-through to the function-style helpers in `../persistence.ts`; the
 * adapter exists so `core/runtime.ts` can be tested with an in-memory
 * substitute without taking a Drizzle dep.
 *
 * Used by `worker.ts` (and any future runtime caller wanting Postgres
 * persistence).
 *
 * Invariants:
 * - `tryClaimNodeForQueue` is the atomic claim path. Don't
 *   reintroduce a non-atomic `markNodeQueued` for the same caller.
 */

import {
  appendEvent,
  getRunContext,
  getRunMetadata,
  getRunStatus,
  markNodeFailed,
  markNodeQueued,
  markNodeRunning,
  markNodeSkipped,
  markNodeSucceeded,
  markNodeSucceededWithEvent,
  markNodeWaiting,
  tryClaimNodeForQueue,
  updateRunStatusFromNodes,
} from "../persistence";
import { getNodeStatus } from "../get-node-status";
import type { ExecutionStore, NodeStatus, RunMetadata, RunStatus, SerializedError, WorkflowEvent } from "../core/types";

/** `ExecutionStore` implementation that delegates to `../persistence.ts`. */
export class PostgresExecutionStore implements ExecutionStore {
  getRunContext(runId: string, opts?: { statusesOnly?: boolean }) {
    return getRunContext(runId, opts);
  }

  async getRunStatus(runId: string): Promise<RunStatus | null> {
    return getRunStatus(runId) as Promise<RunStatus | null>;
  }

  async getRunMetadata(runId: string): Promise<RunMetadata | null> {
    return getRunMetadata(runId);
  }

  async getNodeStatus(runId: string, nodeId: string): Promise<NodeStatus> {
    return getNodeStatus(runId, nodeId) as Promise<NodeStatus>;
  }

  markNodeQueued(runId: string, nodeId: string, attempt?: number) {
    return markNodeQueued(runId, nodeId, attempt);
  }

  tryClaimNodeForQueue(runId: string, nodeId: string, attempt?: number) {
    return tryClaimNodeForQueue(runId, nodeId, attempt);
  }

  markNodeRunning(runId: string, nodeId: string, attempt?: number): Promise<boolean> {
    return markNodeRunning(runId, nodeId, attempt);
  }

  markNodeSucceeded(runId: string, nodeId: string, output: unknown) {
    return markNodeSucceeded(runId, nodeId, output);
  }

  markNodeSucceededWithEvent(runId: string, nodeId: string, output: unknown, attempt: number) {
    return markNodeSucceededWithEvent(runId, nodeId, output, attempt);
  }

  markNodeFailed(runId: string, nodeId: string, error: SerializedError) {
    return markNodeFailed(runId, nodeId, error);
  }

  markNodeWaiting(runId: string, nodeId: string, metadata?: unknown) {
    return markNodeWaiting(runId, nodeId, metadata);
  }

  markNodeSkipped(runId: string, nodeId: string, metadata?: unknown) {
    return markNodeSkipped(runId, nodeId, metadata);
  }

  appendEvent(event: WorkflowEvent) {
    return appendEvent(event.runId, event.nodeId ?? null, event.type, event.payload ?? {});
  }

  async updateRunStatusFromNodes(runId: string): Promise<void> {
    await updateRunStatusFromNodes(runId);
  }
}
