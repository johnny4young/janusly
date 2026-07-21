/**
 * Durable workflow-version canary rollout persistence and assignment.
 *
 * Used by run entrypoints to resolve one immutable baseline/canary version,
 * by the workflow API for rollout lifecycle controls, and by the terminal-run
 * observer for idempotent evidence plus automatic rollback.
 *
 * Invariants:
 * - At most one active rollout per organization/workflow (partial unique DB index).
 * - The canary must be the latest version and newer than its baseline.
 * - External trigger nodes must be byte-semantically compatible across both
 *   versions so an allocated event/tick cannot lose its ingress node.
 * - Assignment is deterministic for a stable key and never recalculated once
 *   captured on the run row.
 * - Retries, replays, validation runs, and pinned subworkflows do not enter here.
 */

import { createHash } from "node:crypto";

import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";

import {
  auditLogs,
  db,
  runs,
  workflowRolloutOutcomes,
  workflowRollouts,
  workflows,
  workflowVersions,
} from "@janusly/db";
import { WorkflowSchema, type Workflow } from "@janusly/shared";

export const WORKFLOW_ROLLOUT_TRAFFIC_MIN = 1;
export const WORKFLOW_ROLLOUT_TRAFFIC_MAX = 50;
export const WORKFLOW_ROLLOUT_SAMPLE_MIN = 5;
export const WORKFLOW_ROLLOUT_SAMPLE_MAX = 100;
export const WORKFLOW_ROLLOUT_SUCCESS_RATE_MIN = 1;
export const WORKFLOW_ROLLOUT_SUCCESS_RATE_MAX = 100;

export type WorkflowRollout = typeof workflowRollouts.$inferSelect;
export type WorkflowRolloutVariant = "baseline" | "canary";

