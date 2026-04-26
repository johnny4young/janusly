import type { Workflow, WorkflowNode } from "@workflow-engine/shared";

export type NodeTerminalStatus = "succeeded" | "failed" | "skipped" | "cancelled";

export type NodeStatus =
  | "pending"
  | "queued"
  | "running"
  | "waiting"
  | NodeTerminalStatus;

export type RunStatus =
  | "created"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

export type SerializedError = {
  message: string;
  name?: string;
  stack?: string;
  cause?: unknown;
};

export type RetryBackoffStrategy = "fixed" | "exponential";

export type RetryPolicy = {
  maxAttempts?: number;
  delayMs?: number;
  backoff?: RetryBackoffStrategy;
};

export type RunContext = Record<string, unknown>;

export type WorkflowEvent = {
  runId: string;
  nodeId?: string;
  type: string;
  payload?: unknown;
  timestamp?: Date;
};

export type NodeExecutionResult =
  | {
      status?: "succeeded";
      output?: unknown;
      metadata?: unknown;
    }
  | {
      status: "waiting";
      output?: unknown;
      metadata?: unknown;
    };

export type ExecuteNodeInput = {
  runId: string;
  node: WorkflowNode;
  context: RunContext;
  attempt: number;
};

export type ExecuteQueuedNodeInput = {
  runId: string;
  workflow: Workflow;
  node: WorkflowNode;
  attempt?: number;
};

export type EnqueueNodeInput = {
  runId: string;
  workflow: Workflow;
  node: WorkflowNode;
  delayMs?: number;
};

export type EnqueueReadyNodesInput = {
  runId: string;
  workflow: Workflow;
};

export interface ExecutionStore {
  getRunContext(runId: string): Promise<RunContext>;
  getNodeStatus(runId: string, nodeId: string): Promise<NodeStatus>;
  markNodeQueued(runId: string, nodeId: string): Promise<void>;
  markNodeRunning(runId: string, nodeId: string): Promise<void>;
  markNodeSucceeded(runId: string, nodeId: string, output: unknown): Promise<void>;
  markNodeFailed(runId: string, nodeId: string, error: SerializedError): Promise<void>;
  markNodeWaiting(runId: string, nodeId: string, metadata?: unknown): Promise<void>;
  markNodeSkipped(runId: string, nodeId: string, metadata?: unknown): Promise<void>;
  appendEvent(event: WorkflowEvent): Promise<void>;
  updateRunStatusFromNodes(runId: string): Promise<void>;
}

export interface QueueAdapter {
  enqueueNode(input: EnqueueNodeInput): Promise<void>;
}

export interface NodeExecutorRegistry {
  execute(input: ExecuteNodeInput): Promise<NodeExecutionResult>;
}
