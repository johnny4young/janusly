/**
 * Drizzle-backed write helpers for run / node lifecycle + event append.
 * Function-style API so `core/runtime.ts` can call them directly without
 * threading through `ExecutionStore`; the adapter
 * (`adapters/postgres-execution-store.ts`) wraps them for callers that
 * want the interface boundary.
 *
 * Used by `worker.ts`, `core/runtime.ts`, `start-run.ts`, `resume-run.ts`,
 * and the API's DLQ replay path.
 *
 * Invariants:
 * - `tryClaimNodeForQueue` is the atomic claim — `UPDATE … WHERE
 *   status='pending'`. Don't reintroduce a non-atomic `markNodeQueued` for
 *   newly-ready nodes.
 * - All writers carry no `orgId` parameter — callers carry the scope and
 *   use `getRunOrgId` when they need it (the route layer is the gate).
 */

import { db, deadLetters, runNodes, runEvents, runs, workflowVersions } from "@janusly/db";
import { recordRecoveryImpactTx } from "@janusly/data";
import { eq, ne, and, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { WorkflowSchema, type Workflow } from "@janusly/shared";
import { isOpenNodeStatus, nodeCancellableStatusValues } from "@janusly/shared/src/status";
import { projectOutputs } from "./outputs-projector";
import { publishRunEvent } from "./run-event-stream";
import { safePersistPayload } from "./safe-persist";
import type { ApprovalTimeoutPolicy } from "./waiting-time";

// Per-surface size caps for jsonb writes. The chokepoint's default cap
// (256 KB) is conservative for narrow surfaces (events, errors, audit) but
// too tight for `state_json.output` which legitimately carries http body
// outputs up to the http chokepoint's 1 MB cap. Each surface picks the cap
// that matches its real-world payload distribution; over-cap writes get a
// `__truncated` sentinel via `safePersistPayload`.
const STATE_JSON_MAX_BYTES = 1_000_000;
const ERROR_JSON_MAX_BYTES = 64_000;
const CHILD_ERROR_MAX_BYTES = 40_000;
const CHILD_MESSAGE_MAX_CHARS = 4_000;

/** Mark only executable subworkflow children for durable delivery to their exact parent node. */
export function terminalParentNotificationMarker() {
  return sql<Date | null>`CASE
    WHEN ${runs.parentRunId} IS NOT NULL
      AND ${runs.parentNodeId} IS NOT NULL
      AND (
        ${runs.parentLinkKind} = 'subworkflow'
        OR (
          ${runs.parentLinkKind} IS NULL
          AND ${runs.replayMode} IS NULL
        )
      )
    THEN date_trunc('milliseconds', CURRENT_TIMESTAMP)
    ELSE NULL
  END`;
}

function asPlainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Return the current top-level run status, or `null` when the row is absent. */
export async function getRunStatus(runId: string) {
  const rows = await db.select().from(runs).where(eq(runs.id, runId));
  return rows[0]?.status ?? null;
}

/**
 * Load the raw workflow snapshot a run executes against, from
 * `runs.inputJson.workflow`. This is the AUTHORITATIVE per-run workflow:
 * `startRun` writes it, the sandbox / replay-lab / validation creators write
 * it, and `claimReplayTransition` atomically updates it with the replay claim
 * so a patched replay's downstream cascade runs against the patched DAG. The
 * worker reloads it per node job instead of shipping the full workflow in
 * every Redis job payload.
 *
 * Returns `found: false` when the run row is absent (deleted between enqueue
 * and execution — the worker treats it as a benign no-op, mirroring the
 * pre-slim "claim fails → skip" outcome). `workflow` is the raw JSON value
 * (parsed by the caller through the content-addressed `parseWorkflowCached`).
 */
export async function loadRunWorkflowRaw(runId: string): Promise<{ found: boolean; workflow: unknown }> {
  const rows = await db.select({ inputJson: runs.inputJson }).from(runs).where(eq(runs.id, runId)).limit(1);
  if (!rows[0]) return { found: false, workflow: undefined };
  const inputJson = rows[0].inputJson as { workflow?: unknown } | null;
  return { found: true, workflow: inputJson && typeof inputJson === "object" ? inputJson.workflow : undefined };
}

/**
 * Return the current status of a single node in a run, or `null` when the
 * row is absent. Used by delayed wake-up handlers to short-circuit when a
 * paused node has already been advanced (manual resume, cancellation, etc.).
 */
export async function getRunNodeStatus(runId: string, nodeId: string): Promise<string | null> {
  const rows = await db
    .select({ status: runNodes.status })
    .from(runNodes)
    .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, nodeId)))
    .limit(1);
  return rows[0]?.status ?? null;
}

export type RunNodeWaitingSnapshot = {
  status: string;
  waiting: Record<string, unknown> | null;
};

/** Load the narrow status + waiting metadata projection used by delayed jobs. */
export async function getRunNodeWaitingSnapshot(
  runId: string,
  nodeId: string,
): Promise<RunNodeWaitingSnapshot | null> {
  const rows = await db
    .select({ status: runNodes.status, stateJson: runNodes.stateJson })
    .from(runNodes)
    .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, nodeId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const state = asPlainObject(row.stateJson);
  return {
    status: row.status,
    waiting: asPlainObject(state?.waiting),
  };
}

export type DueWaitingCheckpoint = {
  runId: string;
  nodeId: string;
  kind: "approval" | "timer";
  targetAt: string;
};

/** Failed repair deliveries become eligible again after this durable lease. */
export const WAITING_CHECKPOINT_REPAIR_LEASE_MS = 2 * 60 * 1_000;

/**
 * Durably claim a bounded batch of overdue active checkpoints whose Redis
 * wake-up can be safely recreated. The lease and NULLS-FIRST ordering ensure
 * a repeatedly failing batch cannot starve later rows; SKIP LOCKED lets
 * multiple workers sweep without claiming the same checkpoint generation.
 * Exact node-generation CAS remains the execution gate.
 */
export async function claimDueWaitingCheckpoints(
  now = new Date(),
  limit = 500,
  leaseMs = WAITING_CHECKPOINT_REPAIR_LEASE_MS,
): Promise<DueWaitingCheckpoint[]> {
  const nowIso = now.toISOString();
  const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  const boundedLeaseMs = Math.max(1_000, Math.trunc(leaseMs));
  const repairAfter = new Date(now.getTime() + boundedLeaseMs);
  const rows = await db.transaction(async (tx) => {
    const claimed = await tx
      .select({
        id: runNodes.id,
        runId: runNodes.runId,
        nodeId: runNodes.nodeId,
        stateJson: runNodes.stateJson,
      })
      .from(runNodes)
      .innerJoin(runs, eq(runs.id, runNodes.runId))
      .where(and(
        eq(runNodes.status, "waiting"),
        eq(runs.status, "running"),
        or(isNull(runNodes.waitingRepairAfter), lte(runNodes.waitingRepairAfter, now)),
        sql`COALESCE(${runNodes.stateJson} #>> '{waiting,deadlineAt}', ${runNodes.stateJson} #>> '{waiting,wakeAt}') <= ${nowIso}`,
        or(
          and(
            sql`${runNodes.stateJson} #>> '{waiting,kind}' = 'approval'`,
            sql`${runNodes.stateJson} #>> '{waiting,timeoutState}' IS NULL`,
          ),
          and(
            sql`${runNodes.stateJson} #>> '{waiting,kind}' = 'timer'`,
          ),
        ),
      ))
      .orderBy(
        sql`${runNodes.waitingRepairAfter} ASC NULLS FIRST`,
        sql`COALESCE(${runNodes.stateJson} #>> '{waiting,deadlineAt}', ${runNodes.stateJson} #>> '{waiting,wakeAt}')`,
        runNodes.runId,
        runNodes.nodeId,
      )
      .limit(boundedLimit)
      .for("update", { of: runNodes, skipLocked: true });
    if (claimed.length === 0) return claimed;

    await tx
      .update(runNodes)
      .set({ waitingRepairAfter: repairAfter })
      .where(inArray(runNodes.id, claimed.map(row => row.id)));
    return claimed;
  });

  const due: DueWaitingCheckpoint[] = [];
  for (const row of rows) {
    const waiting = asPlainObject(asPlainObject(row.stateJson)?.waiting);
    const kind = waiting?.kind;
    const targetAt = kind === "approval" ? waiting?.deadlineAt : waiting?.wakeAt;
    if ((kind !== "approval" && kind !== "timer") || typeof targetAt !== "string") continue;
    const targetMs = Date.parse(targetAt);
    if (!Number.isFinite(targetMs) || targetMs > now.getTime()) continue;
    due.push({ runId: row.runId, nodeId: row.nodeId, kind, targetAt });
  }
  return due;
}

