/**
 * `subworkflow` node — calls another saved workflow as a step.
 *
 * Async pause-and-resume: parent's executor calls `startRun` for the child
 * and returns `waiting`; the child runs to completion through the regular
 * worker pipeline; on terminal status `notifyParentOnTerminal` resumes the
 * parent's subworkflow node with the child's outputs (or fails it on child
 * failure/cancellation).
 *
 * Used by:
 * - `node-registry.ts` (`subworkflow: subworkflowExecutor`).
 * - `persistence.ts:updateRunStatusFromNodes` (calls `notifyParentOnTerminal`
 *   when the run flips to a terminal status and has a `parent_run_id`).
 *
 * Invariants:
 * - Multi-tenant: `loadLatestWorkflowVersion` filters on `orgId` so a child
 *   workflow id never resolves cross-tenant.
 * - Recursion guard: tenant config `subworkflow.maxDepth` (env fallback
 *   `JANUSLY_MAX_SUBWORKFLOW_DEPTH`, default 5). Walks the `runs.parent_run_id`
 *   chain up; refuses to start when the chain already has `>= max` depth.
 *   Defense-in-depth bound at 100 to terminate even on a pathological cycle
 *   (which shouldn't be possible because runs are insert-only).
 * - Audit: child runs spawned by a subworkflow node skip an API audit row —
 *   the parent's subworkflow events provide the trail. Run-level audits remain
 *   user-initiated only.
 * - Notifier failures don't take down the child status flip. We log + emit a
 *   `parent.notify.failed` event on the child, but never throw out — the
 *   operator can reconcile via the existing webhook resume mechanism.
 */

import { db, runs, workflowVersions } from "@janusly/db";
import { getOrgConfigSnapshot } from "@janusly/data";
import { eq, and, desc } from "drizzle-orm";
import { WorkflowSchema, type Workflow } from "@janusly/shared";
import {
  appendEvent,
  completeWaitingSubworkflowNode,
  failWaitingSubworkflowNode,
  setSubworkflowNotifier,
  updateRunStatusFromNodes,
} from "./persistence";
import { startRun } from "./start-run";
import type { NodeExecutor } from "./node-registry";
import { redactValues } from "./template";
import { BullMQQueueAdapter } from "./adapters/bullmq-queue-adapter";
import { PostgresExecutionStore } from "./adapters/postgres-execution-store";
import { WorkflowRuntime } from "./core/runtime";

/** Defensive upper bound on the parent-chain walker so a cycle (which shouldn't be possible — runs are insert-only) never spins forever. */
const DEPTH_WALKER_MAX = 100;

/**
 * Walk `runs.parent_run_id` upward from `runId` and count parent links.
 * Returns 0 for top-level runs.
 */
export async function computeSubworkflowDepth(runId: string): Promise<number> {
  let depth = 0;
  let current: string | null = runId;
  while (current) {
    const row: Array<{ parentRunId: string | null }> = await db
      .select({ parentRunId: runs.parentRunId })
      .from(runs)
      .where(eq(runs.id, current))
      .limit(1);
    const parent: string | null = row[0]?.parentRunId ?? null;
    if (parent) depth += 1;
    current = parent;
    if (depth > DEPTH_WALKER_MAX) {
      throw new Error(`Subworkflow depth walker bounded at ${DEPTH_WALKER_MAX} (cycle?)`);
    }
  }
  return depth;
}

/** Resolve the configured maximum subworkflow depth (default 5). */
export function maxSubworkflowDepth(): number {
  const raw = Number(process.env.JANUSLY_MAX_SUBWORKFLOW_DEPTH ?? 5);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5;
}

/**
 * Pure helper: pick the input forwarded to the child run. `config.input`
 * (when present, including `null`) wins; otherwise we inherit the parent's
 * own run-start input. Falls back to `{}` when neither is set.
 *
 * Exported for unit testing — keeps the precedence rule auditable in
 * isolation without spinning up the runtime.
 */
