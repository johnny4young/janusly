/**
 * Auto-healing validation-outcome poller. A sibling cron to the
 * scanner — every minute it sweeps `auto_healing_runs` rows still in
 * `validating` status, joins against `runs` to read the terminal
 * status of the validation sandbox run, computes the signature-changed
 * defense, records the outcome, and (if both auto-apply flag pairs are
 * on AND the loop breaker / budget still pass) triggers the production
 * replay against the patched workflow.
 *
 * Pairs with `auto-healing-scanner.ts`:
 *  - scanner enqueues sandbox validations (1 per candidate) and writes
 *    `validating` rows.
 *  - watcher waits for those validations to reach terminal status,
 *    records the outcome, and optionally applies.
 *
 * Three terminal cases on the validation sandbox run:
 *   - `succeeded` → patch worked (signature gone). Row moves to
 *     `validated`. If auto-apply is allowed, replay against the
 *     patched workflow and move to `applied` with
 *     `decisionActor: "auto"`. Otherwise leave for manual operator
 *     decision via the Recovery Center card.
 *   - `failed` + signature UNCHANGED → patch didn't fix it. Row moves
 *     to `validation_failed` with reason `validation_failed`.
 *   - `failed` + signature CHANGED → patch caused a different failure
 *     shape (still broken). Row moves to `validation_failed` with
 *     reason `signature_changed`.
 *   - `cancelled` → treated as `validation_failed` (the sandbox run
 *     never produced a usable signal).
 *
 * Stale-row sweep runs at the start of each tick: rows older than 2
 * hours still in `validating` get auto-declined with reason
 * `validation_timeout`. The two-hour ceiling is well above any
 * reasonable validation run latency.
 *
 * Invariants:
 * - Never throws. Per-row failures are caught and logged.
 * - Multi-tenant scope is preserved through the row's own `orgId` —
 *   the watcher reads `auto_healing_runs` rows and then joins per-row
 *   into `runs` filtered by the same orgId.
 * - The auto-apply branch does NOT re-check budget (the scanner
 *   already paid the LLM + validation budget for this candidate).
 *   It DOES re-check the master gate AND the auto-apply gate AND the
 *   loop count AND the existing CAS-style `recordDecision` so a
 *   concurrent operator click cannot collide.
 */

import { and, eq, inArray } from "drizzle-orm";
import { db, deadLetters, runs, runNodes } from "@janusly/db";
import {
  countRecentAttemptsBySignature,
  listValidatingRows,
  recordDecision,
  recordValidationOutcome,
  sweepStaleValidating,
  type AutoHealingRun,
  getOrgConfigSnapshot,
} from "@janusly/data";
import {
  isAutoApplyAllowed,
  isAutoHealingAllowed,
} from "@janusly/engine/src/auto-healing-consent";
import { normalizeErrorSignature } from "@janusly/shared/src/error-signature";
import { DLQReplayAdapter } from "@janusly/engine/src/adapters/dlq-replay";
import { WorkflowSchema, type Workflow, type WorkflowNode } from "@janusly/shared";

import { audit } from "./audit";

/** The deterministic BullMQ scheduler id for the watcher. */
export const AUTO_HEALING_WATCH_JOB_ID = "system:auto-healing-watcher";

/** The `job.name` the api-side Worker dispatch matches on. */
export const AUTO_HEALING_WATCH_JOB_NAME = "auto-healing-watch-trigger";

/** Every minute — bounded by the validating-state row count, which is at
 *  most a handful per scan window. */
export const DEFAULT_AUTO_HEALING_WATCH_CRON = "* * * * *";

/** Stale-row sweep ceiling. A validating row older than this auto-declines
 *  with reason `validation_timeout`. Well above any reasonable sandbox
 *  validation latency; the existing run-timeout machinery should kick in
 *  first in practice, but this is the belt-and-braces fallback. */
const STALE_VALIDATING_HOURS = 2;

const dlqReplay = new DLQReplayAdapter();

// ─── Cron registration ──────────────────────────────────────────────────────