export type DueQueuePublicationRepair = {
  runId: string;
  nodeId: string;
  status: "pending" | "queued";
  attempt: number;
  recoveryClaimToken: string | null;
  publicationGeneration: number;
};

export type DueParentNotification = {
  runId: string;
  status: "succeeded" | "failed" | "cancelled";
  leaseUntil: Date;
};

/** Failed queue-publication deliveries become eligible again after this lease. */
export const QUEUE_PUBLICATION_REPAIR_LEASE_MS = 2 * 60 * 1_000;
/** Failed terminal child→parent deliveries become eligible again after this lease. */
export const PARENT_NOTIFICATION_LEASE_MS = 2 * 60 * 1_000;

/** Claim a bounded, fairly leased batch from the terminal child→parent outbox. */
export async function claimDueParentNotifications(
  now = new Date(),
  limit = 500,
  leaseMs = PARENT_NOTIFICATION_LEASE_MS,
): Promise<DueParentNotification[]> {
  const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  const boundedLeaseMs = Math.max(1_000, Math.trunc(leaseMs));
  const repairAfter = new Date(now.getTime() + boundedLeaseMs);
  const claimed = await db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: runs.id, status: runs.status })
      .from(runs)
      .where(and(
        isNotNull(runs.parentRunId),
        isNotNull(runs.parentNodeId),
        or(
          eq(runs.parentLinkKind, "subworkflow"),
          and(isNull(runs.parentLinkKind), isNull(runs.replayMode)),
        ),
        inArray(runs.status, ["succeeded", "failed", "cancelled"]),
        lte(runs.parentNotificationAfter, now),
      ))
      .orderBy(runs.parentNotificationAfter, runs.id)
      .limit(boundedLimit)
      .for("update", { skipLocked: true });
    if (rows.length === 0) return rows;
    await tx
      .update(runs)
      .set({ parentNotificationAfter: repairAfter })
      .where(inArray(runs.id, rows.map(row => row.id)));
    return rows;
  });

  return claimed.flatMap(row => (
    row.status === "succeeded" || row.status === "failed" || row.status === "cancelled"
      ? [{ runId: row.id, status: row.status, leaseUntil: repairAfter }]
      : []
  ));
}

/** Acknowledge one exact terminal child generation after its parent handoff settles. */
export async function markParentNotificationSucceeded(
  runId: string,
  status: DueParentNotification["status"],
  expectedMarker: Date,
): Promise<boolean> {
  const cleared = await db
    .update(runs)
    .set({ parentNotificationAfter: null })
    .where(and(
      eq(runs.id, runId),
      eq(runs.status, status),
      eq(runs.parentNotificationAfter, expectedMarker),
    ))
    .returning({ id: runs.id });
  return cleared.length > 0;
}

/**
 * Claim a bounded batch from the Postgres→BullMQ outbox. The marker is set
 * before any Queue.add and cleared only after Redis accepts the deterministic
 * job id. SKIP LOCKED plus a durable lease makes multi-worker sweeps safe and
 * prevents a poisoned first batch from starving later generations.
 */
export async function claimDueQueuePublicationRepairs(
  now = new Date(),
  limit = 500,
  leaseMs = QUEUE_PUBLICATION_REPAIR_LEASE_MS,
): Promise<DueQueuePublicationRepair[]> {
  const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  const boundedLeaseMs = Math.max(1_000, Math.trunc(leaseMs));
  const repairAfter = new Date(now.getTime() + boundedLeaseMs);
  const claimed = await db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: runNodes.id,
        runId: runNodes.runId,
        nodeId: runNodes.nodeId,
        status: runNodes.status,
        attempts: runNodes.attempts,
        recoveryClaimToken: runNodes.recoveryClaimToken,
        publicationGeneration: runNodes.queuePublicationGeneration,
      })
      .from(runNodes)
      .innerJoin(runs, eq(runs.id, runNodes.runId))
      .where(and(
        eq(runs.status, "running"),
        inArray(runNodes.status, ["pending", "queued"]),
        lte(runNodes.queuePublicationRepairAfter, now),
      ))
      .orderBy(runNodes.queuePublicationRepairAfter, runNodes.runId, runNodes.nodeId)
      .limit(boundedLimit)
      .for("update", { of: runNodes, skipLocked: true });
    if (rows.length === 0) return rows;
    await tx
      .update(runNodes)
      .set({ queuePublicationRepairAfter: repairAfter })
      .where(inArray(runNodes.id, rows.map(row => row.id)));
    return rows;
  });

  return claimed.flatMap(row => {
    if (row.status !== "pending" && row.status !== "queued") return [];
    return [{
      runId: row.runId,
      nodeId: row.nodeId,
      status: row.status,
      attempt: typeof row.attempts === "number" && row.attempts > 0 ? row.attempts : 1,
      recoveryClaimToken: row.recoveryClaimToken,
      publicationGeneration: row.publicationGeneration,
    }];
  });
}

/**
 * Resolve the multi-tenant `orgId` for a run. Used by `executeNode` to thread
 * the scope into `NodeContext` so executors (notably the LLM-calling `ai`
 * step and `agent` planner) can attribute usage telemetry. Returns
 * `null` when the run row doesn't exist; callers treat that as fatal.
 */
export async function getRunOrgId(runId: string): Promise<string | null> {
  const rows = await db
    .select({ orgId: runs.orgId })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);
  return rows[0]?.orgId ?? null;
}

/** Stable per-run metadata loaded once at runtime entry: org scope, the
 *  active workflow-version pointer, the workflow id (resolved through the
 *  versions table), and the user who started the run. */
export type RunMetadata = {
  orgId: string;
  workflowVersionId: string;
  workflowId: string | null;
  createdBy: string | null;
  /** `runs.replayMode` — `"validation"` for sandbox/dry-run replays, `null`
   *  for production runs. Optional so existing `ExecutionStore` mocks that
   *  omit it stay valid. `executeNode` reads it to set `NodeContext.dryRun`
   *  without a second per-node `runs` lookup. */
  replayMode?: string | null;
  /** The run's start/trigger input (`runs.inputJson.input` — the block
   *  `startRun` persists and the trigger-ingest routes fill with the inbound
   *  event). `executeNode` merges it into the per-node context as
   *  `context.input` so trigger executors and `{{context.input.*}}`
   *  templates can read it. This keeps production trigger execution aligned
   *  with sandbox validation, which also receives the run input.
   *  Optional so existing mocks that omit it stay valid. */
  input?: Record<string, unknown>;
  /** Unresolved-template policy from the immutable workflow snapshot stored
   *  in `runs.inputJson.workflow`. Missing legacy values are lenient. */
  templatePolicy?: "lenient" | "strict";
};

/**
 * Load the small bag of stable metadata the runtime needs whenever it has
 * to write org-scoped rows (`routing_stats`, `workflow_improvements`) or
 * decide whether the improvement-evaluation path is even applicable.
 *
 * Sister to `getRunOrgId` — same single-row, indexed-by-PK lookup, just
 * widened to also include `workflowVersionId` (off the run row), the
 * resolved `workflowId` (joined through `workflow_versions`), and the
 * `createdBy` user.
 *
 * Returns `null` when the run row is missing (rare race: the run was
 * deleted between scheduling and worker pickup). Callers must treat that
 * as a soft failure — skip the metadata-dependent branch but let the
 * executor still make progress; engine atomicity is unaffected.
 *
 * The `leftJoin` on `workflow_versions` keeps the helper resilient when a
 * stale `workflowVersionId` points at a deleted version row: `workflowId`
 * comes back `null` and the runtime no-ops the improvement path while the
 * run itself completes.
 */
