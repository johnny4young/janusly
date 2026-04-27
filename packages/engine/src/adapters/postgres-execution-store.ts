import {
  appendEvent,
  getRunContext,
  getRunStatus,
  markNodeFailed,
  markNodeQueued,
  markNodeRunning,
  markNodeSkipped,
  markNodeSucceeded,
  markNodeWaiting,
  tryClaimNodeForQueue,
  updateRunStatusFromNodes,
} from "../persistence";
import { getNodeStatus } from "../get-node-status";
import type { ExecutionStore, NodeStatus, RunStatus, SerializedError, WorkflowEvent } from "../core/types";

export class PostgresExecutionStore implements ExecutionStore {
  getRunContext(runId: string) {
    return getRunContext(runId);
  }

  async getRunStatus(runId: string): Promise<RunStatus | null> {
    return getRunStatus(runId) as Promise<RunStatus | null>;
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

  markNodeRunning(runId: string, nodeId: string, attempt?: number) {
    return markNodeRunning(runId, nodeId, attempt);
  }

  markNodeSucceeded(runId: string, nodeId: string, output: unknown) {
    return markNodeSucceeded(runId, nodeId, output);
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
