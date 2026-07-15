/**
 * Stalled-node reaper — the recovery mechanism for the one failure mode the
 * runtime's atomic claim cannot self-heal: a worker process that dies
 * (kill -9 / OOM / container eviction) while a node is executing.
 *
 * Why it's needed:
 *   `claimNodeForExecution` flips a node `queued → running` atomically while
 *   holding the parent-run lock, then the
 *   executor runs. If the worker dies mid-execution the `run_nodes` row is
 *   left `running`. BullMQ redelivers the stalled job, but the redelivered
 *   `executeQueuedNode` calls `claimNodeForExecution` again — which only matches a
 *   `queued` row — so the claim fails, a `node.skipped` event is emitted, and
 *   the job "completes". The node stays `running` forever, nothing ever calls
 *   `updateRunStatusFromNodes` for that run again, and the run is stuck in a
 *   non-terminal state with no DLQ row, no recovery item, and no terminal
 *   signal an operator could act on. That breaks the product's recoverability
 *   AND observability promises.
 *
 * What it does:
 *   A periodic sweep (a `system:` BullMQ cron, like the retention sweeps)
 *   finds production-run nodes stuck in `running` past a generous threshold
 *   (default 60 min — comfortably longer than any single legitimate node
 *   execution) and, for each, conditionally fails the node (CAS: only if it's
 *   STILL `running`, so a node that finished between scan and write is never
 *   clobbered), dead-letters it through the existing `DeadLetterQueueAdapter`
 *   (so a recovery item + alert fire and `/dlq/replay` works), emits a
 *   `node.failed` run event, and rolls the run up to a terminal `failed`
 *   status. The node-level recovery is INTENTIONALLY a fail-into-DLQ, not an
 *   automatic re-execute: a stalled node may have already run a non-idempotent
 *   side effect (sent an email, charged a card), so the operator decides
 *   whether to replay — same posture as every other DLQ entry.
 *
 * Used by `packages/engine/src/worker.ts` — `registerStalledNodeReaperScheduler`
 * at boot; `handleStalledNodeReaperTrigger` dispatched from the `Worker`
 * constructor on `job.name === STALLED_NODE_REAPER_JOB_NAME`.
 *
 * Invariants:
 * - The handler + registrar NEVER throw — a Postgres / Redis blip degrades to
 *   a warn log; the next fire is the natural retry (the scan is idempotent).
 *   Mirrors the retention schedulers' never-throws posture.
 * - The threshold has a 15-minute floor so an operator can't accidentally
 *   configure the reaper to kill legitimately long-running nodes; the default
 *   is 60 minutes.
 * - The CAS fail (`failStalledRunningNode`) is the per-node claim: concurrent
 *   worker replicas sweeping at once can't double-process a node, and a node
 *   that legitimately completed is left alone.
 * - Dead-lettering is BEST-EFFORT (it needs the workflow snapshot from
 *   `runs.input_json`): if the snapshot is missing/unparseable the node is
 *   still failed and the run still terminates, so the recoverability promise
 *   holds even without a replay surface.
 * - Known residual: unlike the ordinary runtime's atomic terminal-failure
 *   transaction, this recovery sweep still performs its CAS fail, DLQ write,
 *   event, and status rollup as separate best-effort steps. A process crash in
 *   the sub-millisecond window after the CAS can therefore leave a `failed`
 *   node under a non-terminal run that the running-node scan won't re-find.
 *   Another stalled node can trigger a later rollup; otherwise an operator
 *   must repair the run. Do not copy this posture into normal execution.
 */

import { auditLogs, db } from "@janusly/db";
import { findStalledRunningNodes, type StalledRunningNode } from "@janusly/data";
import { WorkflowSchema } from "@janusly/shared";

import { DeadLetterQueueAdapter } from "./adapters/dead-letter-queue";
import { appendEvent, failStalledRunningNode, updateRunStatusFromNodes } from "./persistence";
import { workflowQueue } from "./queue";
import { safePersistPayload } from "./safe-persist";
import { validateCronExpression } from "./schedule";
import type { DeadLetterInput, SerializedError } from "./core/types";

/** Deterministic global id for the BullMQ scheduler. */
export const STALLED_NODE_REAPER_JOB_ID = "system:stalled-node-reaper";