export async function getRunMetadata(runId: string): Promise<RunMetadata | null> {
  const rows = await db
    .select({
      orgId: runs.orgId,
      workflowVersionId: runs.workflowVersionId,
      workflowId: workflowVersions.workflowId,
      createdBy: runs.createdBy,
      replayMode: runs.replayMode,
      inputJson: runs.inputJson,
    })
    .from(runs)
    .leftJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
    .where(eq(runs.id, runId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  // `inputJson` is `{ workflow, input }` for production runs (`startRun`) and
  // `{ workflow, failingNodeId }` for sandbox validation runs — read `input`
  // defensively and normalise anything non-object to `{}`.
  const inputJson = row.inputJson as { input?: unknown; workflow?: unknown } | null;
  const rawInput = inputJson?.input;
  const input =
    rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)
      ? (rawInput as Record<string, unknown>)
      : {};
  const rawWorkflow = inputJson?.workflow;
  const rawTemplatePolicy = rawWorkflow && typeof rawWorkflow === "object" && !Array.isArray(rawWorkflow)
    ? (rawWorkflow as Record<string, unknown>).templatePolicy
    : undefined;
  const templatePolicy = rawTemplatePolicy === "strict" || rawTemplatePolicy === "lenient"
    ? rawTemplatePolicy
    : undefined;
  return {
    orgId: row.orgId,
    workflowVersionId: row.workflowVersionId,
    workflowId: row.workflowId ?? null,
    createdBy: row.createdBy ?? null,
    replayMode: row.replayMode ?? null,
    input,
    templatePolicy,
  };
}

/** Cancel a run + every still-open node, append a `run.cancelled` event. */
export async function cancelRun(runId: string, reason?: any) {
  await db.update(runs)
    .set({
      status: "cancelled",
      parentNotificationAfter: terminalParentNotificationMarker(),
    })
    .where(eq(runs.id, runId));

  await db.update(runNodes)
    .set({ status: "cancelled", stateJson: safePersistPayload({ cancelled: reason ?? {} }, { maxBytes: STATE_JSON_MAX_BYTES }), finishedAt: new Date() })
    // `running` is intentionally excluded — running nodes finish naturally;
    // the runtime's post-success guard then skips downstream scheduling.
    .where(and(eq(runNodes.runId, runId), inArray(runNodes.status, [...nodeCancellableStatusValues])));

  await appendEvent(runId, null, "run.cancelled", reason ?? {});
  // Subworkflow children: a cancelled child still notifies the parent so the
  // parent's subworkflow node fails (the parent decides whether to roll up).
  await notifyCommittedRunTerminal(runId, "cancelled");
  publishRunEvent(runId, { kind: "run.status", status: "cancelled" });
}

function recoveryClaimPredicate(recoveryClaimToken?: string) {
  return recoveryClaimToken
    ? eq(runNodes.recoveryClaimToken, recoveryClaimToken)
    : isNull(runNodes.recoveryClaimToken);
}

export type NodeExecutionClaim = "claimed" | "not_claimed" | "run_failed" | "run_cancelled" | "run_terminal";

/**
 * Serialize a queued job's execution claim with parent-run recovery. The run
 * row lock closes the stale-status window: either a failed-run consumer moves
 * the exact queue generation back to durable `pending` before reattachment,
 * or reattachment reopens the run first and this same job proceeds normally.
 */
export async function claimNodeForExecution(
  runId: string,
  nodeId: string,
  attempt = 1,
  recoveryClaimToken?: string,
  publicationGeneration = 0,
): Promise<NodeExecutionClaim> {
  const createdAt = new Date();
  const eventId = crypto.randomUUID();
  const result = await db.transaction(async (tx): Promise<{ claim: NodeExecutionClaim; eventPayload?: unknown }> => {
    const [run] = await tx
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1)
      .for("update");
    if (!run) return { claim: "run_terminal" };

    if (run.status !== "running") {
      const claim = run.status === "failed"
        ? "run_failed"
        : run.status === "cancelled"
          ? "run_cancelled"
          : "run_terminal";
      let restoredForRecovery = false;
      if (run.status === "failed") {
        const restored = await tx
          .update(runNodes)
          .set({
            status: "pending",
            queuePublicationRepairAfter: createdAt,
          })
          .where(and(
            eq(runNodes.runId, runId),
            eq(runNodes.nodeId, nodeId),
            eq(runNodes.status, "queued"),
            sql`coalesce(${runNodes.attempts}, 1) = ${attempt}`,
            recoveryClaimPredicate(recoveryClaimToken),
            eq(runNodes.queuePublicationGeneration, publicationGeneration),
          ))
          .returning({ id: runNodes.id });
        restoredForRecovery = restored.length > 0;
      }
      const eventPayload = safePersistPayload({
        reason: `Run ${run.status}`,
        attempt,
        ...(restoredForRecovery ? { restoredForRecovery: true } : {}),
      });
      await tx.insert(runEvents).values({
        id: eventId,
        runId,
        nodeId,
        type: "node.skipped",
        payload: eventPayload,
        createdAt,
      });
      return { claim, eventPayload };
    }

    const [claimed] = await tx
      .update(runNodes)
      .set({
        status: "running",
        attempts: attempt,
        startedAt: createdAt,
        queuePublicationRepairAfter: null,
      })
      .where(and(
        eq(runNodes.runId, runId),
        eq(runNodes.nodeId, nodeId),
        eq(runNodes.status, "queued"),
        sql`coalesce(${runNodes.attempts}, 1) = ${attempt}`,
        recoveryClaimPredicate(recoveryClaimToken),
        eq(runNodes.queuePublicationGeneration, publicationGeneration),
      ))
      .returning({ id: runNodes.id });
    return { claim: claimed ? "claimed" : "not_claimed" };
  });

  if (result.eventPayload !== undefined) {
    publishRunEvent(runId, {
      kind: "event",
      id: eventId,
      nodeId,
      type: "node.skipped",
      payload: result.eventPayload,
      createdAt: createdAt.toISOString(),
    });
  }
  return result.claim;
}

/** Retry transition owned by the currently executing replay generation. */
export async function markExecutingNodeQueued(
  runId: string,
  nodeId: string,
  attempt = 1,
  recoveryClaimToken?: string,
  delayMs = 0,
): Promise<QueuePublicationClaim | null> {
  const repairAfter = new Date(Date.now() + Math.max(0, Math.trunc(delayMs)));
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1)
      .for("update");
    if (run?.status !== "running") return null;

    const queued = await tx.update(runNodes)
      .set({
        status: "queued",
        attempts: attempt,
        queuePublicationRepairAfter: repairAfter,
        queuePublicationGeneration: sql`${runNodes.queuePublicationGeneration} + 1`,
      })
      .where(and(
        eq(runNodes.runId, runId),
        eq(runNodes.nodeId, nodeId),
        eq(runNodes.status, "running"),
        recoveryClaimPredicate(recoveryClaimToken),
      ))
      .returning({
        attempt: runNodes.attempts,
        recoveryClaimToken: runNodes.recoveryClaimToken,
        publicationGeneration: runNodes.queuePublicationGeneration,
      });
    if (!queued[0]) return null;
    return {
      attempt: queued[0].attempt ?? attempt,
      recoveryClaimToken: queued[0].recoveryClaimToken,
      publicationGeneration: queued[0].publicationGeneration,
    };
  });
}

/**
 * Thrown by `claimReplayTransition` when the run/node is NOT in a replayable
 * state, so the `/dlq/replay` route can map it to a 409 (explicit operator
 * feedback) instead of the pre-Q-02 silent no-op that left the operator
 * believing a replay started when it hadn't.
 */
export class ReplayNotClaimableError extends Error {
  constructor(readonly reason: "run_not_replayable" | "node_mid_retry") {
    super(`Replay not claimable: ${reason}`);
    this.name = "ReplayNotClaimableError";
  }
}

/**
 * Atomically un-terminate a failed run, replace its authoritative workflow
 * snapshot, and reset its failed node to the queue outbox in ONE transaction.
 * Replaces the former pair of separate awaits
 * (`resetRunForReplay` + `markNodeQueued`) whose gap let a
 * cancellation land between them — leaving a `queued` node on a `cancelled`
 * run that the runtime guard skips forever while the operator believes the
 * replay started (silent false recovery).
 *
 * Semantics (throws `ReplayNotClaimableError`, which rolls the tx back so no
 * partial state survives):
 * - Flips `failed → running` (idempotent no-op when the run is already
 *   `running` — the multi-dead-letter-same-run case: a sibling DLQ replay
 *   flipped it first, and this one still claims its own node).
 * - Reads the run status back INSIDE the tx: anything other than `running`
 *   (cancelled / succeeded / deleted) → `run_not_replayable`. NOTE this is a
 *   deliberate behaviour change from the pre-Q-02 path, which would silently
 *   queue a node on a non-`failed` run (and, for a `succeeded` run, actually
 *   re-run it).
 * - If the failed node is already `queued` (mid engine-retry, an in-flight
 *   BullMQ job) → `node_mid_retry`, so a manual replay can't stomp the
 *   snapshot the in-flight retry reads or double-fire its side effect.
 *
 * The caller only publishes the deterministic BullMQ job AFTER a successful
 * claim; a rejected claim mutates neither the snapshot nor the queue, while a
 * crash before publication leaves the durable repair marker behind.
 */
