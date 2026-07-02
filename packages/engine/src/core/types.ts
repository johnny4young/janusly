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
import type { NodeStatus, RunStatus } from "@janusly/shared/src/status";
import type { RunMetadata } from "../persistence";

// Status types are re-exported from the shared constants module so the
// values stay in lockstep with `runs.status` / `run_nodes.status` and the
// web's read-side comparisons (which import the same module). Anyone
// adding a new status edits `packages/shared/src/status.ts` once.
export type {
  NodeStatus,
  NodeOpenStatus,
  NodeTerminalStatus,
  RunStatus,
  RunOpenStatus,
  RunTerminalStatus,
} from "@janusly/shared/src/status";

// `RunMetadata` is loaded once per `executeQueuedNode` invocation to give
// the runtime structured access to org/workflow/version identifiers
// without rummaging through the loose `RunContext` bag. Re-exported here
// so adapter implementations can type their `getRunMetadata` return.
export type { RunMetadata } from "../persistence";

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

/**
 * Input the runtime hands to `QueueAdapter.enqueueNode` to schedule a node.
 *
 * The payload is deliberately SLIM — `{ runId, nodeId }` only. The full
 * workflow is NOT shipped in every BullMQ job: the worker reloads it once per
 * job from `runs.inputJson.workflow` (the authoritative snapshot, updated on
 * replay) and resolves the node by id. This keeps a 100-node run from writing
 * its full workflow JSON into Redis 100+ times.
 */
export type EnqueueNodeInput = {
  runId: string;
  nodeId: string;
  delayMs?: number;
  attempt?: number;
};

/** Payload the queue adapter writes when a node exhausts its retries. */
export type DeadLetterInput = {
  runId: string;
  /** Org that owns the failed run. Required for multi-tenant DLQ reads. */
  orgId: string;
  /** Saved workflow id when the run can be tied back to workflow_versions. */
  workflowId?: string | null;
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
  /** `statusesOnly` returns the same keyed shape with empty `state`/`output` — the readiness scan's cheap path when no edge carries a `condition`. */
  getRunContext(runId: string, opts?: { statusesOnly?: boolean }): Promise<RunContext>;
  getRunStatus(runId: string): Promise<RunStatus | null>;
  /** Stable per-run metadata (orgId/workflow/createdBy) — `null` when the run row is absent. */
  getRunMetadata(runId: string): Promise<RunMetadata | null>;
  getNodeStatus(runId: string, nodeId: string): Promise<NodeStatus>;
  markNodeQueued(runId: string, nodeId: string, attempt?: number): Promise<void>;
  tryClaimNodeForQueue(runId: string, nodeId: string, attempt?: number): Promise<boolean>;
  /** Conditional `queued → running` transition. Returns `true` on a successful claim, `false` when the row had already advanced past `queued`. */
  markNodeRunning(runId: string, nodeId: string, attempt?: number): Promise<boolean>;
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

/** DLQ replay boundary used by `apps/api/src/routes/dlq-routes.ts:/dlq/replay`. */
export interface DeadLetterReplayAdapter {
  replayDeadLetter(input: DeadLetterReplayInput): Promise<void>;
}

/** Executor registry the runtime calls when a node is ready to run. */
export interface NodeExecutorRegistry {
  execute(input: ExecuteNodeInput): Promise<NodeExecutionResult>;
}
