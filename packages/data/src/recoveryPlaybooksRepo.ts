/**
 * Versioned Recovery Playbook persistence and evidence resolution.
 *
 * Used by the Recovery Playbook API routes to promote a proven recovery,
 * manage its manual lifecycle, match an active procedure to a fresh failure,
 * and record sandbox/apply outcomes idempotently.
 *
 * Invariants:
 * - Every read and write is scoped by `orgId`.
 * - Playbooks are orphan-tolerant (no foreign keys), but executable reads join
 *   an active workflow and the exact source version so stale rows are never
 *   offered for use.
 * - JSONB evidence passes through `safePersistPayload` before insertion.
 * - A repeated outcome for the same validation run never increments counters
 *   twice; a terminal regression retires the playbook in the same UPDATE.
 */

import {
  and,
  desc,
  eq,
  isNull,
  ne,
  sql,
} from "drizzle-orm";

import {
  db,
  deadLetters,
  recoveryFeedback,
  recoveryImpactEvents,
  recoveryPlaybooks,
  runs,
  workflowVersions,
  workflows,
} from "@janusly/db";
import { safePersistPayload } from "@janusly/shared/src/safe-persist";

export const RECOVERY_PLAYBOOK_STATUSES = ["draft", "active", "retired"] as const;
export type RecoveryPlaybookStatus = (typeof RECOVERY_PLAYBOOK_STATUSES)[number];

export const RECOVERY_PLAYBOOK_TITLE_MAX_CHARS = 120;
export const RECOVERY_PLAYBOOK_INSTRUCTIONS_MAX_CHARS = 4_000;

export type RecoveryPlaybook = {
  id: string;
  orgId: string;
  workflowId: string | null;
  signature: string;
  version: number;
  status: RecoveryPlaybookStatus;
  title: string;
  instructionsMarkdown: string;
  evidenceRequirementsJson: unknown;
  sourceWorkflowVersionId: string;
  approachLabel: string;
  successfulUses: number;
  regressions: number;
  lastValidatedAt: Date | null;
  lastValidationRunId: string | null;
  lastAppliedValidationRunId: string | null;
  activatedAt: Date | null;
  retiredAt: Date | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
};

export type RecoveryPlaybookWithSource = RecoveryPlaybook & {
  sourceWorkflow: unknown;
};