/** The `job.name` the worker dispatch matches on. */
export const STALLED_NODE_REAPER_JOB_NAME = "stalled-node-reaper-trigger";

/** Every 5 minutes — frequent enough that a stuck run terminates promptly
 *  once it crosses the threshold, cheap enough to be negligible (the scan is
 *  a single bounded indexed query that returns nothing on a healthy fleet). */
export const DEFAULT_STALLED_NODE_REAPER_CRON = "*/5 * * * *";

/** 60 minutes — far longer than any single legitimate node execution (the
 *  default HTTP timeout is 30s; even a long AI/agent/loop node finishes well
 *  inside an hour), so a node still `running` past this is overwhelmingly a
 *  dead worker rather than a slow one. */
export const DEFAULT_STALLED_NODE_THRESHOLD_MINUTES = 60;

/** Floor — keeps an operator from configuring the reaper aggressively enough
 *  to kill a legitimately long-running node. */
export const MIN_STALLED_NODE_THRESHOLD_MINUTES = 15;

/** Ceiling — beyond a day, a "stuck" run is better surfaced than left. */
export const MAX_STALLED_NODE_THRESHOLD_MINUTES = 1_440;

/** Hard cap on nodes reaped per fire so one sweep never unbounds. At the
 *  5-minute cadence this drains even a large incident across a few fires. */
export const STALLED_NODE_REAPER_LIMIT = 500;

/** The serialized error stamped onto a reaped node's `error_json`. The `code`
 *  is stable so failure-signature clustering buckets all worker-stall reaps
 *  together. */
export type StalledNodeError = SerializedError & { code: "worker_stalled" };

/** Injected collaborators for {@link reapStalledNodes} — real implementations
 *  in {@link handleStalledNodeReaperTrigger}, mocks in tests. */
export type StalledNodeReaperDeps = {
  findStalled: (input: { olderThan: Date; limit: number }) => Promise<StalledRunningNode[]>;
  /** CAS fail (`running → failed`). Returns `true` only when it flipped. */
  failNode: (runId: string, nodeId: string, error: StalledNodeError) => Promise<boolean>;
  enqueueDeadLetter: (input: DeadLetterInput) => Promise<void>;
  appendNodeFailedEvent: (runId: string, nodeId: string, payload: unknown) => Promise<void>;
  rollupRunStatus: (runId: string) => Promise<void>;
  /** Injected clock so tests are deterministic. */
  now: () => Date;
};

/** Per-fire tuning. */
export type ReapStalledNodesConfig = {
  /** Nodes `running` for longer than this are reaped. */
  thresholdMs: number;
  /** Max nodes reaped this fire. */
  limit: number;
};

/** Aggregate outcome of one sweep. */
export type ReapStalledNodesResult = {
  /** Stalled nodes the scan returned. */
  scanned: number;
  /** Nodes this sweep actually flipped `running → failed` (won the CAS). */
  reaped: number;
  /** Subset that also got a dead-letter row (snapshot was reconstructable). */
  deadLettered: number;
  /** Stalled nodes whose CAS lost — they had already advanced. */
  skipped: number;
};

/** Build the stable `worker_stalled` error stamped onto a reaped node. */
function buildStalledError(node: StalledRunningNode, thresholdMs: number): StalledNodeError {
  const minutes = Math.round(thresholdMs / 60_000);
  const since = node.startedAt instanceof Date ? node.startedAt.toISOString() : "unknown";
  return {
    name: "WorkerStalledError",
    code: "worker_stalled",
    message:
      `Node was left running since ${since}, past the ${minutes}-minute stall threshold — ` +
      `the worker executing it most likely crashed or was evicted mid-node. Failed by the ` +
      `stalled-node reaper so the run reaches a terminal state; replay from the dead-letter ` +
      `queue once the cause is understood (the node may have already run a side effect).`,
  };
}

/**
 * Reconstruct the `{ workflow, node }` job payload from the run's persisted
 * `input_json` snapshot so the reaped node can be dead-lettered for replay.
 * Returns `null` when the snapshot is absent / unparseable / doesn't contain
 * the node — the caller then fails the node without a DLQ row (best-effort).
 */