export type ReplayTransitionClaim = {
  recoveryClaimToken: string;
  publicationGeneration: number;
};

export async function claimReplayTransition(
  runId: string,
  nodeId: string,
  recovery: {
    deadLetterId?: string | null;
    recoveryActorId?: string | null;
    recoveryPlaybookId?: string | null;
    recoveryValidationRunId?: string | null;
  } = {},
  workflow?: Workflow,
): Promise<ReplayTransitionClaim> {
  const recoveryClaimToken = crypto.randomUUID();
  const replayClaimedAt = new Date();
  const publicationGeneration = await db.transaction(async (tx) => {
    await tx.update(runs)
      .set({ status: "running", parentNotificationAfter: null })
      .where(and(eq(runs.id, runId), eq(runs.status, "failed")));

    const runRows = await tx
      .select({ status: runs.status, inputJson: runs.inputJson })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1)
      .for("update");
    if (runRows[0]?.status !== "running") throw new ReplayNotClaimableError("run_not_replayable");

    if (workflow) {
      const currentInput = runRows[0].inputJson && typeof runRows[0].inputJson === "object"
        ? runRows[0].inputJson as Record<string, unknown>
        : {};
      await tx
        .update(runs)
        .set({ inputJson: { ...currentInput, workflow } })
        .where(eq(runs.id, runId));
    }

    const nodeRows = await tx
      .select({ status: runNodes.status })
      .from(runNodes)
      .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, nodeId)))
      .limit(1);
    if (nodeRows[0]?.status !== "failed") throw new ReplayNotClaimableError("node_mid_retry");

    if (recovery.deadLetterId) {
      const [claimedDeadLetter] = await tx
        .update(deadLetters)
        .set({ replayClaimToken: recoveryClaimToken, replayClaimedAt })
        .where(and(
          eq(deadLetters.id, recovery.deadLetterId),
          eq(deadLetters.runId, runId),
          eq(deadLetters.nodeId, nodeId),
          eq(deadLetters.status, "open"),
        ))
        .returning({ id: deadLetters.id });
      if (!claimedDeadLetter) throw new ReplayNotClaimableError("node_mid_retry");
    }

    const claimed = await tx.update(runNodes)
      .set({
        status: "queued",
        attempts: 1,
        recoveryDeadLetterId: recovery.deadLetterId ?? null,
        recoveryRequestedBy: recovery.recoveryActorId ?? null,
        recoveryClaimToken,
        recoveryPlaybookId: recovery.recoveryPlaybookId ?? null,
        recoveryValidationRunId: recovery.recoveryValidationRunId ?? null,
        queuePublicationRepairAfter: replayClaimedAt,
        queuePublicationGeneration: sql`${runNodes.queuePublicationGeneration} + 1`,
      })
      .where(and(
        eq(runNodes.runId, runId),
        eq(runNodes.nodeId, nodeId),
        eq(runNodes.status, "failed"),
      ))
      .returning({ publicationGeneration: runNodes.queuePublicationGeneration });
    if (claimed.length === 0) throw new ReplayNotClaimableError("node_mid_retry");
    return claimed[0]!.publicationGeneration;
  });
  return { recoveryClaimToken, publicationGeneration };
}

/**
 * Atomic claim — flip `pending → queued` only when the row is still
 * `pending`, persist the publication marker, and return the exact attempt /
 * replay token that Redis must receive. Returns `null` when another worker
 * already claimed. This invariant must not be replaced with a non-atomic
 * read-then-write.
 *
 * Invariant (AGENTS.md "Concurrency"): this conditional UPDATE is the
 * only multi-worker double-claim guard; racing workers get claim/null
 * from the same atomic write. No read-then-write refactors.
 */
export type QueuePublicationClaim = {
  attempt: number;
  recoveryClaimToken: string | null;
  publicationGeneration: number;
};

export async function tryClaimNodeForQueue(
  runId: string,
  nodeId: string,
  attempt = 1,
): Promise<QueuePublicationClaim | null> {
  const claimedAt = new Date();
  const claimed = await db.update(runNodes)
    .set({
      status: "queued",
      attempts: sql`CASE
        WHEN ${runNodes.queuePublicationRepairAfter} IS NOT NULL
          AND coalesce(${runNodes.attempts}, 0) > 0
        THEN ${runNodes.attempts}
        ELSE ${attempt}
      END`,
      queuePublicationRepairAfter: claimedAt,
      queuePublicationGeneration: sql`${runNodes.queuePublicationGeneration} + 1`,
    })
    .where(and(
      eq(runNodes.runId, runId),
      eq(runNodes.nodeId, nodeId),
      eq(runNodes.status, "pending"),
    ))
    .returning({
      attempt: runNodes.attempts,
      recoveryClaimToken: runNodes.recoveryClaimToken,
      publicationGeneration: runNodes.queuePublicationGeneration,
    });
  if (!claimed[0]) return null;
  return {
    attempt: claimed[0].attempt ?? attempt,
    recoveryClaimToken: claimed[0].recoveryClaimToken,
    publicationGeneration: claimed[0].publicationGeneration,
  };
}

/** Confirm that Redis accepted one exact queued generation. */
export async function markQueuePublicationSucceeded(
  runId: string,
  nodeId: string,
  attempt: number,
  publicationGeneration: number,
  recoveryClaimToken?: string,
): Promise<boolean> {
  const published = await db
    .update(runNodes)
    .set({ queuePublicationRepairAfter: null })
    .where(and(
      eq(runNodes.runId, runId),
      eq(runNodes.nodeId, nodeId),
      eq(runNodes.status, "queued"),
      sql`coalesce(${runNodes.attempts}, 1) = ${attempt}`,
      eq(runNodes.queuePublicationGeneration, publicationGeneration),
      recoveryClaimPredicate(recoveryClaimToken),
    ))
    .returning({ id: runNodes.id });
  return published.length > 0;
}

/** Transition a node to `waiting` (webhook / approval pause). Metadata stored under `state_json.waiting`. */
export async function markNodeWaiting(
  runId: string,
  nodeId: string,
  metadata?: any,
  recoveryClaimToken?: string,
): Promise<boolean> {
  const waiting = await db.update(runNodes)
    .set({
      status: "waiting",
      stateJson: safePersistPayload({ waiting: metadata ?? {} }, { maxBytes: STATE_JSON_MAX_BYTES }),
      waitingRepairAfter: null,
    })
    .where(and(
      eq(runNodes.runId, runId),
      eq(runNodes.nodeId, nodeId),
      eq(runNodes.status, "running"),
      recoveryClaimPredicate(recoveryClaimToken),
    ))
    .returning({ id: runNodes.id });
  return waiting.length > 0;
}

/**
 * Fail an approval only when it still waits on the exact deadline generation.
 * The deadline + pending-state predicates make manual-resume, replay, and
 * duplicate delayed-job races harmless.
 */
