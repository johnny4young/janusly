/** Shared type contracts for concrete workflow-node executors. */

import type { NodeType } from "@janusly/shared";

import type { NodeConfigByType } from "../node-configs";
import type { ValidationEffectMode } from "../validation-evidence";

export type NodeContext<T extends NodeType = NodeType> = {
  runId: string;
  nodeId: string;
  /** Multi-tenant scope. Plumbed by `executeNode` from `runs.orgId` so the
   * `ai` node and `agent` planner can attribute usage telemetry. */
  orgId: string;
  /**
   * Workflow id for the active run, plumbed by `executeNode` via
   * `getRunMetadata`. Forwarded to `LlmClient.generateText` /
   * `generateObject` context so the recorder writes
   * `metadata.workflowId` and the `GET /billing/usage?breakdown=workflow`
   * surface can attribute cost per workflow. `null` when the workflow
   * row was deleted between scheduling and node execution (left-join
   * miss in `getRunMetadata`).
   */
  workflowId: string | null;
  config: NodeConfigByType[T];
  context: Record<string, any>;
  /** Resolved secret values that must never be persisted by executors. */
  redactedValues?: string[];
  /** Active DLQ replay generation, used by executor-owned atomic checkpoints. */
  recoveryClaimToken?: string;
  /** Cooperative cancellation for executors that can stop starting bounded work after a node timeout. */
  signal?: AbortSignal;
  /** Immutable policy copied from the run's workflow snapshot. Executors use
   * it only for scopes that cannot be bound at dispatcher time. */
  templatePolicy?: "lenient" | "strict";
  /**
   * True when this node is executing inside a sandbox/validation run
   * (`runs.replayMode === "validation"`). Plumbed by `executeNode` from
   * the run row. Write-side actions — HTTP non-safe methods (POST / PUT
   * / PATCH / DELETE), tools flagged `writeSide` in the registry — are
   * gated when this is true: the executor emits a `node.dry_run.skipped`
   * (or `tool.dry_run.skipped`) event and returns a stub result instead
   * of mutating external state. Read-side actions still execute so the
   * validation run produces a real terminal status.
   */
  dryRun?: boolean;
  /** Narrow local effect policy for validation runs. Ordinary sandboxes use `skip`. */
  validationEffectMode?: ValidationEffectMode;
};

export type NodeExecutionResult =
  | { status: "completed"; output?: Record<string, unknown> }
  | {
      status: "waiting";
      reason?: string;
      metadata?: Record<string, unknown>;
      /** The executor already committed this waiting checkpoint atomically with owned side effects. */
      checkpointPersisted?: boolean;
    };

export type NodeExecutor<T extends NodeType = NodeType> = (
  ctx: NodeContext<T>,
) => Promise<NodeExecutionResult>;

export type RegisteredNodeType = Exclude<NodeType, "router" | "router_llm">;

export type NodeExecutorMap = {
  [T in RegisteredNodeType]: NodeExecutor<T>;
};
