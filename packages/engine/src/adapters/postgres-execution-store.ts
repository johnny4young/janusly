import {
  appendEvent,
  getRunContext,
  markNodeFailed,
  markNodeQueued,
  markNodeRunning,
  markNodeSkipped,
  markNodeSucceeded,
  markNodeWaiting,
  updateRunStatusFromNodes,
} from "../persistence";
import { getNodeStatus } from "../get-node-status";
import type { ExecutionStore, NodeStatus, SerializedError, WorkflowEvent } from "../core/types";

export class PostgresExecutionStore implements ExecutionStore {
  getRunContext(runId: string) {
    return getRunContext(runId);
  }

  async getNodeStatus(runId: string, nodeId: string): Promise<NodeStatus> {
    return getNodeStatus(runId, nodeId) as Promise<NodeStatus>;
  }

  markNodeQueued(runId: string, nodeId: string) {
    return markNodeQueued(runId, nodeId);
  }

  markNodeRunning(runId: string, nodeId: string) {
    return markNodeRunning(runId, nodeId);
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

  updateRunStatusFromNodes(runId: string) {
    return updateRunStatusFromNodes(runId);
  }
}
