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
  claimNodeForExecution,
  getRunContext,
  getRunMetadata,
  getRunStatus,
  markExecutingNodeFailed,
  markExecutingNodeQueued,
  markQueuePublicationSucceeded,
  markNodeSkipped,
  markNodeSucceeded,
  markNodeSucceededWithEvent,
  markNodeSucceededWithOutcome,
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

  markNodeQueued(runId: string, nodeId: string, attempt?: number, recoveryClaimToken?: string, delayMs?: number) {
    return markExecutingNodeQueued(runId, nodeId, attempt, recoveryClaimToken, delayMs);
  }

  tryClaimNodeForQueue(runId: string, nodeId: string, attempt?: number) {
    return tryClaimNodeForQueue(runId, nodeId, attempt);
  }

  claimNodeForExecution(
    runId: string,
    nodeId: string,
    attempt?: number,
    recoveryClaimToken?: string,
    publicationGeneration?: number,
  ) {
    return claimNodeForExecution(runId, nodeId, attempt, recoveryClaimToken, publicationGeneration);
  }

  markQueuePublicationSucceeded(
    runId: string,
    nodeId: string,
    attempt: number,
    publicationGeneration: number,
    recoveryClaimToken?: string,
  ) {
    return markQueuePublicationSucceeded(
      runId,
      nodeId,
      attempt,
      publicationGeneration,
      recoveryClaimToken,
    );
  }

  markNodeSucceeded(runId: string, nodeId: string, output: unknown, recoveryClaimToken?: string) {
    return markNodeSucceeded(runId, nodeId, output, recoveryClaimToken);
  }

  markNodeSucceededWithEvent(runId: string, nodeId: string, output: unknown, attempt: number, recoveryClaimToken?: string) {
    return markNodeSucceededWithEvent(runId, nodeId, output, attempt, recoveryClaimToken);
  }

  markNodeSucceededWithOutcome(
    runId: string,
    nodeId: string,
    output: unknown,
    attempt: number,
    violations: Parameters<ExecutionStore["markNodeSucceededWithOutcome"]>[4],
    recoveryClaimToken?: string,
  ) {
    return markNodeSucceededWithOutcome(
      runId,
      nodeId,
      output,
      attempt,
      violations,
      recoveryClaimToken,
    );
  }

  markNodeFailed(runId: string, nodeId: string, error: SerializedError, recoveryClaimToken?: string) {
    return markExecutingNodeFailed(runId, nodeId, error, recoveryClaimToken);
  }

  markNodeWaiting(runId: string, nodeId: string, metadata?: unknown, recoveryClaimToken?: string) {
    return markNodeWaiting(runId, nodeId, metadata, recoveryClaimToken);
  }

  markNodeSkipped(runId: string, nodeId: string, metadata?: unknown) {
    return markNodeSkipped(runId, nodeId, metadata);
  }

  async appendEvent(event: WorkflowEvent): Promise<void> {
    await appendEvent(event.runId, event.nodeId ?? null, event.type, event.payload ?? {});
  }

  async updateRunStatusFromNodes(runId: string): Promise<void> {
    await updateRunStatusFromNodes(runId);
  }
}
