/**
 * Runtime contract types — the surface `core/runtime.ts` orchestrates and
 * the adapters in `adapters/*` implement. Pure types; no I/O.
 *
 * Used by `core/runtime.ts`, `adapters/*`, `node-registry.ts`, and the
 * top-level `start-run.ts` / `resume-run.ts` callers.
 *
 * Invariants:
 * - Add executor-specific shapes to `node-registry.ts`, not here. This file
 *   stays focused on the runtime/adapter boundary.
 * - The `NodeStatus` / `RunStatus` enums match the values the database
 *   `run_nodes.status` / `runs.status` columns store. Adding a status here
 *   without a migration breaks the wire shape with persistence.
 */

import type { Workflow, WorkflowNode } from "@janusly/shared";

/** Terminal node statuses — once set, the runtime stops scheduling more work for the node. */
export type NodeTerminalStatus = "succeeded" | "failed" | "skipped" | "cancelled";

/** All node lifecycle statuses, including pre-terminal `pending` / `queued` / `running` / `waiting`. */
export type NodeStatus =
  | "pending"
  | "queued"
  | "running"
  | "waiting"
  | NodeTerminalStatus;

/** Run-level lifecycle status (rolls up node statuses). */
export type RunStatus =
  | "created"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

/** Plain-object error shape used in `run_nodes.error_json` and dead-letter rows. */
export type SerializedError = {
  message: string;
  name?: string;
  stack?: string;
  cause?: unknown;
  code?: string;
  statusCode?: number;
};

/** Backoff curve for `RetryPolicy`. */
export type RetryBackoffStrategy = "fixed" | "exponential";

/** Per-node retry config consumed by `core/retry-policy.ts`. */
export type RetryPolicy = {
  maxAttempts?: number;
  delayMs?: number;
  maxDelayMs?: number;
  backoff?: RetryBackoffStrategy;
  jitter?: boolean;
  retryOn?: string[];
  ignoreOn?: string[];
};

/** Per-run shared scope passed into every executor — keyed by upstream node id. */
export type RunContext = Record<string, unknown>;

/** One row's worth of run-event data, written to `run_events`. */
export type WorkflowEvent = {
  runId: string;
  nodeId?: string;
  type: string;
  payload?: unknown;
  timestamp?: Date;
};

/** Result a node executor returns to `core/runtime.ts`. `waiting` checkpoints the run. */
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

/** Input handed to the node executor — `node-registry.ts:NodeContext` extends with `orgId`. */
export type ExecuteNodeInput = {
  runId: string;
  node: WorkflowNode;
  context: RunContext;
  attempt: number;
};

/** Job payload pulled off the BullMQ queue. */
export type ExecuteQueuedNodeInput = {
  runId: string;
  workflow: Workflow;
  node: WorkflowNode;
  attempt?: number;
};

/** Input the runtime hands to `QueueAdapter.enqueueNode` to schedule a node. */
export type EnqueueNodeInput = {
  runId: string;
  workflow: Workflow;
  node: WorkflowNode;
  delayMs?: number;
  attempt?: number;
};

/** Payload the queue adapter writes when a node exhausts its retries. */
export type DeadLetterInput = {
  runId: string;
  workflow: Workflow;
  node: WorkflowNode;
  attempt: number;
  error: SerializedError;
};

/** Payload the DLQ replay adapter accepts when re-enqueueing a failed node. */
export type DeadLetterReplayInput = {
  runId: string;
  workflow: Workflow;
  node: WorkflowNode;
  attempt?: number;
};

/** Hint used by the runtime when scanning for newly-ready downstream nodes. */
export type EnqueueReadyNodesInput = {
  runId: string;
  workflow: Workflow;
};

/** Persistence boundary the runtime needs. `PostgresExecutionStore` is the production implementation. */
export interface ExecutionStore {
  getRunContext(runId: string): Promise<RunContext>;
  getRunStatus(runId: string): Promise<RunStatus | null>;
  getNodeStatus(runId: string, nodeId: string): Promise<NodeStatus>;
  markNodeQueued(runId: string, nodeId: string, attempt?: number): Promise<void>;
  tryClaimNodeForQueue(runId: string, nodeId: string, attempt?: number): Promise<boolean>;
  markNodeRunning(runId: string, nodeId: string, attempt?: number): Promise<void>;
  markNodeSucceeded(runId: string, nodeId: string, output: unknown): Promise<void>;
  markNodeFailed(runId: string, nodeId: string, error: SerializedError): Promise<void>;
  markNodeWaiting(runId: string, nodeId: string, metadata?: unknown): Promise<void>;
  markNodeSkipped(runId: string, nodeId: string, metadata?: unknown): Promise<void>;
  appendEvent(event: WorkflowEvent): Promise<void>;
  updateRunStatusFromNodes(runId: string): Promise<void>;
}

/** Queue boundary the runtime uses to schedule work + (optionally) emit dead letters. */
export interface QueueAdapter {
  enqueueNode(input: EnqueueNodeInput): Promise<void>;
  enqueueDeadLetter?(input: DeadLetterInput): Promise<void>;
}

/** DLQ replay boundary used by `apps/api/src/index.ts:/dlq/replay`. */
export interface DeadLetterReplayAdapter {
  replayDeadLetter(input: DeadLetterReplayInput): Promise<void>;
}

/** Executor registry the runtime calls when a node is ready to run. */
export interface NodeExecutorRegistry {
  execute(input: ExecuteNodeInput): Promise<NodeExecutionResult>;
}