export function decideForwardedInput(
  configInput: unknown,
  parentInput: unknown,
): Record<string, unknown> {
  if (configInput !== undefined) {
    return (configInput ?? {}) as Record<string, unknown>;
  }
  if (parentInput !== undefined && parentInput !== null) {
    return parentInput as Record<string, unknown>;
  }
  return {};
}

/**
 * Remove any values that were resolved from `{{secret.*}}` templates before
 * forwarding input into a child run. `startRun` persists `runs.inputJson`, so
 * subworkflow inputs must obey the same no-plaintext-secret guarantee as node
 * outputs.
 */
export function sanitizeForwardedInput(input: unknown, redactedValues: string[]): unknown {
  return redactValues(input, redactedValues);
}

/**
 * Look up the latest version of a saved workflow by id, scoped to `orgId`.
 * Returns `null` when no version exists for that (orgId, workflowId).
 */
export async function loadLatestWorkflowVersion(workflowId: string, orgId: string): Promise<Workflow | null> {
  const rows = await db
    .select()
    .from(workflowVersions)
    .where(and(eq(workflowVersions.workflowId, workflowId), eq(workflowVersions.orgId, orgId)))
    .orderBy(desc(workflowVersions.version))
    .limit(1);
  if (!rows[0]) return null;
  return WorkflowSchema.parse(rows[0].dagJson);
}

/** Read the captured `runs.inputJson` (workflow + run-start input) for a run. */
async function getRunInputJson(runId: string): Promise<{ workflow?: unknown; input?: unknown } | null> {
  const rows = await db.select({ inputJson: runs.inputJson }).from(runs).where(eq(runs.id, runId)).limit(1);
  return (rows[0]?.inputJson as { workflow?: unknown; input?: unknown } | null) ?? null;
}

/** Read `runs.traceId` for a run. Returns `null` when the column is unset. */
async function getRunTraceId(runId: string): Promise<string | null> {
  const rows = await db.select({ traceId: runs.traceId }).from(runs).where(eq(runs.id, runId)).limit(1);
  return rows[0]?.traceId ?? null;
}

