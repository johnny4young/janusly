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
  /** Bounded structured diagnostics for failures such as per-item loop errors. */
  details?: unknown;
  /**
   * Set when a node could already have committed an external side effect:
   * write-side timeout, partial batch failure, or persistence failure after a
   * write-side executor returned. Operators/auto-healing use it to gate replay
   * and the runtime suppresses unsafe whole-node retries.
   */
  writeSide?: boolean;
};

export type SemanticOutcomeViolationRecord = {
  detectorId: string;
  sourceNodeId: string;
  kind: "expression" | "schema";
  action: "observe" | "quarantine";
  message: string;
  details?: readonly string[];
};

export type NodeCompletionOutcome = {
  completed: boolean;
  quarantined: boolean;
  caseIds: string[];
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
      /** External writes may have committed; any later persistence failure must not whole-node retry. */
      writeSideExecuted?: boolean;
    }
  | {
      status: "waiting";
      output?: unknown;
      metadata?: unknown;
      /** The executor atomically persisted this checkpoint before returning. */
      checkpointPersisted?: boolean;
    };

/** Input handed to the node executor — `node-registry.ts:NodeContext` extends with `orgId`. */
export type ExecuteNodeInput = {
  runId: string;
  node: WorkflowNode;
  context: RunContext;
  attempt: number;
  /** Present only for a DLQ replay; binds executor-owned checkpoints to the active generation. */
  recoveryClaimToken?: string;
};

/** Job payload pulled off the BullMQ queue. */
export type ExecuteQueuedNodeInput = {
  runId: string;
  workflow: Workflow;
  node: WorkflowNode;
  attempt?: number;
  /** Physical BullMQ delivery generation; legacy jobs default to zero. */
  publicationGeneration?: number;
  /** Present only for a DLQ replay; rejects stale workers from an older replay generation. */
  recoveryClaimToken?: string;
};

/**
 * Input the runtime hands to `QueueAdapter.enqueueNode` to schedule a node.
 *
 * The payload is deliberately SLIM — identifiers, logical attempt, physical
 * publication generation, and an optional replay token. The full
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
  /** Durable physical-publication generation; retries of one publish reuse it. */
  publicationGeneration?: number;
  /** DLQ replay generation; retained across engine retries. */
  recoveryClaimToken?: string;
};

/** Persisted identity required to publish one physical queue delivery. */
export type QueuePublicationClaim = {
  attempt: number;
  recoveryClaimToken: string | null;
  publicationGeneration: number;
};

/** Payload the queue adapter writes when a node exhausts its retries. */
export type DeadLetterInput = {
  /** Optional deterministic id used by integration callers and idempotent producers. */
  deadLetterId?: string;
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

/**
 * Generation-owned terminal failure persisted by the queue/DLQ boundary.
 * The node transition, dead-letter row, node event, and run failure commit
 * together; callers must not split those writes across adapters.
 */
export type TerminalFailureInput = DeadLetterInput & {
  /** Replay generation that must still own the running node. */
  recoveryClaimToken?: string;
};

/** Payload the DLQ replay adapter accepts when re-enqueueing a failed node. */
export type DeadLetterReplayInput = {
  runId: string;
  workflow: Workflow;
  node: WorkflowNode;
  attempt?: number;
  /** Optional idempotency receipt supplied by an upstream durable publisher. */
  recoveryClaimToken?: string;
  /** DLQ identity whose terminal success may become verified recovery impact. */
  deadLetterId?: string | null;
  /** Authenticated operator or system actor that initiated the replay. */
  recoveryActorId?: string | null;
  /** Active playbook explicitly selected for this production replay. */
  recoveryPlaybookId?: string | null;
  /** Fresh successful sandbox run that attested `recoveryPlaybookId`. */
  recoveryValidationRunId?: string | null;
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
  markNodeQueued(
    runId: string,
    nodeId: string,
    attempt?: number,
    recoveryClaimToken?: string,
    delayMs?: number,
  ): Promise<QueuePublicationClaim | null>;
  tryClaimNodeForQueue(runId: string, nodeId: string, attempt?: number): Promise<{
    attempt: number;
    recoveryClaimToken: string | null;
    publicationGeneration: number;
  } | null>;
  claimNodeForExecution(
    runId: string,
    nodeId: string,
    attempt?: number,
    recoveryClaimToken?: string,
    publicationGeneration?: number,
  ): Promise<"claimed" | "not_claimed" | "run_failed" | "run_cancelled" | "run_terminal">;
  markQueuePublicationSucceeded(
    runId: string,
    nodeId: string,
    attempt: number,
    publicationGeneration: number,
    recoveryClaimToken?: string,
  ): Promise<boolean>;
  markNodeSucceeded(runId: string, nodeId: string, output: unknown, recoveryClaimToken?: string): Promise<boolean>;
  /** Combine the `succeeded` transition + its `node.succeeded` event in one transaction (the hot completion path). */
  markNodeSucceededWithEvent(runId: string, nodeId: string, output: unknown, attempt: number, recoveryClaimToken?: string): Promise<boolean>;
  /** Atomically complete a node and persist any deterministic semantic violations before downstream publication. */
  markNodeSucceededWithOutcome(
    runId: string,
    nodeId: string,
    output: unknown,
    attempt: number,
    violations: readonly SemanticOutcomeViolationRecord[],
    recoveryClaimToken?: string,
  ): Promise<NodeCompletionOutcome>;
  markNodeFailed(runId: string, nodeId: string, error: SerializedError, recoveryClaimToken?: string): Promise<boolean>;
  markNodeWaiting(runId: string, nodeId: string, metadata?: unknown, recoveryClaimToken?: string): Promise<boolean>;
  markNodeSkipped(runId: string, nodeId: string, metadata?: unknown): Promise<void>;
  appendEvent(event: WorkflowEvent): Promise<void>;
  updateRunStatusFromNodes(runId: string): Promise<void>;
}

/** Queue boundary the runtime uses to schedule work + (optionally) emit dead letters. */
export interface QueueAdapter {
  enqueueNode(input: EnqueueNodeInput): Promise<void>;
  /** Atomically persist an exhausted attempt and its DLQ/timeline effects. */
  persistTerminalFailure(input: TerminalFailureInput): Promise<boolean>;
}

/** DLQ replay boundary used by `apps/api/src/routes/dlq-routes.ts:/dlq/replay`. */
export interface DeadLetterReplayAdapter {
  replayDeadLetter(input: DeadLetterReplayInput): Promise<void>;
}

/** Executor registry the runtime calls when a node is ready to run. */
export interface NodeExecutorRegistry {
  execute(input: ExecuteNodeInput): Promise<NodeExecutionResult>;
}