export async function registerAutoHealingWatcherScheduler(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const pattern = resolveWatchCronPattern(env);
  try {
    const { autoHealingQueue } = await import("./auto-healing-queue");
    await autoHealingQueue.upsertJobScheduler(
      AUTO_HEALING_WATCH_JOB_ID,
      { pattern },
      { name: AUTO_HEALING_WATCH_JOB_NAME, data: {} },
    );
    return true;
  } catch (err) {
    console.error("[auto-healing] watcher registration failed", {
      jobId: AUTO_HEALING_WATCH_JOB_ID,
      err,
    });
    return false;
  }
}

function resolveWatchCronPattern(env: NodeJS.ProcessEnv): string {
  const raw = env.JANUSLY_AUTO_HEALING_WATCH_CRON?.trim();
  if (!raw) return DEFAULT_AUTO_HEALING_WATCH_CRON;
  if (!/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(raw)) {
    console.warn(
      "[auto-healing] JANUSLY_AUTO_HEALING_WATCH_CRON invalid; falling back to default",
      { value: raw, default: DEFAULT_AUTO_HEALING_WATCH_CRON },
    );
    return DEFAULT_AUTO_HEALING_WATCH_CRON;
  }
  return raw;
}

// ─── Watcher entry point ────────────────────────────────────────────────────

export async function handleAutoHealingWatchTrigger(): Promise<void> {
  // Stale sweep FIRST so a long-stuck validation doesn't block subsequent
  // auto-healing attempts on the same signature (the row would otherwise
  // count toward the loop breaker until the next sweep window).
  try {
    const stale = await sweepStaleValidating(STALE_VALIDATING_HOURS);
    if (stale > 0) {
      console.log(`[auto-healing] swept ${stale} stale validating rows`);
    }
  } catch (err) {
    console.error("[auto-healing] stale sweep failed", { err });
  }

  let rows: AutoHealingRun[];
  try {
    rows = await listValidatingRows();
  } catch (err) {
    console.error("[auto-healing] watcher row scan failed", { err });
    return;
  }
  if (rows.length === 0) return;

  // Bulk-fetch terminal statuses for all validation runs in one query.
  const validationRunIds = rows
    .map((r) => r.validationRunId)
    .filter((id): id is string => Boolean(id));
  const runRows =
    validationRunIds.length > 0
      ? await db
          .select({
            id: runs.id,
            orgId: runs.orgId,
            status: runs.status,
            inputJson: runs.inputJson,
          })
          .from(runs)
          .where(inArray(runs.id, validationRunIds))
      : [];
  const runById = new Map(runRows.map((r) => [r.id, r]));

  for (const row of rows) {
    try {
      await processValidatingRow(row, runById);
    } catch (err) {
      console.error("[auto-healing] processValidatingRow threw — should never happen", {
        id: row.id,
        err,
      });
    }
  }
}

async function processValidatingRow(
  row: AutoHealingRun,
  runById: Map<string, { id: string; orgId: string; status: string; inputJson: unknown }>,
): Promise<void> {
  if (!row.validationRunId) return;
  const runRow = runById.get(row.validationRunId);
  if (!runRow) return;
  if (runRow.orgId !== row.orgId) {
    console.warn("[auto-healing] validation run org mismatch; skipping row", {
      id: row.id,
      orgId: row.orgId,
      validationRunId: row.validationRunId,
    });
    return;
  }
  // Skip non-terminal states — wait for the next tick.
  if (runRow.status !== "succeeded" && runRow.status !== "failed" && runRow.status !== "cancelled") {
    return;
  }

  // Master gate re-check — a kill switch flipped while the validation
  // was in flight halts before the outcome path runs. We mark the row
  // as validation_failed with reason "feature_disabled" so the audit
  // log distinguishes "operator turned auto-healing off mid-flight"
  // from "the sandbox replay actually failed".
  const consent = await isAutoHealingAllowed(row.orgId);
  if (!consent.allowed) {
    await recordValidationOutcome(row.id, {
      outcome: "validation_failed",
      validationSignature: null,
      reason: "feature_disabled",
    });
    return;
  }

  // Read the failure signature from the validation run's failed node
  // (when there is one). Same `normalizeErrorSignature` the cluster
  // rollup uses, so the comparison is like-for-like.
  let validationSignature: string | null = null;
  if (runRow.status !== "succeeded") {
    validationSignature = await computeValidationFailureSignature(runRow.id);
  }

  if (runRow.status === "succeeded") {
    await recordValidationOutcome(row.id, {
      outcome: "validated",
      validationSignature: null,
    });
    await maybeAutoApply(row);
    return;
  }

  // Failed or cancelled — decide whether signature changed.
  if (runRow.status === "failed" && validationSignature && validationSignature !== row.signature) {
    await recordValidationOutcome(row.id, {
      outcome: "validation_failed",
      validationSignature,
      reason: "signature_changed",
    });
    return;
  }
  await recordValidationOutcome(row.id, {
    outcome: "validation_failed",
    validationSignature,
    reason: "validation_failed",
  });
}

