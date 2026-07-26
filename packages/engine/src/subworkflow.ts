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
 * - Multi-tenant: `loadWorkflowVersion` filters on `orgId` and joins an
 *   active workflow parent so a child never resolves cross-tenant or through
 *   a soft-delete tombstone.
 * - Recursion guard: tenant config `subworkflow.maxDepth` (env fallback
 *   `JANUSLY_MAX_SUBWORKFLOW_DEPTH`, default 5). Walks only executable
 *   `parent_link_kind='subworkflow'` edges; replay provenance is a boundary.
 *   Refuses to start when the invocation chain already has `>= max` depth.
 *   Defense-in-depth bound at 100 to terminate even on a pathological cycle
 *   (which shouldn't be possible because runs are insert-only).
 * - Audit: child runs spawned by a subworkflow node skip an API audit row —
 *   the parent's subworkflow events provide the trail. Run-level audits remain
 *   user-initiated only.
 * - Notifier failures don't take down the child status flip. We log + emit a
 *   `parent.notify.failed` event on the child, keep its durable delivery
 *   marker, and let the terminal-notification reconciler retry the handoff.
 */

import { db, runNodes, runs, workflows, workflowVersions } from "@janusly/db";
import { getOrgConfigSnapshot, resolveWorkflowRolloutAssignment } from "@janusly/data";
import { eq, and, asc, desc, isNull } from "drizzle-orm";
import { WorkflowSchema, workflowVersionMax, type Workflow } from "@janusly/shared";
import {
  appendEvent,
  completeWaitingSubworkflowNode,
  failWaitingSubworkflowNode,
  reattachFailedSubworkflowNode,
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
 * Walk executable subworkflow parent links upward from `runId`. Replay-lab
 * lineage deliberately terminates the walk so validation doesn't inherit the
 * production source run's nesting budget.
 */
export async function computeSubworkflowDepth(runId: string): Promise<number> {
  let depth = 0;
  let current: string | null = runId;
  while (current) {
    const row: Array<{
      parentRunId: string | null;
      parentNodeId: string | null;
      parentLinkKind: string | null;
      replayMode: string | null;
    }> = await db
      .select({
        parentRunId: runs.parentRunId,
        parentNodeId: runs.parentNodeId,
        parentLinkKind: runs.parentLinkKind,
        replayMode: runs.replayMode,
      })
      .from(runs)
      .where(eq(runs.id, current))
      .limit(1);
    const parent: string | null = row[0]?.parentRunId ?? null;
    const executableLink = row[0]?.parentLinkKind === "subworkflow"
      || (
        row[0]?.parentLinkKind == null
        && row[0]?.replayMode == null
        && row[0]?.parentNodeId != null
      );
    if (!parent || !executableLink) break;
    depth += 1;
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
 * Parse an optional exact version pin. Absent means "latest"; every authored
 * value must fit PostgreSQL's positive integer range so the persisted DAG cannot silently
 * select a different version than the operator intended.
 */
export function resolveSubworkflowVersion(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > workflowVersionMax) {
    throw new Error(`subworkflow.config.version must be an integer between 1 and ${workflowVersionMax}`);
  }
  return value;
}

/** Normalize the authored child id once so validation and lookup agree. */
export function resolveSubworkflowId(value: unknown): string {
  const workflowId = typeof value === "string" ? value.trim() : "";
  if (!workflowId) throw new Error("subworkflow.config.workflowId is required");
  return workflowId;
}

export type LoadedWorkflowVersion = {
  workflow: Workflow;
  version: number;
  versionId: string;
};

/**
 * Look up an exact or latest version of an active saved workflow, scoped to
 * `orgId`. Returns `null` when the workflow, requested version, or active
 * parent row does not exist.
 */
export async function loadWorkflowVersion(
  workflowId: string,
  orgId: string,
  version?: number,
): Promise<LoadedWorkflowVersion | null> {
  const predicates = [
    eq(workflowVersions.workflowId, workflowId),
    eq(workflowVersions.orgId, orgId),
    isNull(workflows.deletedAt),
  ];
  if (version !== undefined) predicates.push(eq(workflowVersions.version, version));
  const rows = await db
    .select({
      dagJson: workflowVersions.dagJson,
      version: workflowVersions.version,
      versionId: workflowVersions.id,
    })
    .from(workflowVersions)
    .innerJoin(workflows, and(
      eq(workflows.id, workflowVersions.workflowId),
      eq(workflows.orgId, workflowVersions.orgId),
    ))
    .where(and(...predicates))
    .orderBy(desc(workflowVersions.version))
    .limit(1);
  if (!rows[0]) return null;
  return {
    workflow: WorkflowSchema.parse(rows[0].dagJson),
    version: rows[0].version,
    versionId: rows[0].versionId,
  };
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
      parentLinkKind: runs.parentLinkKind,
      replayMode: runs.replayMode,
      outputJson: runs.outputJson,
      inputJson: runs.inputJson,
    })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);
  return rows[0] ?? null;
}