export async function failWaitingApprovalNode(
  runId: string,
  nodeId: string,
  expectedDeadlineAt: string,
  policy: Extract<ApprovalTimeoutPolicy, "fail" | "auto_reject">,
): Promise<boolean> {
  const finishedAt = new Date();
  const runFailedAt = new Date(finishedAt.getTime() + 1);
  const approvalEventId = crypto.randomUUID();
  const runEventId = crypto.randomUUID();
  const autoRejected = policy === "auto_reject";
  const eventType = autoRejected ? "approval.auto_rejected" : "approval.timed_out";
  const error = safePersistPayload({
    code: autoRejected ? "approval_auto_rejected" : "approval_timed_out",
    reason: autoRejected ? "Approval automatically rejected at deadline" : "Approval deadline expired",
    deadlineAt: expectedDeadlineAt,
    onTimeout: policy,
  }, { maxBytes: ERROR_JSON_MAX_BYTES });
  const eventPayload = safePersistPayload({ deadlineAt: expectedDeadlineAt, onTimeout: policy, error });

  const result = await db.transaction(async (tx) => {
    const [run] = await tx
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1)
      .for("update");
    if (!run || run.status !== "running") return { persisted: false, failedNodes: 0 };

    const [row] = await tx
      .update(runNodes)
      .set({ status: "failed", errorJson: error, finishedAt })
      .where(and(
        eq(runNodes.runId, runId),
        eq(runNodes.nodeId, nodeId),
        eq(runNodes.status, "waiting"),
        sql`${runNodes.stateJson} #>> '{waiting,kind}' = 'approval'`,
        sql`${runNodes.stateJson} #>> '{waiting,deadlineAt}' = ${expectedDeadlineAt}`,
        sql`${runNodes.stateJson} #>> '{waiting,timeoutState}' IS NULL`,
      ))
      .returning({ id: runNodes.id });
    if (!row) return { persisted: false, failedNodes: 0 };

    const countRows = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(runNodes)
      .where(and(eq(runNodes.runId, runId), eq(runNodes.status, "failed")));
    const failedNodes = Number(countRows[0]?.count ?? 1);
    const [flipped] = await tx
      .update(runs)
      .set({
        status: "failed",
        parentNotificationAfter: terminalParentNotificationMarker(),
      })
      .where(and(eq(runs.id, runId), eq(runs.status, "running")))
      .returning({ id: runs.id });
    if (!flipped) throw new Error("Approval timeout lost the locked run transition");

    await tx.insert(runEvents).values({
      id: approvalEventId,
      runId,
      nodeId,
      type: eventType,
      payload: eventPayload,
      createdAt: finishedAt,
    });
    await tx.insert(runEvents).values({
      id: runEventId,
      runId,
      nodeId: null,
      type: "run.failed",
      payload: safePersistPayload({ failedNodes }),
      createdAt: runFailedAt,
    });
    return { persisted: true, failedNodes };
  });
  if (!result.persisted) return false;
  publishRunEvent(runId, {
    kind: "event",
    id: approvalEventId,
    nodeId,
    type: eventType,
    payload: eventPayload,
    createdAt: finishedAt.toISOString(),
  });
  publishRunEvent(runId, {
    kind: "event",
    id: runEventId,
    nodeId: null,
    type: "run.failed",
    payload: safePersistPayload({ failedNodes: result.failedNodes }),
    createdAt: runFailedAt.toISOString(),
  });
  await notifyCommittedRunTerminal(runId, "failed");
  publishRunEvent(runId, { kind: "run.status", status: "failed" });
  return true;
}

/** Reassign a still-current approval checkpoint and record one escalation event. */
export async function escalateWaitingApprovalNode(
  runId: string,
  nodeId: string,
  expectedDeadlineAt: string,
  escalateTo: string,
): Promise<boolean> {
  const escalatedAt = new Date();
  const eventId = crypto.randomUUID();
  const result = await db.transaction(async (tx) => {
    const [run] = await tx
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1)
      .for("update");
    if (!run || run.status !== "running") return null;

    const rows = await tx
      .select({ stateJson: runNodes.stateJson })
      .from(runNodes)
      .where(and(
        eq(runNodes.runId, runId),
        eq(runNodes.nodeId, nodeId),
        eq(runNodes.status, "waiting"),
        sql`${runNodes.stateJson} #>> '{waiting,kind}' = 'approval'`,
        sql`${runNodes.stateJson} #>> '{waiting,deadlineAt}' = ${expectedDeadlineAt}`,
        sql`${runNodes.stateJson} #>> '{waiting,timeoutState}' IS NULL`,
      ))
      .limit(1);
    const state = asPlainObject(rows[0]?.stateJson);
    const waiting = asPlainObject(state?.waiting);
    if (!waiting) return null;
    const previousAssignee = typeof waiting.assignee === "string" && waiting.assignee.trim()
      ? waiting.assignee.trim()
      : undefined;
    const nextWaiting = {
      ...waiting,
      assignee: escalateTo,
      timeoutState: "escalated",
      escalatedAt: escalatedAt.toISOString(),
      ...(previousAssignee ? { escalatedFrom: previousAssignee } : {}),
    };
    const [updated] = await tx
      .update(runNodes)
      .set({ stateJson: safePersistPayload({ ...state, waiting: nextWaiting }, { maxBytes: STATE_JSON_MAX_BYTES }) })
      .where(and(
        eq(runNodes.runId, runId),
        eq(runNodes.nodeId, nodeId),
        eq(runNodes.status, "waiting"),
        sql`${runNodes.stateJson} #>> '{waiting,kind}' = 'approval'`,
        sql`${runNodes.stateJson} #>> '{waiting,deadlineAt}' = ${expectedDeadlineAt}`,
        sql`${runNodes.stateJson} #>> '{waiting,timeoutState}' IS NULL`,
      ))
      .returning({ id: runNodes.id });
    if (!updated) return null;
    const eventPayload = safePersistPayload({
      deadlineAt: expectedDeadlineAt,
      assignee: escalateTo,
      ...(previousAssignee ? { previousAssignee } : {}),
      waiting: nextWaiting,
    });
    await tx.insert(runEvents).values({
      id: eventId,
      runId,
      nodeId,
      type: "approval.escalated",
      payload: eventPayload,
      createdAt: escalatedAt,
    });
    return eventPayload;
  });
  if (!result) return false;
  publishRunEvent(runId, {
    kind: "event",
    id: eventId,
    nodeId,
    type: "approval.escalated",
    payload: result,
    createdAt: escalatedAt.toISOString(),
  });
  return true;
}

/** Mark a node skipped (e.g. edge condition false). Terminal — `finishedAt` set. */
export async function markNodeSkipped(runId: string, nodeId: string, reason?: any) {
  await db.update(runNodes)
    .set({ status: "skipped", stateJson: safePersistPayload({ skipped: reason ?? {} }, { maxBytes: STATE_JSON_MAX_BYTES }), finishedAt: new Date() })
    .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, nodeId)));
}

/** Mark a node succeeded; `output` lands under `state_json.output` (the web Inspector reads from there). */
export async function markNodeSucceeded(
  runId: string,
  nodeId: string,
  output?: any,
  recoveryClaimToken?: string,
): Promise<boolean> {
  const finishedAt = new Date();
  const completed = await db.transaction(async (tx) => {
    const [completed] = await tx.update(runNodes)
      .set({ status: "succeeded", stateJson: safePersistPayload({ output: output ?? {} }, { maxBytes: STATE_JSON_MAX_BYTES }), finishedAt })
      .where(and(
        eq(runNodes.runId, runId),
        eq(runNodes.nodeId, nodeId),
        eq(runNodes.status, "running"),
        recoveryClaimPredicate(recoveryClaimToken),
      ))
      .returning({
        deadLetterId: runNodes.recoveryDeadLetterId,
        userId: runNodes.recoveryRequestedBy,
        playbookId: runNodes.recoveryPlaybookId,
        validationRunId: runNodes.recoveryValidationRunId,
      });
    if (!completed) return false;
    await recordRecoveryImpactTx(tx, {
      deadLetterId: completed?.deadLetterId ?? null,
      userId: completed?.userId ?? null,
      playbookId: completed?.playbookId ?? null,
      validationRunId: completed?.validationRunId ?? null,
      runId,
      nodeId,
      recoveredAt: finishedAt,
    });
    return true;
  });
  return completed;
}

/**
 * Cap on how much of a node's output the `node.succeeded` EVENT payload
 * repeats. The full output (up to `STATE_JSON_MAX_BYTES`) always lands in the
 * node row's `state_json` — the event copy exists only so the live SSE stream
 * can preview it before the poll loop refetches node rows. Below the cap the
 * event carries the full output (live Inspector is byte-identical to a
 * refetch); above it the event carries just a byte count + a truncation flag,
 * so a 1 MB http body isn't written twice on the hottest completion path.
 */
const NODE_SUCCEEDED_EVENT_OUTPUT_MAX_BYTES = 8_000;