const EXTERNAL_TRIGGER_TYPES = new Set([
  "schedule",
  "email_received",
  "file_dropped",
  "mcp_server_event",
]);

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function externalTriggerContract(workflow: Workflow): string {
  const triggers = workflow.nodes
    .filter((node) => EXTERNAL_TRIGGER_TYPES.has(node.type))
    .map((node) => ({ id: node.id, type: node.type, config: node.config ?? {} }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return stableJson(triggers);
}

/** Require identical external-trigger ids, types, and configs across variants. */
export function haveCompatibleWorkflowRolloutTriggers(
  baseline: Workflow,
  canary: Workflow,
): boolean {
  return externalTriggerContract(baseline) === externalTriggerContract(canary);
}

/** Stable 0..99 assignment bucket from an opaque event/run key. */
export function workflowRolloutBucket(rolloutId: string, assignmentKey: string): number {
  const digest = createHash("sha256")
    .update(JSON.stringify([rolloutId, assignmentKey]))
    .digest();
  return digest.readUInt32BE(0) % 100;
}

function validBound(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; cause?: { code?: unknown } };
  return record.code === "23505" || record.cause?.code === "23505";
}

export type CreateWorkflowRolloutResult =
  | { kind: "created"; rollout: WorkflowRollout }
  | { kind: "not_found" | "invalid_versions" | "canary_not_latest" | "incompatible_triggers" | "active_exists" };

/** Start one rollout after validating both immutable version snapshots. */
export async function createWorkflowRollout(input: {
  orgId: string;
  workflowId: string;
  baselineVersionId: string;
  canaryVersionId: string;
  trafficPercent: number;
  minimumSampleSize: number;
  minimumSuccessRatePercent: number;
  createdBy: string;
}): Promise<CreateWorkflowRolloutResult> {
  if (
    !validBound(input.trafficPercent, WORKFLOW_ROLLOUT_TRAFFIC_MIN, WORKFLOW_ROLLOUT_TRAFFIC_MAX)
    || !validBound(input.minimumSampleSize, WORKFLOW_ROLLOUT_SAMPLE_MIN, WORKFLOW_ROLLOUT_SAMPLE_MAX)
    || !validBound(
      input.minimumSuccessRatePercent,
      WORKFLOW_ROLLOUT_SUCCESS_RATE_MIN,
      WORKFLOW_ROLLOUT_SUCCESS_RATE_MAX,
    )
    || input.baselineVersionId === input.canaryVersionId
  ) {
    return { kind: "invalid_versions" };
  }

  try {
    return await db.transaction(async (tx): Promise<CreateWorkflowRolloutResult> => {
      const [parent] = await tx.select({ id: workflows.id })
        .from(workflows)
        .where(and(
          eq(workflows.orgId, input.orgId),
          eq(workflows.id, input.workflowId),
          isNull(workflows.deletedAt),
        ))
        .limit(1)
        .for("update");
      if (!parent) return { kind: "not_found" };

      const versions = await tx.select({
        id: workflowVersions.id,
        version: workflowVersions.version,
        dagJson: workflowVersions.dagJson,
      })
        .from(workflowVersions)
        .where(and(
          eq(workflowVersions.orgId, input.orgId),
          eq(workflowVersions.workflowId, input.workflowId),
        ))
        .orderBy(desc(workflowVersions.version));
      const latest = versions[0];
      const baseline = versions.find((version) => version.id === input.baselineVersionId);
      const canary = versions.find((version) => version.id === input.canaryVersionId);
      if (!baseline || !canary || baseline.version >= canary.version) {
        return { kind: "invalid_versions" };
      }
      if (latest?.id !== canary.id) return { kind: "canary_not_latest" };

      const baselineWorkflow = WorkflowSchema.safeParse(baseline.dagJson);
      const canaryWorkflow = WorkflowSchema.safeParse(canary.dagJson);
      if (!baselineWorkflow.success || !canaryWorkflow.success) return { kind: "invalid_versions" };
      if (!haveCompatibleWorkflowRolloutTriggers(baselineWorkflow.data, canaryWorkflow.data)) {
        return { kind: "incompatible_triggers" };
      }

      const [active] = await tx.select({ id: workflowRollouts.id })
        .from(workflowRollouts)
        .where(and(
          eq(workflowRollouts.orgId, input.orgId),
          eq(workflowRollouts.workflowId, input.workflowId),
          eq(workflowRollouts.status, "active"),
        ))
        .limit(1);
      if (active) return { kind: "active_exists" };

      const [rollout] = await tx.insert(workflowRollouts).values({
        id: crypto.randomUUID(),
        orgId: input.orgId,
        workflowId: input.workflowId,
        baselineVersionId: baseline.id,
        canaryVersionId: canary.id,
        trafficPercent: input.trafficPercent,
        minimumSampleSize: input.minimumSampleSize,
        minimumSuccessRatePercent: input.minimumSuccessRatePercent,
        createdBy: input.createdBy,
      }).returning();
      if (!rollout) throw new Error("workflow_rollout_create_failed");
      return { kind: "created", rollout };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { kind: "active_exists" };
    throw error;
  }
}

/** Read the newest rollout state for one active workflow. */
export async function getLatestWorkflowRollout(
  orgId: string,
  workflowId: string,
): Promise<WorkflowRollout | null> {
  const rows = await db.select({ rollout: workflowRollouts }).from(workflowRollouts)
    .innerJoin(workflows, and(
      eq(workflows.id, workflowRollouts.workflowId),
      eq(workflows.orgId, workflowRollouts.orgId),
    ))
    .where(and(
      eq(workflowRollouts.orgId, orgId),
      eq(workflowRollouts.workflowId, workflowId),
      isNull(workflows.deletedAt),
    ))
    // Prefer the unique active row even when it was created in the same clock
    // tick as a just-finished rollout, then keep historical reads deterministic.
    .orderBy(
      sql`CASE WHEN ${workflowRollouts.status} = 'active' THEN 0 ELSE 1 END`,
      desc(workflowRollouts.createdAt),
      desc(workflowRollouts.id),
    )
    .limit(1);
  return rows[0]?.rollout ?? null;
}

/** True while save/rollback must not mint another version under live traffic. */
export async function hasActiveWorkflowRollout(orgId: string, workflowId: string): Promise<boolean> {
  const rows = await db.select({ id: workflowRollouts.id }).from(workflowRollouts)
    .where(and(
      eq(workflowRollouts.orgId, orgId),
      eq(workflowRollouts.workflowId, workflowId),
      eq(workflowRollouts.status, "active"),
    ))
    .limit(1);
  return rows.length > 0;
}

export type WorkflowRolloutAssignment = {
  rollout: WorkflowRollout;
  variant: WorkflowRolloutVariant;
  versionId: string;
  version: number;
  workflow: Workflow;
};

/**
 * Resolve a durable deployment choice while the rollout canary is still the
 * latest saved version. Returns null when ordinary latest-version behavior
 * should remain unchanged.
 */
export async function resolveWorkflowRolloutAssignment(input: {
  orgId: string;
  workflowId: string;
  assignmentKey: string;
}): Promise<WorkflowRolloutAssignment | null> {
  const rollout = await getLatestWorkflowRollout(input.orgId, input.workflowId);
  if (!rollout) return null;

  const versions = await db.select({
    id: workflowVersions.id,
    version: workflowVersions.version,
    dagJson: workflowVersions.dagJson,
  }).from(workflowVersions)
    .where(and(
      eq(workflowVersions.orgId, input.orgId),
      eq(workflowVersions.workflowId, input.workflowId),
    ))
    .orderBy(desc(workflowVersions.version));
  if (versions[0]?.id !== rollout.canaryVersionId) return null;

  let variant: WorkflowRolloutVariant;
  if (rollout.status === "active") {
    variant = workflowRolloutBucket(rollout.id, input.assignmentKey) < rollout.trafficPercent
      ? "canary"
      : "baseline";
  } else if (rollout.status === "promoted") {
    variant = "canary";
  } else {
    variant = "baseline";
  }
  const versionId = variant === "canary" ? rollout.canaryVersionId : rollout.baselineVersionId;
  const selected = versions.find((version) => version.id === versionId);
  const parsed = WorkflowSchema.safeParse(selected?.dagJson);
  if (!selected || !parsed.success) throw new Error("workflow_rollout_version_unavailable");
  return { rollout, variant, versionId, version: selected.version, workflow: parsed.data };
}

export type FinishWorkflowRolloutResult =
  | { kind: "updated"; rollout: WorkflowRollout }
  | { kind: "not_found" }
  | { kind: "not_active" };

/** Promote the canary or return all traffic to baseline with a CAS. */
export async function finishWorkflowRollout(input: {
  orgId: string;
  workflowId: string;
  rolloutId: string;
  decision: "promote" | "rollback";
  reason?: string;
}): Promise<FinishWorkflowRolloutResult> {
  const [existing] = await db.select().from(workflowRollouts).where(and(
    eq(workflowRollouts.id, input.rolloutId),
    eq(workflowRollouts.orgId, input.orgId),
    eq(workflowRollouts.workflowId, input.workflowId),
  )).limit(1);
  if (!existing) return { kind: "not_found" };
  if (existing.status !== "active") return { kind: "not_active" };
  const now = new Date();
  const [updated] = await db.update(workflowRollouts).set({
    status: input.decision === "promote" ? "promoted" : "rolled_back",
    rolledBackReason: input.decision === "rollback"
      ? (input.reason?.trim().slice(0, 500) || "operator_rollback")
      : null,
    endedAt: now,
    updatedAt: now,
  }).where(and(
    eq(workflowRollouts.id, input.rolloutId),
    eq(workflowRollouts.orgId, input.orgId),
    eq(workflowRollouts.workflowId, input.workflowId),
    eq(workflowRollouts.status, "active"),
  )).returning();
  return updated ? { kind: "updated", rollout: updated } : { kind: "not_active" };
}

/** Atomically tombstone a workflow and cancel its live deployment control. */
export async function softDeleteWorkflow(
  orgId: string,
  workflowId: string,
  reason = "workflow_deleted",
): Promise<boolean> {
  return db.transaction(async (tx) => {
    // Rollout creation and version writes take this same parent lock first, so
    // no active deployment can appear between the tombstone and cancellation.
    const [parent] = await tx.select({ id: workflows.id })
      .from(workflows)
      .where(and(
        eq(workflows.id, workflowId),
        eq(workflows.orgId, orgId),
        isNull(workflows.deletedAt),
      ))
      .limit(1)
      .for("update");
    if (!parent) return false;

    const now = new Date();
    await tx.update(workflows).set({ deletedAt: now }).where(and(
      eq(workflows.id, workflowId),
      eq(workflows.orgId, orgId),
      isNull(workflows.deletedAt),
    ));
    await tx.update(workflowRollouts).set({
      status: "cancelled",
      rolledBackReason: reason.slice(0, 500),
      endedAt: now,
      updatedAt: now,
    }).where(and(
      eq(workflowRollouts.orgId, orgId),
      eq(workflowRollouts.workflowId, workflowId),
      eq(workflowRollouts.status, "active"),
    ));
    return true;
  });
}

export type RecordWorkflowRolloutOutcomeResult =
  | { kind: "ignored" | "duplicate" }
  | { kind: "recorded"; autoRolledBack: boolean; rollout: WorkflowRollout };

export type UnrecordedWorkflowRolloutOutcome = {
  runId: string;
  status: "succeeded" | "failed" | "cancelled";
};

/**
 * List bounded terminal production runs still missing their rollout receipt.
 *
 * Only active rollouts are eligible: once an operator or guardrail finishes a
 * rollout, later terminal arrivals deliberately cannot alter its frozen
 * evidence. Concurrent repair workers are safe because the outcome receipt is
 * keyed by run id and the aggregate update shares the recording transaction.
 */
export async function listUnrecordedWorkflowRolloutOutcomes(
  limit = 500,
): Promise<UnrecordedWorkflowRolloutOutcome[]> {
  const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const rows = await db.select({
    runId: runs.id,
    status: runs.status,
  }).from(runs)
    .innerJoin(workflowRollouts, and(
      eq(workflowRollouts.id, runs.workflowRolloutId),
      eq(workflowRollouts.orgId, runs.orgId),
      eq(workflowRollouts.status, "active"),
    ))
    .leftJoin(workflowRolloutOutcomes, eq(workflowRolloutOutcomes.runId, runs.id))
    .where(and(
      isNotNull(runs.workflowRolloutId),
      isNull(runs.replayMode),
      inArray(runs.status, ["succeeded", "failed", "cancelled"]),
      isNull(workflowRolloutOutcomes.runId),
    ))
    .orderBy(asc(runs.createdAt), asc(runs.id))
    .limit(boundedLimit);

  return rows.map((row) => ({
    runId: row.runId,
    status: row.status as UnrecordedWorkflowRolloutOutcome["status"],
  }));
}

/**
 * Record one terminal production outcome and auto-rollback an unhealthy
 * canary atomically with its system audit evidence.
 */
export async function recordWorkflowRolloutOutcome(
  runId: string,
  status: "succeeded" | "failed" | "cancelled",
): Promise<RecordWorkflowRolloutOutcomeResult> {
  return db.transaction(async (tx): Promise<RecordWorkflowRolloutOutcomeResult> => {
    const [run] = await tx.select({
      orgId: runs.orgId,
      replayMode: runs.replayMode,
      rolloutId: runs.workflowRolloutId,
      variant: runs.workflowRolloutVariant,
      workflowVersionId: runs.workflowVersionId,
      status: runs.status,
    }).from(runs).where(eq(runs.id, runId)).limit(1);
    if (!run?.rolloutId || !run.variant || run.replayMode !== null) return { kind: "ignored" };
    if (run.status !== status || !["succeeded", "failed", "cancelled"].includes(run.status)) {
      return { kind: "ignored" };
    }

    const [rollout] = await tx.select().from(workflowRollouts).where(and(
      eq(workflowRollouts.id, run.rolloutId),
      eq(workflowRollouts.orgId, run.orgId),
      eq(workflowRollouts.status, "active"),
    )).limit(1);
    if (!rollout) return { kind: "ignored" };
    const expectedVersionId = run.variant === "canary"
      ? rollout.canaryVersionId
      : rollout.baselineVersionId;
    if (run.workflowVersionId !== expectedVersionId) return { kind: "ignored" };

    const receipts = await tx.insert(workflowRolloutOutcomes).values({
      runId,
      orgId: run.orgId,
      rolloutId: rollout.id,
      workflowId: rollout.workflowId,
      variant: run.variant,
      status,
    }).onConflictDoNothing({ target: workflowRolloutOutcomes.runId }).returning({
      runId: workflowRolloutOutcomes.runId,
    });
    if (receipts.length === 0) return { kind: "duplicate" };

    const increment = status === "cancelled"
      ? {}
      : run.variant === "canary"
        ? status === "succeeded"
          ? { canarySucceeded: sql`${workflowRollouts.canarySucceeded} + 1` }
          : { canaryFailed: sql`${workflowRollouts.canaryFailed} + 1` }
        : status === "succeeded"
          ? { baselineSucceeded: sql`${workflowRollouts.baselineSucceeded} + 1` }
          : { baselineFailed: sql`${workflowRollouts.baselineFailed} + 1` };
    const now = new Date();
    const [updated] = await tx.update(workflowRollouts).set({
      ...increment,
      lastOutcomeAt: now,
      updatedAt: now,
    }).where(and(
      eq(workflowRollouts.id, rollout.id),
      eq(workflowRollouts.status, "active"),
    )).returning();
    if (!updated) return { kind: "ignored" };

    const canarySample = updated.canarySucceeded + updated.canaryFailed;
    const canarySuccessRate = canarySample === 0
      ? 100
      : (updated.canarySucceeded / canarySample) * 100;
    const shouldRollback = run.variant === "canary"
      && status !== "cancelled"
      && canarySample >= updated.minimumSampleSize
      && canarySuccessRate < updated.minimumSuccessRatePercent;
    if (!shouldRollback) return { kind: "recorded", autoRolledBack: false, rollout: updated };

    const reason = "canary_success_rate_breach";
    const [rolledBack] = await tx.update(workflowRollouts).set({
      status: "rolled_back",
      rolledBackReason: reason,
      endedAt: now,
      updatedAt: now,
    }).where(and(
      eq(workflowRollouts.id, rollout.id),
      eq(workflowRollouts.status, "active"),
    )).returning();
    if (!rolledBack) return { kind: "recorded", autoRolledBack: false, rollout: updated };

    await tx.insert(auditLogs).values({
      id: crypto.randomUUID(),
      orgId: rolledBack.orgId,
      userId: null,
      action: "workflow.rollout.auto_rolled_back",
      targetType: "workflow_rollout",
      targetId: rolledBack.id,
      metadata: {
        workflowId: rolledBack.workflowId,
        baselineVersionId: rolledBack.baselineVersionId,
        canaryVersionId: rolledBack.canaryVersionId,
        canarySucceeded: rolledBack.canarySucceeded,
        canaryFailed: rolledBack.canaryFailed,
        minimumSampleSize: rolledBack.minimumSampleSize,
        minimumSuccessRatePercent: rolledBack.minimumSuccessRatePercent,
        observedSuccessRatePercent: canarySuccessRate,
        reason,
      },
    });
    return { kind: "recorded", autoRolledBack: true, rollout: rolledBack };
  });
}