/** Pull the row fields the notifier needs in one shot. */
async function getRunRow(runId: string) {
  const rows = await db
    .select({
      id: runs.id,
      status: runs.status,
      orgId: runs.orgId,
      parentRunId: runs.parentRunId,
      parentNodeId: runs.parentNodeId,
      outputJson: runs.outputJson,
      inputJson: runs.inputJson,
    })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Subworkflow executor. Validates depth, loads the child workflow, kicks off
 * the child run, and pauses the parent's node until the child terminates.
 */
export const subworkflowExecutor: NodeExecutor = async (ctx) => {
  const workflowId = typeof ctx.config?.workflowId === "string" ? ctx.config.workflowId : "";
  if (!workflowId) {
    throw new Error("subworkflow.config.workflowId is required");
  }

  // 1. Recursion guard — fail fast before spawning anything.
  const depth = await computeSubworkflowDepth(ctx.runId);
  const max = (await getOrgConfigSnapshot(ctx.orgId)).runs.subworkflowMaxDepth;
  if (depth >= max) {
    throw new Error(`Subworkflow depth limit reached (${depth} >= ${max})`);
  }

  // 2. Load the child workflow (org-scoped).
  const childWorkflow = await loadLatestWorkflowVersion(workflowId, ctx.orgId);
  if (!childWorkflow) {
    throw new Error(`Subworkflow not found: ${workflowId} (org: ${ctx.orgId})`);
  }

  // 3. Compute forwarded input. config.input wins; otherwise inherit parent's input.
  const parentInputJson = await getRunInputJson(ctx.runId);
  const forwardedInput = sanitizeForwardedInput(
    decideForwardedInput(ctx.config?.input, parentInputJson?.input),
    ctx.redactedValues ?? [],
  );

  // 4. Inherit traceId so OTel will tie spans together when active spans land.
  const parentTraceId = await getRunTraceId(ctx.runId);
  const traceId = parentTraceId ?? crypto.randomUUID();

  // 5. Start the child run. Throws `WorkflowInputValidationError` from
  //    `startRun` when the child declares typed inputs and the forwarded input
  //    doesn't satisfy them — the parent's executor surfaces that as a node
  //    failure (caller's runtime handles the throw).
  const child = await startRun({
    ...childWorkflow,
    input: forwardedInput,
    orgId: ctx.orgId,
    parentRunId: ctx.runId,
    parentNodeId: ctx.nodeId,
    traceId,
  });

  await appendEvent(ctx.runId, ctx.nodeId, "node.subworkflow.started", {
    childRunId: child.runId,
    childWorkflowId: workflowId,
    traceId,
    depth: depth + 1,
  });

  return {
    status: "waiting",
    reason: "Waiting for subworkflow",
    metadata: {
      kind: "subworkflow",
      childRunId: child.runId,
      childWorkflowId: workflowId,
      traceId,
    },
  };
};

/** Lazy `WorkflowRuntime` for the notifier's `enqueueReadyNodes` call. Mirrors `resume-run.ts`. */
let runtime: WorkflowRuntime | null = null;
function getRuntime(): WorkflowRuntime {
  if (runtime) return runtime;
  runtime = new WorkflowRuntime(
    new PostgresExecutionStore(),
    new BullMQQueueAdapter(),
    { execute: async () => ({}) },
  );
  return runtime;
}

/**
 * When a child run reaches a terminal status, resume the parent's subworkflow
 * node. On `succeeded`: child outputs become the parent node's output and
 * downstream nodes are enqueued. On `failed`/`cancelled`: parent node is
 * marked failed and the parent's run rolls up via `updateRunStatusFromNodes`
 * (which itself calls back into this notifier — the trampoline that lets a
 * deep chain of failures collapse cleanly).
 *
 * Errors are caught and emitted as a `parent.notify.failed` event on the
 * **child** so they're auditable; the child's status flip is never blocked.
 */
export async function notifyParentOnTerminal(childRunId: string, childStatus: "succeeded" | "failed" | "cancelled"): Promise<void> {
  let child: Awaited<ReturnType<typeof getRunRow>>;
  try {
    child = await getRunRow(childRunId);
  } catch (err) {
    await safeAppendChildEvent(childRunId, err);
    return;
  }
  if (!child?.parentRunId || !child?.parentNodeId) return; // Top-level run.

  try {
    const parent = await getRunRow(child.parentRunId);
    if (!parent) return; // Parent gone.
    if (isTerminalRunStatus(parent.status)) return; // Parent was cancelled/finished while child kept running.

    if (childStatus === "succeeded") {
      const childOutput = (child.outputJson as Record<string, unknown> | null) ?? {};
      const completed = await completeWaitingSubworkflowNode(
        parent.id,
        child.parentNodeId,
        childRunId,
        childOutput,
      );
      if (!completed) return;

      const parentInputJson = parent.inputJson as { workflow?: unknown } | null;
      const parentWorkflow = WorkflowSchema.parse(parentInputJson?.workflow);
      await getRuntime().enqueueReadyNodes({ runId: parent.id, workflow: parentWorkflow });
    } else {
      const failed = await failWaitingSubworkflowNode(
        parent.id,
        child.parentNodeId,
        childRunId,
        childStatus,
      );
      if (!failed) return;
      await updateRunStatusFromNodes(parent.id);
    }
  } catch (err) {
    await safeAppendChildEvent(childRunId, err);
  }
}

function isTerminalRunStatus(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "timed_out";
}

async function safeAppendChildEvent(childRunId: string, err: unknown): Promise<void> {
  try {
    await appendEvent(childRunId, null, "parent.notify.failed", {
      error: err instanceof Error ? { name: err.name, message: err.message } : { message: String(err) },
    });
  } catch {
    // Last-resort: don't let a failed audit drag the run flip down.
  }
}

// Register the notifier with `persistence.ts` so `updateRunStatusFromNodes`
// can fire it on terminal status flips. Indirection avoids the import cycle
// that would arise from `persistence.ts` importing this module directly.
setSubworkflowNotifier(notifyParentOnTerminal);