function reconstructDeadLetterPayload(
  node: StalledRunningNode,
): { workflow: DeadLetterInput["workflow"]; node: DeadLetterInput["node"]; workflowId: string | null } | null {
  const input = node.inputJson;
  if (!input || typeof input !== "object") return null;
  const snapshot = (input as { workflow?: unknown }).workflow;
  const parsed = WorkflowSchema.safeParse(snapshot);
  if (!parsed.success) return null;
  const failedNode = parsed.data.nodes.find((candidate) => candidate.id === node.nodeId);
  if (!failedNode) return null;
  return {
    workflow: parsed.data as DeadLetterInput["workflow"],
    node: failedNode as DeadLetterInput["node"],
    workflowId: parsed.data.id ?? null,
  };
}

/**
 * Pure reaper core. Scans for stalled nodes and, for each it can claim via the
 * CAS fail, dead-letters (best-effort) + emits a `node.failed` event + rolls
 * the run up to terminal. Never throws — per-node faults are isolated so one
 * bad row can't abort the sweep.
 */
export async function reapStalledNodes(
  deps: StalledNodeReaperDeps,
  config: ReapStalledNodesConfig,
): Promise<ReapStalledNodesResult> {
  const olderThan = new Date(deps.now().getTime() - config.thresholdMs);
  const stalled = await deps.findStalled({ olderThan, limit: config.limit });

  const result: ReapStalledNodesResult = { scanned: stalled.length, reaped: 0, deadLettered: 0, skipped: 0 };

  for (const node of stalled) {
    try {
      const error = buildStalledError(node, config.thresholdMs);

      // CAS claim: only proceed if this sweep is the one that flipped the node.
      const flipped = await deps.failNode(node.runId, node.nodeId, error);
      if (!flipped) {
        result.skipped += 1;
        continue;
      }
      result.reaped += 1;

      // Best-effort dead-letter so the operator gets a recovery item + replay.
      const payload = reconstructDeadLetterPayload(node);
      if (payload) {
        try {
          await deps.enqueueDeadLetter({
            runId: node.runId,
            orgId: node.orgId,
            workflowId: payload.workflowId,
            workflow: payload.workflow,
            node: payload.node,
            attempt: node.attempt,
            error,
          });
          result.deadLettered += 1;
        } catch (err) {
          console.warn("[stalled-node-reaper] dead-letter write failed (node already failed)", {
            runId: node.runId,
            nodeId: node.nodeId,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Timeline event + terminal rollup so the run stops being stuck. Done
      // even when the DLQ write was skipped, so the recoverability promise
      // (run reaches a terminal state) holds regardless of the snapshot.
      await deps.appendNodeFailedEvent(node.runId, node.nodeId, {
        error,
        attempt: node.attempt,
        reason: "worker_stalled",
      });
      await deps.rollupRunStatus(node.runId);
    } catch (err) {
      console.warn("[stalled-node-reaper] failed to reap node", {
        runId: node.runId,
        nodeId: node.nodeId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

/**
 * Resolve the cron pattern from env or fall back to the documented default.
 * Validation failure warn-logs and returns the default — never throws.
 */
function resolveCronPattern(env: NodeJS.ProcessEnv): string {
  const raw = env.JANUSLY_STALLED_NODE_REAPER_CRON?.trim();
  if (!raw) return DEFAULT_STALLED_NODE_REAPER_CRON;
  try {
    validateCronExpression(raw);
    return raw;
  } catch (err) {
    console.warn(
      "[stalled-node-reaper] JANUSLY_STALLED_NODE_REAPER_CRON invalid; falling back to default",
      { value: raw, error: err instanceof Error ? err.message : String(err) },
    );
    return DEFAULT_STALLED_NODE_REAPER_CRON;
  }
}

/**
 * Resolve the stall threshold (minutes) from env, clamped into
 * `[MIN, MAX]`. Out-of-range or non-numeric warn-logs and returns the
 * default — never throws.
 */
export function resolveStalledNodeThresholdMinutes(env: NodeJS.ProcessEnv): number {
  const raw = env.JANUSLY_STALLED_NODE_THRESHOLD_MINUTES?.trim();
  if (!raw) return DEFAULT_STALLED_NODE_THRESHOLD_MINUTES;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    console.warn(
      "[stalled-node-reaper] JANUSLY_STALLED_NODE_THRESHOLD_MINUTES is not an integer; falling back to default",
      { value: raw, default: DEFAULT_STALLED_NODE_THRESHOLD_MINUTES },
    );
    return DEFAULT_STALLED_NODE_THRESHOLD_MINUTES;
  }
  if (parsed < MIN_STALLED_NODE_THRESHOLD_MINUTES || parsed > MAX_STALLED_NODE_THRESHOLD_MINUTES) {
    console.warn(
      "[stalled-node-reaper] JANUSLY_STALLED_NODE_THRESHOLD_MINUTES out of range; falling back to default",
      {
        value: parsed,
        min: MIN_STALLED_NODE_THRESHOLD_MINUTES,
        max: MAX_STALLED_NODE_THRESHOLD_MINUTES,
        default: DEFAULT_STALLED_NODE_THRESHOLD_MINUTES,
      },
    );
    return DEFAULT_STALLED_NODE_THRESHOLD_MINUTES;
  }
  return parsed;
}

/**
 * Register the periodic stalled-node reaper with BullMQ. Idempotent via the
 * deterministic `STALLED_NODE_REAPER_JOB_ID`. Never throws — a registration
 * failure is logged and reported as `false`.
 */
export async function registerStalledNodeReaperScheduler(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const pattern = resolveCronPattern(env);
  try {
    await workflowQueue.upsertJobScheduler(
      STALLED_NODE_REAPER_JOB_ID,
      { pattern },
      { name: STALLED_NODE_REAPER_JOB_NAME, data: {} },
    );
    return true;
  } catch (err) {
    console.error("[stalled-node-reaper] upsertJobScheduler failed", {
      jobId: STALLED_NODE_REAPER_JOB_ID,
      err,
    });
    return false;
  }
}

/**
 * Write one system-sentinel audit row summarizing a sweep that found work.
 * Best-effort — a failed audit write is logged and swallowed. Skipped entirely
 * on the healthy `scanned === 0` path so the cron doesn't spam `audit_logs`.
 */
async function writeReaperAudit(metadata: Record<string, unknown>): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      orgId: "system",
      userId: null,
      action: "run.stalled_node.reaped",
      targetType: null,
      targetId: null,
      metadata: safePersistPayload(metadata) as Record<string, unknown>,
    });
  } catch (err) {
    console.warn("[stalled-node-reaper] audit write failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * BullMQ handler. Resolves the threshold, runs the reaper against the
 * production deps, and audits the outcome when anything was found. Never
 * throws — a Postgres outage degrades to a warn log; the next fire retries.
 */
export async function handleStalledNodeReaperTrigger(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const thresholdMinutes = resolveStalledNodeThresholdMinutes(env);
  const thresholdMs = thresholdMinutes * 60_000;
  const startedAt = Date.now();

  const deadLetterAdapter = new DeadLetterQueueAdapter();

  try {
    const result = await reapStalledNodes(
      {
        findStalled: (input) => findStalledRunningNodes(input),
        failNode: (runId, nodeId, error) => failStalledRunningNode(runId, nodeId, error),
        enqueueDeadLetter: (input) => deadLetterAdapter.enqueueDeadLetter(input),
        appendNodeFailedEvent: (runId, nodeId, payload) => appendEvent(runId, nodeId, "node.failed", payload),
        rollupRunStatus: (runId) => updateRunStatusFromNodes(runId).then(() => undefined),
        now: () => new Date(),
      },
      { thresholdMs, limit: STALLED_NODE_REAPER_LIMIT },
    );

    if (result.scanned > 0) {
      const runtimeMs = Date.now() - startedAt;
      console.log(
        `[stalled-node-reaper] sweep complete — scanned ${result.scanned}, reaped ${result.reaped}, ` +
          `dead-lettered ${result.deadLettered}, skipped ${result.skipped} in ${runtimeMs}ms (threshold ${thresholdMinutes}m)`,
      );
      await writeReaperAudit({
        scanned: result.scanned,
        reaped: result.reaped,
        deadLettered: result.deadLettered,
        skipped: result.skipped,
        thresholdMinutes,
        runtimeMs,
      });
    }
  } catch (err) {
    console.error("[stalled-node-reaper] sweep failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