/** Best-effort JSON byte size; returns `Infinity` when the value can't be measured (treated as "large"). */
function approximateJsonBytes(value: unknown): number {
  try {
    const json = JSON.stringify(value);
    return typeof json === "string" ? new TextEncoder().encode(json).length : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Combine the `succeeded` node transition and its `node.succeeded` event in
 * ONE transaction. The two writes on the hottest completion path — an UPDATE
 * of `run_nodes` and an INSERT into `run_events` — commit or roll back
 * together and cost one DB round-trip instead of two. The SSE publish happens
 * AFTER commit so a rolled-back write never fans out to live subscribers.
 *
 * The event payload does NOT repeat a large output (which already lives in the
 * node row's `state_json`) — see `NODE_SUCCEEDED_EVENT_OUTPUT_MAX_BYTES`.
 */
export async function markNodeSucceededWithEvent(
  runId: string,
  nodeId: string,
  output: unknown,
  attempt: number,
  recoveryClaimToken?: string,
): Promise<boolean> {
  const finishedAt = new Date();
  const eventId = crypto.randomUUID();
  const stateJson = safePersistPayload({ output: output ?? {} }, { maxBytes: STATE_JSON_MAX_BYTES });

  const outputBytes = approximateJsonBytes(output ?? {});
  const rawEventPayload = outputBytes <= NODE_SUCCEEDED_EVENT_OUTPUT_MAX_BYTES
    ? { output: output ?? {}, attempt }
    : { outputBytes, outputTruncated: true, attempt };
  // Still run the chokepoint for key-redaction (and as a size backstop).
  const eventPayload = safePersistPayload(rawEventPayload);

  const completed = await db.transaction(async (tx) => {
    const [completed] = await tx.update(runNodes)
      .set({ status: "succeeded", stateJson, finishedAt })
      .where(and(
        eq(runNodes.runId, runId),
        eq(runNodes.nodeId, nodeId),
        eq(runNodes.status, "running"),
        recoveryClaimPredicate(recoveryClaimToken),
      ))
      .returning({
        deadLetterId: runNodes.recoveryDeadLetterId,
        userId: runNodes.recoveryRequestedBy,
        playbookId: runNodes.recoveryPlaybookId,
        validationRunId: runNodes.recoveryValidationRunId,
      });
    if (!completed) return false;
    await tx.insert(runEvents).values({
      id: eventId,
      runId,
      nodeId,
      type: "node.succeeded",
      payload: eventPayload,
      createdAt: finishedAt,
    });
    await recordRecoveryImpactTx(tx, {
      deadLetterId: completed?.deadLetterId ?? null,
      userId: completed?.userId ?? null,
      playbookId: completed?.playbookId ?? null,
      validationRunId: completed?.validationRunId ?? null,
      runId,
      nodeId,
      recoveredAt: finishedAt,
    });
    return true;
  });

  if (!completed) return false;

  publishRunEvent(runId, {
    kind: "event",
    id: eventId,
    nodeId,
    type: "node.succeeded",
    payload: eventPayload,
    createdAt: finishedAt.toISOString(),
  });
  return true;
}

/** Conditionally complete a paused node. Returns false when it was already resumed/cancelled/failed. */
export async function markWaitingNodeSucceeded(runId: string, nodeId: string, output?: any): Promise<boolean> {
  const finishedAt = new Date();
  return db.transaction(async (tx) => {
    const [completed] = await tx.update(runNodes)
      .set({ status: "succeeded", stateJson: safePersistPayload({ output: output ?? {} }, { maxBytes: STATE_JSON_MAX_BYTES }), finishedAt })
      .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, nodeId), eq(runNodes.status, "waiting")))
      .returning({
        id: runNodes.id,
        deadLetterId: runNodes.recoveryDeadLetterId,
        userId: runNodes.recoveryRequestedBy,
        playbookId: runNodes.recoveryPlaybookId,
        validationRunId: runNodes.recoveryValidationRunId,
      });
    if (!completed) return false;
    await recordRecoveryImpactTx(tx, {
      deadLetterId: completed.deadLetterId,
      userId: completed.userId,
      playbookId: completed.playbookId,
      validationRunId: completed.validationRunId,
      runId,
      nodeId,
      recoveredAt: finishedAt,
    });
    return true;
  });
}

/**
 * Complete only the paused subworkflow node that still waits on
 * `expectedChildRunId`. The child-generation predicate prevents a late child
 * from consuming the recovery claim or output of a newer replay generation.
 */
export async function completeWaitingSubworkflowNode(
  runId: string,
  nodeId: string,
  expectedChildRunId: string,
  output: unknown,
): Promise<boolean> {
  const finishedAt = new Date();
  const eventId = crypto.randomUUID();
  const eventPayload = safePersistPayload({ childRunId: expectedChildRunId, childOutput: output ?? {} });
  const completed = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(runNodes)
      .set({
        status: "succeeded",
        stateJson: safePersistPayload({
          output: output ?? {},
          subworkflow: { childRunId: expectedChildRunId },
        }, { maxBytes: STATE_JSON_MAX_BYTES }),
        finishedAt,
      })
      .where(and(
        eq(runNodes.runId, runId),
        eq(runNodes.nodeId, nodeId),
        eq(runNodes.status, "waiting"),
        sql`${runNodes.stateJson} #>> '{waiting,childRunId}' = ${expectedChildRunId}`,
        sql`EXISTS (
          SELECT 1 FROM ${runs}
          WHERE ${runs.id} = ${expectedChildRunId}
            AND ${runs.status} = 'succeeded'
        )`,
      ))
      .returning({
        deadLetterId: runNodes.recoveryDeadLetterId,
        userId: runNodes.recoveryRequestedBy,
        playbookId: runNodes.recoveryPlaybookId,
        validationRunId: runNodes.recoveryValidationRunId,
      });
    if (!row) return false;
    await tx.insert(runEvents).values({
      id: eventId,
      runId,
      nodeId,
      type: "node.subworkflow.completed",
      payload: eventPayload,
      createdAt: finishedAt,
    });
    await recordRecoveryImpactTx(tx, {
      deadLetterId: row.deadLetterId,
      userId: row.userId,
      playbookId: row.playbookId,
      validationRunId: row.validationRunId,
      runId,
      nodeId,
      recoveredAt: finishedAt,
    });
    return true;
  });
  if (!completed) return false;
  publishRunEvent(runId, {
    kind: "event",
    id: eventId,
    nodeId,
    type: "node.subworkflow.completed",
    payload: eventPayload,
    createdAt: finishedAt.toISOString(),
  });
  return true;
}

/** Fail only a paused subworkflow node that still belongs to this child run. */
export async function failWaitingSubworkflowNode(
  runId: string,
  nodeId: string,
  expectedChildRunId: string,
  childStatus: "failed" | "cancelled",
  childFailure?: { nodeId: string; error: unknown } | null,
): Promise<boolean> {
  const finishedAt = new Date();
  const eventId = crypto.randomUUID();
  const persistedChildError = childFailure
    ? safePersistPayload(childFailure.error, { maxBytes: CHILD_ERROR_MAX_BYTES })
    : undefined;
  const originalChildError = asPlainObject(childFailure?.error);
  const rawChildMessage = typeof originalChildError?.message === "string"
    ? originalChildError.message
    : typeof originalChildError?.reason === "string"
      ? originalChildError.reason
      : undefined;
  const childMessage = rawChildMessage?.slice(0, CHILD_MESSAGE_MAX_CHARS);
  const error = safePersistPayload({
    reason: `Subworkflow ${childStatus}`,
    message: childMessage ?? `Subworkflow ${childStatus}`,
    childRunId: expectedChildRunId,
    ...(childFailure ? {
      childNodeId: childFailure.nodeId,
      childError: persistedChildError,
    } : {}),
  }, { maxBytes: ERROR_JSON_MAX_BYTES });
  const eventPayload = safePersistPayload({
    childRunId: expectedChildRunId,
    childStatus,
    ...(childFailure ? { childNodeId: childFailure.nodeId } : {}),
  });
  const failed = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(runNodes)
      .set({ status: "failed", errorJson: error, finishedAt })
      .where(and(
        eq(runNodes.runId, runId),
        eq(runNodes.nodeId, nodeId),
        eq(runNodes.status, "waiting"),
        sql`${runNodes.stateJson} #>> '{waiting,childRunId}' = ${expectedChildRunId}`,
        sql`EXISTS (
          SELECT 1 FROM ${runs}
          WHERE ${runs.id} = ${expectedChildRunId}
            AND ${runs.status} = ${childStatus}
        )`,
      ))
      .returning({ id: runNodes.id });
    if (!row) return false;
    await tx.insert(runEvents).values({
      id: eventId,
      runId,
      nodeId,
      type: "node.subworkflow.failed",
      payload: eventPayload,
      createdAt: finishedAt,
    });
    return true;
  });
  if (!failed) return false;
  publishRunEvent(runId, {
    kind: "event",
    id: eventId,
    nodeId,
    type: "node.subworkflow.failed",
    payload: eventPayload,
    createdAt: finishedAt.toISOString(),
  });
  return true;
}