function toPlaybook(row: typeof recoveryPlaybooks.$inferSelect): RecoveryPlaybook {
  const status = RECOVERY_PLAYBOOK_STATUSES.includes(row.status as RecoveryPlaybookStatus)
    ? row.status as RecoveryPlaybookStatus
    : "retired";
  return {
    ...row,
    status,
    workflowId: row.workflowId ?? null,
    lastValidatedAt: row.lastValidatedAt ?? null,
    lastValidationRunId: row.lastValidationRunId ?? null,
    lastAppliedValidationRunId: row.lastAppliedValidationRunId ?? null,
    activatedAt: row.activatedAt ?? null,
    retiredAt: row.retiredAt ?? null,
    createdBy: row.createdBy ?? null,
    updatedBy: row.updatedBy ?? null,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}

/** Return one playbook by primary key inside an organization. */
export async function getRecoveryPlaybook(orgId: string, id: string): Promise<RecoveryPlaybook | null> {
  const rows = await db
    .select()
    .from(recoveryPlaybooks)
    .where(and(eq(recoveryPlaybooks.orgId, orgId), eq(recoveryPlaybooks.id, id)))
    .limit(1);
  return rows[0] ? toPlaybook(rows[0]) : null;
}

/**
 * Find the newest active playbook that exactly matches workflow + normalized
 * signature and whose executable source snapshot still exists.
 */
export async function findMatchingActiveRecoveryPlaybook(
  orgId: string,
  workflowId: string,
  signature: string,
): Promise<RecoveryPlaybookWithSource | null> {
  const rows = await db
    .select({
      playbook: recoveryPlaybooks,
      sourceWorkflow: workflowVersions.dagJson,
    })
    .from(recoveryPlaybooks)
    .innerJoin(
      workflows,
      and(
        eq(workflows.id, recoveryPlaybooks.workflowId),
        eq(workflows.orgId, recoveryPlaybooks.orgId),
        isNull(workflows.deletedAt),
      ),
    )
    .innerJoin(
      workflowVersions,
      and(
        eq(workflowVersions.id, recoveryPlaybooks.sourceWorkflowVersionId),
        eq(workflowVersions.orgId, recoveryPlaybooks.orgId),
        eq(workflowVersions.workflowId, recoveryPlaybooks.workflowId),
      ),
    )
    .where(and(
      eq(recoveryPlaybooks.orgId, orgId),
      eq(recoveryPlaybooks.workflowId, workflowId),
      eq(recoveryPlaybooks.signature, signature),
      eq(recoveryPlaybooks.status, "active"),
    ))
    .orderBy(desc(recoveryPlaybooks.version))
    .limit(1);
  const row = rows[0];
  return row ? { ...toPlaybook(row.playbook), sourceWorkflow: row.sourceWorkflow } : null;
}

/** Resolve the org-scoped records used to attest a playbook outcome. */
export async function resolveRecoveryPlaybookOutcomeFacts(input: {
  orgId: string;
  playbookId: string;
  deadLetterId: string;
  validationRunId: string;
}): Promise<{
  playbook: RecoveryPlaybook | null;
  deadLetter: typeof deadLetters.$inferSelect | null;
  validationRun: typeof runs.$inferSelect | null;
  impactEvent: typeof recoveryImpactEvents.$inferSelect | null;
}> {
  const [playbook, deadLetterRows, runRows, impactRows] = await Promise.all([
    getRecoveryPlaybook(input.orgId, input.playbookId),
    db.select().from(deadLetters).where(and(
      eq(deadLetters.orgId, input.orgId),
      eq(deadLetters.id, input.deadLetterId),
    )).limit(1),
    db.select().from(runs).where(and(
      eq(runs.orgId, input.orgId),
      eq(runs.id, input.validationRunId),
    )).limit(1),
    db.select().from(recoveryImpactEvents).where(and(
      eq(recoveryImpactEvents.orgId, input.orgId),
      eq(recoveryImpactEvents.deadLetterId, input.deadLetterId),
    )).limit(1),
  ]);
  return {
    playbook,
    deadLetter: deadLetterRows[0] ?? null,
    validationRun: runRows[0] ?? null,
    impactEvent: impactRows[0] ?? null,
  };
}

export type RecoveryPlaybookPromotionEvidence = {
  deadLetter: typeof deadLetters.$inferSelect | null;
  validationRun: typeof runs.$inferSelect | null;
  sourceVersion: typeof workflowVersions.$inferSelect | null;
  acceptedFeedback: { id: string; workflowId: string; approachLabel: string; suggestionMode: string; createdAt: Date | null } | null;
};

/**
 * Resolve every server-owned fact required to promote a recovery. The route
 * applies semantic checks (terminal status, exact DAG equality, timestamps)
 * over this bounded envelope; caller-supplied evidence is never trusted.
 */
export async function resolveRecoveryPlaybookPromotionEvidence(input: {
  orgId: string;
  deadLetterId: string;
  validationRunId: string;
  sourceWorkflowVersionId: string;
}): Promise<RecoveryPlaybookPromotionEvidence> {
  const [deadLetterRows, validationRows, versionRows, feedbackRows] = await Promise.all([
    db.select().from(deadLetters).where(and(
      eq(deadLetters.orgId, input.orgId),
      eq(deadLetters.id, input.deadLetterId),
    )).limit(1),
    db.select().from(runs).where(and(
      eq(runs.orgId, input.orgId),
      eq(runs.id, input.validationRunId),
    )).limit(1),
    db.select().from(workflowVersions).where(and(
      eq(workflowVersions.orgId, input.orgId),
      eq(workflowVersions.id, input.sourceWorkflowVersionId),
    )).limit(1),
    db.select({
      id: recoveryFeedback.id,
      workflowId: recoveryFeedback.workflowId,
      approachLabel: recoveryFeedback.approachLabel,
      suggestionMode: recoveryFeedback.suggestionMode,
      createdAt: recoveryFeedback.createdAt,
    })
      .from(recoveryFeedback)
      .where(and(
        eq(recoveryFeedback.orgId, input.orgId),
        eq(recoveryFeedback.deadLetterId, input.deadLetterId),
        eq(recoveryFeedback.accepted, true),
      ))
      .orderBy(desc(recoveryFeedback.createdAt))
      .limit(1),
  ]);

  const validationCreatedAt = validationRows[0]?.createdAt ?? null;
  const acceptedFeedback = feedbackRows.find((row) => {
    if (!validationCreatedAt || !row.createdAt) return true;
    return row.createdAt >= validationCreatedAt;
  }) ?? null;
  return {
    deadLetter: deadLetterRows[0] ?? null,
    validationRun: validationRows[0] ?? null,
    sourceVersion: versionRows[0] ?? null,
    acceptedFeedback: acceptedFeedback ? {
      id: acceptedFeedback.id,
      workflowId: acceptedFeedback.workflowId,
      approachLabel: acceptedFeedback.approachLabel,
      suggestionMode: acceptedFeedback.suggestionMode,
      createdAt: acceptedFeedback.createdAt ?? null,
    } : null,
  };
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!current || typeof current !== "object") return false;
    if ((current as { code?: unknown }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Create an immutable draft version, idempotent by source workflow version. */
export async function createRecoveryPlaybookDraft(input: {
  orgId: string;
  workflowId: string;
  signature: string;
  title: string;
  instructionsMarkdown: string;
  evidenceRequirementsJson: unknown;
  sourceWorkflowVersionId: string;
  approachLabel: string;
  validationRunId: string;
  actor: string | null;
}): Promise<{ playbook: RecoveryPlaybook; created: boolean }> {
  const existing = await db.select().from(recoveryPlaybooks).where(and(
    eq(recoveryPlaybooks.orgId, input.orgId),
    eq(recoveryPlaybooks.sourceWorkflowVersionId, input.sourceWorkflowVersionId),
  )).limit(1);
  if (existing[0]) return { playbook: toPlaybook(existing[0]), created: false };

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const latest = await db.select({ version: recoveryPlaybooks.version })
      .from(recoveryPlaybooks)
      .where(and(
        eq(recoveryPlaybooks.orgId, input.orgId),
        eq(recoveryPlaybooks.signature, input.signature),
      ))
      .orderBy(desc(recoveryPlaybooks.version))
      .limit(1);
    const version = (latest[0]?.version ?? 0) + 1;
    const now = new Date();
    const row = {
      id: crypto.randomUUID(),
      orgId: input.orgId,
      workflowId: input.workflowId,
      signature: input.signature,
      version,
      status: "draft",
      title: input.title.slice(0, RECOVERY_PLAYBOOK_TITLE_MAX_CHARS),
      instructionsMarkdown: input.instructionsMarkdown.slice(0, RECOVERY_PLAYBOOK_INSTRUCTIONS_MAX_CHARS),
      evidenceRequirementsJson: safePersistPayload(input.evidenceRequirementsJson),
      sourceWorkflowVersionId: input.sourceWorkflowVersionId,
      approachLabel: input.approachLabel,
      lastValidatedAt: now,
      lastValidationRunId: input.validationRunId,
      createdBy: input.actor,
      updatedBy: input.actor,
      createdAt: now,
      updatedAt: now,
    } satisfies typeof recoveryPlaybooks.$inferInsert;
    try {
      const inserted = await db.insert(recoveryPlaybooks).values(row).returning();
      return { playbook: toPlaybook(inserted[0]!), created: true };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const duplicate = await db.select().from(recoveryPlaybooks).where(and(
        eq(recoveryPlaybooks.orgId, input.orgId),
        eq(recoveryPlaybooks.sourceWorkflowVersionId, input.sourceWorkflowVersionId),
      )).limit(1);
      if (duplicate[0]) return { playbook: toPlaybook(duplicate[0]), created: false };
      if (attempt === 2) throw error;
    }
  }
  throw new Error("recovery playbook version retry exhausted");
}

export type RecoveryPlaybookLifecycleResult =
  | { kind: "ok"; playbook: RecoveryPlaybook }
  | { kind: "not_found" }
  | { kind: "conflict" }
  | { kind: "invalid_status"; status: RecoveryPlaybookStatus };

/** Activate a draft and retire any previous active match in one transaction. */
export async function activateRecoveryPlaybook(
  orgId: string,
  id: string,
  actor: string | null,
): Promise<RecoveryPlaybookLifecycleResult> {
  try {
    return await db.transaction(async (tx) => {
      const rows = await tx.select().from(recoveryPlaybooks).where(and(
        eq(recoveryPlaybooks.orgId, orgId),
        eq(recoveryPlaybooks.id, id),
      )).limit(1);
      const current = rows[0];
      if (!current) return { kind: "not_found" };
      const currentStatus = toPlaybook(current).status;
      if (currentStatus !== "draft") return { kind: "invalid_status", status: currentStatus };
      const now = new Date();
      await tx.update(recoveryPlaybooks).set({
        status: "retired",
        retiredAt: now,
        updatedAt: now,
        updatedBy: actor,
      }).where(and(
        eq(recoveryPlaybooks.orgId, orgId),
        current.workflowId
          ? eq(recoveryPlaybooks.workflowId, current.workflowId)
          : isNull(recoveryPlaybooks.workflowId),
        eq(recoveryPlaybooks.signature, current.signature),
        eq(recoveryPlaybooks.status, "active"),
        ne(recoveryPlaybooks.id, id),
      ));
      const updated = await tx.update(recoveryPlaybooks).set({
        status: "active",
        activatedAt: now,
        retiredAt: null,
        updatedAt: now,
        updatedBy: actor,
      }).where(and(
        eq(recoveryPlaybooks.orgId, orgId),
        eq(recoveryPlaybooks.id, id),
        eq(recoveryPlaybooks.status, "draft"),
      )).returning();
      return updated[0]
        ? { kind: "ok", playbook: toPlaybook(updated[0]) }
        : { kind: "invalid_status", status: currentStatus };
    });
  } catch (error) {
    // A partial unique index guarantees one active exact match even when two
    // operators activate different drafts concurrently. The loser stays a
    // draft because the whole transaction rolls back and gets a clean 409.
    if (isUniqueViolation(error)) return { kind: "conflict" };
    throw error;
  }
}

/** Retire a draft or active playbook. Already-retired rows are idempotent. */
export async function retireRecoveryPlaybook(
  orgId: string,
  id: string,
  actor: string | null,
): Promise<RecoveryPlaybookLifecycleResult> {
  const current = await getRecoveryPlaybook(orgId, id);
  if (!current) return { kind: "not_found" };
  if (current.status === "retired") return { kind: "ok", playbook: current };
  const now = new Date();
  const rows = await db.update(recoveryPlaybooks).set({
    status: "retired",
    retiredAt: now,
    updatedAt: now,
    updatedBy: actor,
  }).where(and(
    eq(recoveryPlaybooks.orgId, orgId),
    eq(recoveryPlaybooks.id, id),
  )).returning();
  return rows[0] ? { kind: "ok", playbook: toPlaybook(rows[0]) } : { kind: "not_found" };
}

/**
 * Record a terminal sandbox status once. Failed/cancelled validation retires
 * the playbook atomically with the regression increment.
 */
export async function recordRecoveryPlaybookValidationOutcome(input: {
  orgId: string;
  id: string;
  validationRunId: string;
  succeeded: boolean;
  actor: string | null;
}): Promise<{ playbook: RecoveryPlaybook | null; recorded: boolean }> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const currentRows = await tx.select().from(recoveryPlaybooks).where(and(
      eq(recoveryPlaybooks.orgId, input.orgId),
      eq(recoveryPlaybooks.id, input.id),
    )).limit(1).for("update");
    if (!currentRows[0]) return { playbook: null, recorded: false };

    const claimed = await tx.update(runs).set({
      recoveryPlaybookValidationRecordedAt: now,
    }).where(and(
      eq(runs.orgId, input.orgId),
      eq(runs.id, input.validationRunId),
      eq(runs.replayMode, "validation"),
      isNull(runs.recoveryPlaybookValidationRecordedAt),
    )).returning({ id: runs.id });
    if (!claimed[0]) return { playbook: toPlaybook(currentRows[0]), recorded: false };

    const rows = await tx.update(recoveryPlaybooks).set(input.succeeded ? {
      lastValidatedAt: now,
      lastValidationRunId: input.validationRunId,
      updatedAt: now,
      updatedBy: input.actor,
    } : {
      status: "retired",
      regressions: sql`${recoveryPlaybooks.regressions} + 1`,
      lastValidationRunId: input.validationRunId,
      retiredAt: now,
      updatedAt: now,
      updatedBy: input.actor,
    }).where(and(
      eq(recoveryPlaybooks.orgId, input.orgId),
      eq(recoveryPlaybooks.id, input.id),
    )).returning();
    return { playbook: rows[0] ? toPlaybook(rows[0]) : null, recorded: Boolean(rows[0]) };
  });
}

type RecoveryPlaybookTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type RecordRecoveryPlaybookAppliedInput = {
  orgId: string;
  id: string;
  validationRunId: string;
  actor: string | null;
  /** Terminal production-success timestamp; defaults to the current time for legacy callers. */
  recordedAt?: Date;
};

/**
 * Increment successful use once for a passed validation run inside the
 * caller's transaction. Terminal recovery uses this so node success, impact,
 * and the playbook counter cannot commit independently.
 */
export async function recordRecoveryPlaybookAppliedTx(
  tx: RecoveryPlaybookTx,
  input: RecordRecoveryPlaybookAppliedInput,
): Promise<{ playbook: RecoveryPlaybook | null; recorded: boolean }> {
  const now = input.recordedAt ?? new Date();
  const currentRows = await tx.select().from(recoveryPlaybooks).where(and(
    eq(recoveryPlaybooks.orgId, input.orgId),
    eq(recoveryPlaybooks.id, input.id),
  )).limit(1).for("update");
  const current = currentRows[0];
  if (!current || toPlaybook(current).status !== "active") {
    return { playbook: current ? toPlaybook(current) : null, recorded: false };
  }

  const claimed = await tx.update(runs).set({
    recoveryPlaybookAppliedRecordedAt: now,
  }).where(and(
    eq(runs.orgId, input.orgId),
    eq(runs.id, input.validationRunId),
    eq(runs.replayMode, "validation"),
    isNull(runs.recoveryPlaybookAppliedRecordedAt),
  )).returning({ id: runs.id });
  if (!claimed[0]) return { playbook: toPlaybook(current), recorded: false };

  const rows = await tx.update(recoveryPlaybooks).set({
    successfulUses: sql`${recoveryPlaybooks.successfulUses} + 1`,
    lastAppliedValidationRunId: input.validationRunId,
    updatedAt: now,
    updatedBy: input.actor,
  }).where(and(
    eq(recoveryPlaybooks.orgId, input.orgId),
    eq(recoveryPlaybooks.id, input.id),
    eq(recoveryPlaybooks.status, "active"),
  )).returning();
  return { playbook: rows[0] ? toPlaybook(rows[0]) : null, recorded: Boolean(rows[0]) };
}

/** Increment successful use once for a terminally successful production replay. */
export async function recordRecoveryPlaybookApplied(
  input: RecordRecoveryPlaybookAppliedInput,
): Promise<{ playbook: RecoveryPlaybook | null; recorded: boolean }> {
  return db.transaction((tx) => recordRecoveryPlaybookAppliedTx(tx, input));
}