/**
 * Auto-apply branch. Gated by `isAutoApplyAllowed` + loop count
 * re-check + CAS-style `recordDecision`. The production replay
 * targets the original DLQ row's run id with the PATCHED workflow,
 * so the failing node re-runs against the suggested fix.
 */
async function maybeAutoApply(row: AutoHealingRun): Promise<void> {
  if (!row.proposedPatchJson) return;
  const autoApply = await isAutoApplyAllowed(row.orgId);
  if (!autoApply.allowed) return;

  // Re-check loop count — a concurrent scan could have pushed us over
  // since this row was diagnosed.
  let snapshot: Awaited<ReturnType<typeof getOrgConfigSnapshot>>;
  try {
    snapshot = await getOrgConfigSnapshot(row.orgId);
  } catch {
    return;
  }
  const attempts = await countRecentAttemptsBySignature(
    row.orgId,
    row.signature,
    snapshot.autoHealing.loopWindowDays,
  );
  if (attempts > snapshot.autoHealing.maxAttemptsPerSignature) {
    return;
  }

  // Parse the stored patch; defense-in-depth WorkflowSchema check.
  const workflowParse = WorkflowSchema.safeParse(row.proposedPatchJson);
  if (!workflowParse.success) {
    return;
  }
  const patchedWorkflow = workflowParse.data;
  const dlqRow = await loadDlqContext(row.orgId, row.deadLetterId);
  if (!dlqRow) return;
  const failingNode = (patchedWorkflow.nodes as WorkflowNode[]).find(
    (n) => n.id === dlqRow.nodeId,
  );
  if (!failingNode) return;

  // CAS-style apply — only one writer wins (operator click vs this
  // auto-apply). The loser audits silently as "no-op" because the
  // CAS update returns no rows.
  const decision = await recordDecision(row.id, { actor: "auto", accepted: true });
  if (!decision.applied) return;

  // Replay the failing run against the patched workflow.
  try {
    await dlqReplay.replayDeadLetter({
      runId: dlqRow.runId,
      workflow: patchedWorkflow,
      node: failingNode,
    });
    // Distinct action so we don't double-write `auto_healing.applied`
    // (the row-state transition audit lives inside `recordDecision`
    // and fires once per `validated → applied`). The replay-triggered
    // signal carries the "the DLQ row was actually re-enqueued"
    // outcome for operators reading the audit timeline.
    await audit(row.orgId, "system:auto-healing", "auto_healing.replay.triggered", "auto_healing_run", row.id, {
      decisionActor: "auto",
      signature: row.signature,
      deadLetterId: row.deadLetterId,
    });
  } catch (err) {
    console.error("[auto-healing] auto-apply replay failed", { id: row.id, err });
  }
}

async function loadDlqContext(
  orgId: string,
  deadLetterId: string,
): Promise<{ runId: string; nodeId: string } | null> {
  const rows = await db
    .select({ runId: deadLetters.runId, nodeId: deadLetters.nodeId })
    .from(deadLetters)
    .where(and(eq(deadLetters.orgId, orgId), eq(deadLetters.id, deadLetterId)))
    .limit(1);
  return rows[0] ?? null;
}

async function computeValidationFailureSignature(validationRunId: string): Promise<string | null> {
  const rows = await db
    .select({
      nodeId: runNodes.nodeId,
      errorJson: runNodes.errorJson,
    })
    .from(runNodes)
    .where(and(eq(runNodes.runId, validationRunId), eq(runNodes.status, "failed")))
    .limit(1);
  const failed = rows[0];
  if (!failed || !failed.errorJson) return null;
  try {
    const sig = normalizeErrorSignature(failed.errorJson, { nodeId: failed.nodeId });
    return sig.signature;
  } catch {
    return null;
  }
}