export type ReattachSubworkflowResult = {
  completed: boolean;
  reopened: boolean;
  readyToContinue: boolean;
  remainingFailedNodes: number;
};

/**
 * Reattach a successfully replayed child to the exact failed parent-node
 * generation that still references it. The parent row lock serializes this
 * recovery against cancellation and sibling replays. A failed parent reopens
 * only when the repaired subworkflow node was its last failure; an already
 * running parent can retain the repair after another replay won first.
 *
 * This is intentionally NOT a recovery-impact writer. The child's replay
 * already owns the impact claim; crediting the parent would double-count one
 * operator action as two recovered nodes.
 */
export async function reattachFailedSubworkflowNode(
  runId: string,
  nodeId: string,
  expectedChildRunId: string,
  output: unknown,
): Promise<ReattachSubworkflowResult> {
  const completedAt = new Date();
  const nodeEventId = crypto.randomUUID();
  const runEventId = crypto.randomUUID();
  const result = await db.transaction(async (tx): Promise<ReattachSubworkflowResult> => {
    const [run] = await tx
      .select({ status: runs.status })
      .from(runs)
      .where(eq(runs.id, runId))
      .limit(1)
      .for("update");
    if (!run || (run.status !== "failed" && run.status !== "running")) {
      return { completed: false, reopened: false, readyToContinue: false, remainingFailedNodes: 0 };
    }

    const [completed] = await tx
      .update(runNodes)
      .set({
        status: "succeeded",
        stateJson: safePersistPayload({
          output: output ?? {},
          subworkflow: { childRunId: expectedChildRunId },
        }, { maxBytes: STATE_JSON_MAX_BYTES }),
        errorJson: null,
        finishedAt: completedAt,
      })
      .where(and(
        eq(runNodes.runId, runId),
        eq(runNodes.nodeId, nodeId),
        eq(runNodes.status, "failed"),
        sql`${runNodes.errorJson} #>> '{childRunId}' = ${expectedChildRunId}`,
        sql`EXISTS (
          SELECT 1 FROM ${runs}
          WHERE ${runs.id} = ${expectedChildRunId}
            AND ${runs.status} = 'succeeded'
        )`,
      ))
      .returning({ id: runNodes.id });
    if (!completed) {
      return { completed: false, reopened: false, readyToContinue: false, remainingFailedNodes: 0 };
    }

    // A sibling child may already be terminally failed while its durable
    // handoff still has the parent node in `waiting`. Count that exact pending
    // failure too, otherwise repairing this node could reopen the parent and
    // publish successors before the sibling handoff makes it failed again.
    // Both states share one statement snapshot so a concurrent
    // `waiting → failed` handoff cannot move between separate counts.
    const blockingRows = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(runNodes)
      .where(and(
        eq(runNodes.runId, runId),
        or(
          eq(runNodes.status, "failed"),
          and(
            eq(runNodes.status, "waiting"),
            sql`${runNodes.stateJson} #>> '{waiting,kind}' = 'subworkflow'`,
            sql`EXISTS (
              SELECT 1 FROM ${runs} AS child_run
              WHERE child_run.id = ${runNodes.stateJson} #>> '{waiting,childRunId}'
                AND child_run.status IN ('failed', 'cancelled')
            )`,
          ),
        ),
      ));
    const remainingFailedNodes = Number(blockingRows[0]?.count ?? 0);
    const readyToContinue = remainingFailedNodes === 0;
    const reopened = run.status === "failed" && readyToContinue;
    if (reopened) {
      const [runReopened] = await tx
        .update(runs)
        .set({ status: "running", parentNotificationAfter: null })
        .where(and(eq(runs.id, runId), eq(runs.status, "failed")))
        .returning({ id: runs.id });
      if (!runReopened) throw new Error("Subworkflow reattachment lost the locked parent transition");
    }

    if (readyToContinue) {
      // Reopening changes DAG readiness inside this transaction. Mark every
      // still-pending row before commit so a crash before the notifier's
      // immediate readiness scan remains recoverable. Scanning the whole DAG
      // is intentional: when several failed sibling subworkflows recover, the
      // last repair can unblock successors of any earlier sibling, not only
      // nodes directly downstream of this one.
      await tx
        .update(runNodes)
        .set({ queuePublicationRepairAfter: completedAt })
        .where(and(
          eq(runNodes.runId, runId),
          eq(runNodes.status, "pending"),
          isNull(runNodes.queuePublicationRepairAfter),
        ));
    }

    const nodeEventPayload = safePersistPayload({
      childRunId: expectedChildRunId,
      childOutput: output ?? {},
      reopened,
      remainingFailedNodes,
    });
    await tx.insert(runEvents).values({
      id: nodeEventId,
      runId,
      nodeId,
      type: "node.subworkflow.reattached",
      payload: nodeEventPayload,
      createdAt: completedAt,
    });
    if (reopened) {
      await tx.insert(runEvents).values({
        id: runEventId,
        runId,
        nodeId: null,
        type: "run.reopened",
        payload: safePersistPayload({ reason: "subworkflow_recovered", childRunId: expectedChildRunId }),
        createdAt: completedAt,
      });
    }

    return { completed: true, reopened, readyToContinue, remainingFailedNodes };
  });

  if (!result.completed) return result;
  publishRunEvent(runId, {
    kind: "event",
    id: nodeEventId,
    nodeId,
    type: "node.subworkflow.reattached",
    payload: safePersistPayload({
      childRunId: expectedChildRunId,
      childOutput: output ?? {},
      reopened: result.reopened,
      remainingFailedNodes: result.remainingFailedNodes,
    }),
    createdAt: completedAt.toISOString(),
  });
  if (result.reopened) {
    publishRunEvent(runId, {
      kind: "event",
      id: runEventId,
      nodeId: null,
      type: "run.reopened",
      payload: safePersistPayload({ reason: "subworkflow_recovered", childRunId: expectedChildRunId }),
      createdAt: completedAt.toISOString(),
    });
    publishRunEvent(runId, { kind: "run.status", status: "running" });
  }
  return result;
}

/** Mark a node failed with the serialized error in `error_json`. Terminal. */
export async function markNodeFailed(runId: string, nodeId: string, error: any) {
  await db.update(runNodes)
    .set({ status: "failed", errorJson: safePersistPayload(error, { maxBytes: ERROR_JSON_MAX_BYTES }), finishedAt: new Date() })
    .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, nodeId)));
}

/** Fail only the execution generation that still owns the running row. */
export async function markExecutingNodeFailed(
  runId: string,
  nodeId: string,
  error: any,
  recoveryClaimToken?: string,
): Promise<boolean> {
  const failed = await db.update(runNodes)
    .set({ status: "failed", errorJson: safePersistPayload(error, { maxBytes: ERROR_JSON_MAX_BYTES }), finishedAt: new Date() })
    .where(and(
      eq(runNodes.runId, runId),
      eq(runNodes.nodeId, nodeId),
      eq(runNodes.status, "running"),
      recoveryClaimPredicate(recoveryClaimToken),
    ))
    .returning({ id: runNodes.id });
  return failed.length > 0;
}

/**
 * Conditionally fail a node that is STILL `running` (CAS). Returns `true` when
 * the row flipped, `false` when it had already advanced (completed, was
 * cancelled, or another sweep claimed it first). Used by the stalled-node
 * reaper: the conditional WHERE is the claim, so a node that legitimately
 * finished between the reaper's scan and its write is never clobbered, and two
 * worker replicas sweeping concurrently can't both fail the same node. Same
 * atomic-claim shape as `markWaitingNodeSucceeded` / `claimNodeForExecution`.
 */