async function getParentNodeRow(runId: string, nodeId: string) {
  const rows = await db
    .select({
      status: runNodes.status,
      stateJson: runNodes.stateJson,
      errorJson: runNodes.errorJson,
    })
    .from(runNodes)
    .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, nodeId)))
    .limit(1);
  return rows[0] ?? null;
}

/** Return the earliest persisted failed node so the parent retains the root diagnostic. */
async function getFirstChildFailure(runId: string): Promise<{ nodeId: string; error: unknown } | null> {
  const rows = await db
    .select({ nodeId: runNodes.nodeId, error: runNodes.errorJson })
    .from(runNodes)
    .where(and(eq(runNodes.runId, runId), eq(runNodes.status, "failed")))
    .orderBy(asc(runNodes.finishedAt), asc(runNodes.nodeId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Subworkflow executor. Validates depth, loads the child workflow, kicks off
 * the child run, and pauses the parent's node until the child terminates.
 */
export const subworkflowExecutor: NodeExecutor = async (ctx) => {
  const workflowId = resolveSubworkflowId(ctx.config?.workflowId);
  const requestedVersion = resolveSubworkflowVersion(ctx.config?.version);

  // 1. Recursion guard — fail fast before spawning anything.
  const depth = await computeSubworkflowDepth(ctx.runId);
  const max = (await getOrgConfigSnapshot(ctx.orgId)).runs.subworkflowMaxDepth;
  if (depth >= max) {
    throw new Error(`Subworkflow depth limit reached (${depth} >= ${max})`);
  }

  // 2. Load the child workflow (org-scoped). An unpinned production call
  // participates in the child's deployment; explicit pins and validation
  // runs remain exact and never consume canary traffic.
  const rolloutAssignment = requestedVersion === undefined && !ctx.dryRun
    ? await resolveWorkflowRolloutAssignment({
        orgId: ctx.orgId,
        workflowId,
        assignmentKey: `${ctx.runId}:${ctx.nodeId}`,
      })
    : null;
  const childVersion = rolloutAssignment
    ? {
        workflow: rolloutAssignment.workflow,
        version: rolloutAssignment.version,
        versionId: rolloutAssignment.versionId,
      }
    : await loadWorkflowVersion(workflowId, ctx.orgId, requestedVersion);
  if (!childVersion) {
    const versionSuffix = requestedVersion === undefined ? "" : ` version ${requestedVersion}`;
    throw new Error(`Subworkflow not found: ${workflowId}${versionSuffix} (org: ${ctx.orgId})`);
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
    ...childVersion.workflow,
    input: forwardedInput,
    versionId: childVersion.versionId,
    orgId: ctx.orgId,
    parentRunId: ctx.runId,
    parentNodeId: ctx.nodeId,
    replayMode: ctx.dryRun ? "validation" : null,
    ...(rolloutAssignment
      ? { rollout: { id: rolloutAssignment.rollout.id, variant: rolloutAssignment.variant } }
      : {}),
    parentCheckpoint: {
      waitingMetadata: {
        kind: "subworkflow",
        childWorkflowId: workflowId,
        childWorkflowVersion: childVersion.version,
        childWorkflowVersionId: childVersion.versionId,
        traceId,
      },
      startedEventPayload: {
        childWorkflowId: workflowId,
        childWorkflowVersion: childVersion.version,
        childWorkflowVersionId: childVersion.versionId,
        traceId,
        depth: depth + 1,
      },
      ...(ctx.recoveryClaimToken ? { recoveryClaimToken: ctx.recoveryClaimToken } : {}),
    },
    traceId,
  });

  return {
    status: "waiting",
    checkpointPersisted: true,
    reason: "Waiting for subworkflow",
    metadata: child.parentWaitingMetadata,
  };
};

/** Lazy `WorkflowRuntime` for the notifier's `enqueueReadyNodes` call. Mirrors `resume-run.ts`. */
let runtime: WorkflowRuntime | null = null;
let queueAdapter: BullMQQueueAdapter | null = null;

function getQueueAdapter(): BullMQQueueAdapter {
  if (queueAdapter) return queueAdapter;
  queueAdapter = new BullMQQueueAdapter();
  return queueAdapter;
}
function getRuntime(): WorkflowRuntime {
  if (runtime) return runtime;
  runtime = new WorkflowRuntime(
    new PostgresExecutionStore(),
    getQueueAdapter(),
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
export async function notifyParentOnTerminal(
  childRunId: string,
  childStatus: "succeeded" | "failed" | "cancelled",
): Promise<boolean> {
  let child: Awaited<ReturnType<typeof getRunRow>>;
  try {
    child = await getRunRow(childRunId);
  } catch (err) {
    await safeAppendChildEvent(childRunId, err);
    return false;
  }
  const executableLink = child?.parentLinkKind === "subworkflow"
    || (child?.parentLinkKind == null && child?.replayMode == null);
  if (!child?.parentRunId || !child?.parentNodeId || !executableLink) {
    return true; // Top-level or trace-only replay lineage.
  }
  if (child.status !== childStatus) return false; // A replay superseded this leased terminal generation.

  try {
    const parent = await getRunRow(child.parentRunId);
    if (!parent) return true; // Parent gone.

    if (childStatus === "succeeded") {
      const childOutput = (child.outputJson as Record<string, unknown> | null) ?? {};
      if (parent.status === "failed" || parent.status === "running") {
        const reattached = await reattachFailedSubworkflowNode(
          parent.id,
          child.parentNodeId,
          childRunId,
          childOutput,
        );
        if (reattached.completed) {
          if (reattached.readyToContinue) await enqueueParentReadyNodes(parent);
          return true;
        }
      }
      if (parent.status !== "failed" && isTerminalRunStatus(parent.status)) return true;
      const completed = await completeWaitingSubworkflowNode(
        parent.id,
        child.parentNodeId,
        childRunId,
        childOutput,
      );
      if (completed) {
        if (parent.status !== "failed") await enqueueParentReadyNodes(parent);
        return true;
      }

      // A crash can land after the parent node CAS but before DAG readiness.
      // Treat an already-succeeded exact checkpoint as replayable work and
      // rerun readiness before acknowledging the child outbox marker.
      const [latestParent, parentNode] = await Promise.all([
        getRunRow(parent.id),
        getParentNodeRow(parent.id, child.parentNodeId),
      ]);
      if (!latestParent || !parentNode) return true;
      const state = parentNode.stateJson && typeof parentNode.stateJson === "object"
        ? parentNode.stateJson as Record<string, unknown>
        : null;
      const completedSubworkflow = state?.subworkflow && typeof state.subworkflow === "object"
        ? state.subworkflow as Record<string, unknown>
        : null;
      if (parentNode.status === "succeeded" && completedSubworkflow?.childRunId === childRunId) {
        if (latestParent.status === "running") await enqueueParentReadyNodes(latestParent);
        return true;
      }
      if (isTerminalRunStatus(latestParent.status)) return true;
      return false;
    } else {
      // A sibling may have failed the parent first. Its terminal status must
      // not hide this exact waiting child generation, otherwise replaying the
      // sibling could reopen a parent that still contains an unresolved wait.
      if (parent.status !== "failed" && isTerminalRunStatus(parent.status)) return true;
      const childFailure = childStatus === "failed" ? await getFirstChildFailure(childRunId) : null;
      const failed = await failWaitingSubworkflowNode(
        parent.id,
        child.parentNodeId,
        childRunId,
        childStatus,
        childFailure,
      );
      if (failed) {
        await updateRunStatusFromNodes(parent.id);
        return true;
      }

      // The parent-node failure may have committed before a crash prevented
      // the run rollup. Re-run that idempotent rollup before acknowledging.
      const [latestParent, parentNode] = await Promise.all([
        getRunRow(parent.id),
        getParentNodeRow(parent.id, child.parentNodeId),
      ]);
      if (!latestParent || !parentNode) return true;
      const error = parentNode.errorJson && typeof parentNode.errorJson === "object"
        ? parentNode.errorJson as Record<string, unknown>
        : null;
      if (parentNode.status === "failed" && error?.childRunId === childRunId) {
        await updateRunStatusFromNodes(parent.id);
        return true;
      }
      if (isTerminalRunStatus(latestParent.status)) return true;
      return false;
    }
  } catch (err) {
    await safeAppendChildEvent(childRunId, err);
    return false;
  }
}

async function enqueueParentReadyNodes(parent: NonNullable<Awaited<ReturnType<typeof getRunRow>>>): Promise<void> {
  const parentInputJson = parent.inputJson as { workflow?: unknown } | null;
  const parentWorkflow = WorkflowSchema.parse(parentInputJson?.workflow);
  await getRuntime().enqueueReadyNodes({ runId: parent.id, workflow: parentWorkflow });
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