export async function failStalledRunningNode(runId: string, nodeId: string, error: any): Promise<boolean> {
  const failed = await db.update(runNodes)
    .set({ status: "failed", errorJson: safePersistPayload(error, { maxBytes: ERROR_JSON_MAX_BYTES }), finishedAt: new Date() })
    .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, nodeId), eq(runNodes.status, "running")))
    .returning({ id: runNodes.id });
  return failed.length > 0;
}

/**
 * Subworkflow terminal-notifier hook. `subworkflow.ts` registers its
 * `notifyParentOnTerminal` here at module load via `setSubworkflowNotifier`
 * — `persistence.ts` then calls it after a terminal status flip, without
 * importing `subworkflow.ts` directly (which would create an import cycle).
 */
type SubworkflowNotifier = (
  runId: string,
  status: "succeeded" | "failed" | "cancelled",
) => Promise<boolean>;
let subworkflowNotifier: SubworkflowNotifier | null = null;

/** Wire the subworkflow notifier. Called from `subworkflow.ts` once at module load. */
export function setSubworkflowNotifier(notifier: SubworkflowNotifier | null): void {
  subworkflowNotifier = notifier;
}

export async function notifyCommittedRunTerminal(
  runId: string,
  status: "succeeded" | "failed" | "cancelled",
  expectedMarker?: Date,
): Promise<boolean> {
  try {
    let marker = expectedMarker;
    if (!marker) {
      const [run] = await db
        .select({
          status: runs.status,
          parentRunId: runs.parentRunId,
          parentNodeId: runs.parentNodeId,
          parentNotificationAfter: runs.parentNotificationAfter,
        })
        .from(runs)
        .where(eq(runs.id, runId))
        .limit(1);
      if (!run || run.status !== status) return false;
      if (!run.parentRunId || !run.parentNodeId) return true;
      if (!run.parentNotificationAfter) return false;
      marker = run.parentNotificationAfter;
    }
    if (!subworkflowNotifier) return false;
    const delivered = await subworkflowNotifier(runId, status);
    if (!delivered) return false;
    return await markParentNotificationSucceeded(runId, status, marker);
  } catch {
    // Notifier failures are isolated by `subworkflow.ts` itself; this is a
    // defense-in-depth catch so a runaway throw can't take down the
    // status-flip caller.
    return false;
  }
}

/** Roll up node statuses to the run-level status. Cancelled stays cancelled; any failed → failed; all-terminal → succeeded; otherwise running. */
export async function updateRunStatusFromNodes(runId: string) {
  const status = await getRunStatus(runId);
  if (status === "cancelled" || status === "succeeded" || status === "failed" || status === "timed_out") {
    return status;
  }

  // Status-only projection: this rollup runs after every node completion,
  // and the full rows would drag each node's state_json (up to 1MB) over
  // the wire just to inspect the status column.
  const nodes = await db
    .select({ status: runNodes.status })
    .from(runNodes)
    .where(eq(runNodes.runId, runId));

  if (nodes.some(node => node.status === "failed")) {
    // Conditional flip: only the worker that actually transitions running→failed
    // appends the persisted `run.failed` timeline row + notifies. Under multiple
    // workers two node-completions can race into this branch; the `ne(status)`
    // guard means the loser's UPDATE affects 0 rows and it skips the append.
    const flipped = await db.update(runs)
      .set({
        status: "failed",
        parentNotificationAfter: terminalParentNotificationMarker(),
      })
      .where(and(eq(runs.id, runId), ne(runs.status, "failed")))
      .returning({ id: runs.id });
    if (flipped.length > 0) {
      await appendEvent(runId, null, "run.failed", {
        failedNodes: nodes.filter(node => node.status === "failed").length,
      });
      await notifyCommittedRunTerminal(runId, "failed");
    }
    publishRunEvent(runId, { kind: "run.status", status: "failed" });
    return "failed";
  }

  if (nodes.length > 0 && nodes.every(node => !isOpenNodeStatus(node.status))) {
    // Project the workflow's declared `outputs` (if any) into runs.outputJson
    // BEFORE flipping status, so a single UPDATE carries both writes. Same
    // conditional-flip guard as the failed branch: only the transitioning
    // worker appends the persisted `run.succeeded` row.
    const outputJson = await computeRunOutputs(runId);
    const flipped = await db.update(runs)
      .set({
        status: "succeeded",
        outputJson,
        parentNotificationAfter: terminalParentNotificationMarker(),
      })
      .where(and(eq(runs.id, runId), ne(runs.status, "succeeded")))
      .returning({ id: runs.id });
    if (flipped.length > 0) {
      await appendEvent(runId, null, "run.succeeded", { nodes: nodes.length });
      await notifyCommittedRunTerminal(runId, "succeeded");
    }
    publishRunEvent(runId, { kind: "run.status", status: "succeeded" });
    return "succeeded";
  }

  return "running";
}

/**
 * Project the workflow's declared `outputs` against the run's terminal
 * context. Returns `null` for runs without a declared `workflow.outputs`
 * (the column stays NULL — UI shows nothing).
 *
 * The workflow JSON is read from `runs.inputJson.workflow` — the snapshot
 * captured by `startRun` at run-start time. This is intentional: ad-hoc
 * runs don't have a `workflow_versions` row, and saved runs should still
 * project against the workflow as it was when the run started (immune to
 * subsequent edits to the saved workflow).
 *
 * Multi-tenant: scoped by `runId` (callers carry the org gate). No new
 * cross-tenant query introduced.
 */
async function computeRunOutputs(runId: string): Promise<Record<string, unknown> | null> {
  const rows = await db.select({ inputJson: runs.inputJson }).from(runs).where(eq(runs.id, runId)).limit(1);
  const inputJson = rows[0]?.inputJson as { workflow?: unknown; input?: unknown } | null;
  if (!inputJson || typeof inputJson !== "object") return null;

  const workflowParsed = WorkflowSchema.safeParse(inputJson.workflow);
  if (!workflowParsed.success || !workflowParsed.data.outputs) return null;

  const context = await getRunContext(runId);
  const inputs = inputJson.input ?? {};
  return projectOutputs(workflowParsed.data.outputs, context, inputs);
}

/** Insert one row into `run_events`. The web's run timeline reads these. */
export async function appendEvent(runId: string, nodeId: string | null, type: string, payload: any) {
  const id = crypto.randomUUID();
  const createdAt = new Date();
  // Redact ONCE, then both persist and publish the same object — a streamed
  // event can never expose a value the persisted row wouldn't.
  const redacted = safePersistPayload(payload);
  await db.insert(runEvents).values({
    id,
    runId,
    nodeId,
    type,
    payload: redacted,
    createdAt,
  });
  publishRunEvent(runId, {
    kind: "event",
    id,
    nodeId,
    type,
    payload: redacted,
    createdAt: createdAt.toISOString(),
  });
}

/**
 * Build the per-run context dict (`{ [nodeId]: { status, output, ... } }`)
 * every executor receives.
 *
 * `statusesOnly: true` skips the `state_json` / `error_json` columns — the
 * readiness scan in `enqueueReadyNodes` only needs statuses unless an edge
 * carries a `condition`, and full rows drag each node's state (up to 1MB)
 * over the wire on every completion. The reduced shape keeps the same keys
 * (empty `state`/`output`, `null` error) so consumers stay structurally
 * compatible; don't hand it to executors that template over outputs.
 */
export async function getRunContext(runId: string, opts: { statusesOnly?: boolean } = {}) {
  if (opts.statusesOnly) {
    const rows = await db
      .select({ nodeId: runNodes.nodeId, status: runNodes.status, attempts: runNodes.attempts })
      .from(runNodes)
      .where(eq(runNodes.runId, runId));
    return rows.reduce<Record<string, any>>((acc, row) => {
      acc[row.nodeId] = {
        status: row.status,
        attempts: row.attempts ?? 0,
        state: {},
        output: {},
        error: null,
      };
      return acc;
    }, {});
  }

  const rows = await db.select().from(runNodes).where(eq(runNodes.runId, runId));

  return rows.reduce<Record<string, any>>((acc, row) => {
    acc[row.nodeId] = {
      status: row.status,
      attempts: row.attempts ?? 0,
      state: row.stateJson ?? {},
      output: (row.stateJson as { output?: unknown } | null)?.output ?? {},
      error: row.errorJson ?? null,
    };
    return acc;
  }, {});
}
