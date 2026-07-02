/**
 * Tenant-scoped data access for the supervised auto-healing decision
 * ledger. Wraps `auto_healing_runs` with the lifecycle writes the
 * background scanner + watcher + operator decision route need, plus
 * the loop-breaker count + idempotency reads.
 *
 * Used by:
 * - `packages/engine/src/auto-healing-scanner.ts` — top-of-loop
 *   diagnosis + per-candidate proposal/validation transitions.
 * - `packages/engine/src/auto-healing-watcher.ts` — outcome recording
 *   and auto-apply CAS-style transition.
 * - `apps/api/src/routes/auto-healing-routes.ts` — pending list,
 *   detail view, and operator decision route (CAS-style apply/decline
 *   so the watcher's auto-apply branch and the operator's manual
 *   click cannot double-apply).
 *
 * Invariants:
 * - Multi-tenant scope: every query carries
 *   `eq(autoHealingRuns.orgId, orgId)`. The pending list, the
 *   loop-breaker count, and the idempotency check are all single-index
 *   lookups.
 * - The transitions `validated → applied` and `validated → declined`
 *   are CAS-style — the UPDATE filters on `status = "validated"` so
 *   only the first writer wins. `recordDecision` returns whether the
 *   update affected a row; the operator decision route turns the
 *   `false` case into 409 `signature_already_resolved`.
 * - Audit rows are written via direct `db.insert(auditLogs)` (the
 *   `audit()` chokepoint lives in `apps/api` and the data package
 *   cannot import upward). Metadata fields are repo-controlled enums,
 *   not user-supplied free-text, so `safePersistPayload` isn't needed
 *   at this layer — patch JSON storage on `auto_healing_runs` goes
 *   through the scanner's own scrubbing path.
 * - `loopAttemptCount` is captured ONCE at diagnose time. Subsequent
 *   audits trace the decision under whatever count was visible to the
 *   scanner at that moment.
 */

import { and, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db, autoHealingRuns, auditLogs } from "@janusly/db";
import { safePersistPayload } from "@janusly/shared/src/safe-persist";

// ─── Closed enums ───────────────────────────────────────────────────────────

/** All possible row statuses across the lifecycle. */
export const AUTO_HEALING_STATUS = [
  "diagnosed",
  "proposed",
  "validating",
  "validated",
  "validation_failed",
  "applied",
  "declined",
  "failed",
] as const;

export type AutoHealingStatus = (typeof AUTO_HEALING_STATUS)[number];

/** Closed enum of decline reasons surfaced via `declineReason`. */
export const AUTO_HEALING_DECLINE_REASONS = [
  "loop_breaker_tripped",
  "budget_exceeded",
  "validation_failed",
  "signature_changed",
  "auto_apply_disabled",
  "manual_review",
  "signature_already_resolved",
  "validation_timeout",
  "scanner_error",
  // Surfaces a kill-switch flip (master gate disabled mid-flight)
  // distinct from a genuine sandbox failure — operators reading the
  // audit log can tell "feature disabled" from "patch didn't work".
  "feature_disabled",
] as const;

export type AutoHealingDeclineReason = (typeof AUTO_HEALING_DECLINE_REASONS)[number];

// ─── Row shape ──────────────────────────────────────────────────────────────

export type AutoHealingRun = {
  id: string;
  orgId: string;
  deadLetterId: string;
  signature: string;
  status: AutoHealingStatus;
  proposedPatchJson: unknown | null;
  approachLabel: string | null;
  confidence: number | null;
  validationRunId: string | null;
  validationSignature: string | null;
  decisionActor: string | null;
  declineReason: AutoHealingDeclineReason | null;
  loopAttemptCount: number;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
};

function rowToRecord(row: typeof autoHealingRuns.$inferSelect): AutoHealingRun {
  return {
    id: row.id,
    orgId: row.orgId,
    deadLetterId: row.deadLetterId,
    signature: row.signature,
    status: row.status as AutoHealingStatus,
    proposedPatchJson: row.proposedPatchJson ?? null,
    approachLabel: row.approachLabel,
    confidence: row.confidence,
    validationRunId: row.validationRunId,
    validationSignature: row.validationSignature,
    decisionActor: row.decisionActor,
    declineReason: row.declineReason as AutoHealingDeclineReason | null,
    loopAttemptCount: row.loopAttemptCount,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt ?? new Date(0),
    updatedAt: row.updatedAt ?? new Date(0),
  };
}

// ─── Lifecycle writes ───────────────────────────────────────────────────────

export type CreateDiagnosisInput = {
  orgId: string;
  deadLetterId: string;
  signature: string;
  loopAttemptCount: number;
};

/**
 * Insert a new auto-healing row with `status: "diagnosed"`. Returns
 * the row id so the scanner can thread it through the rest of the
 * lifecycle. Writes one `auto_healing.diagnosed` audit row.
 */
export async function createDiagnosis(input: CreateDiagnosisInput): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date();
  await db.insert(autoHealingRuns).values({
    id,
    orgId: input.orgId,
    deadLetterId: input.deadLetterId,
    signature: input.signature,
    status: "diagnosed",
    loopAttemptCount: input.loopAttemptCount,
    createdAt: now,
    updatedAt: now,
  });
  await writeAudit(input.orgId, "auto_healing.diagnosed", id, {
    deadLetterId: input.deadLetterId,
    signature: input.signature,
    loopAttemptCount: input.loopAttemptCount,
  });
  return id;
}

export type RecordProposalInput = {
  patchJson: unknown;
  approachLabel: string;
  confidence: number;
};

/**
 * Attach the LLM's proposed patch to a diagnosed row. The patch JSON
 * is stored verbatim; the scanner is expected to have already run it
 * through `sanitizeAiWorkflow` + `WorkflowSchema.safeParse`. Writes
 * one `auto_healing.proposed` audit row.
 */
export async function recordProposal(id: string, input: RecordProposalInput): Promise<void> {
  const updated = await db
    .update(autoHealingRuns)
    .set({
      status: "proposed",
      proposedPatchJson: input.patchJson as never,
      approachLabel: input.approachLabel,
      confidence: input.confidence,
      updatedAt: new Date(),
    })
    .where(eq(autoHealingRuns.id, id))
    .returning({ orgId: autoHealingRuns.orgId });
  const orgId = updated[0]?.orgId;
  if (!orgId) return;
  await writeAudit(orgId, "auto_healing.proposed", id, {
    approachLabel: input.approachLabel,
    confidence: input.confidence,
  });
}

/**
 * Transition `proposed → validating` and record the sandbox run id.
 * No audit row — the validation start fires its own `run.started.validation`
 * event via the engine's replay adapter, and the watcher writes the
 * outcome audit row when the sandbox terminates.
 */
export async function recordValidationStarted(id: string, validationRunId: string): Promise<void> {
  await db
    .update(autoHealingRuns)
    .set({
      status: "validating",
      validationRunId,
      updatedAt: new Date(),
    })
    .where(eq(autoHealingRuns.id, id));
}

export type RecordValidationOutcomeInput =
  | { outcome: "validated"; validationSignature?: string | null }
  | { outcome: "validation_failed"; validationSignature: string | null; reason: "validation_failed" | "signature_changed" | "validation_timeout" | "feature_disabled" };

/**
 * Record the sandbox validation outcome. Two cases:
 * - `validated` — the sandbox replay completed AND the failure
 *   signature is gone. Row moves to `validated`, awaiting operator
 *   decision (or the watcher's auto-apply branch).
 * - `validation_failed` — the sandbox replay failed OR the signature
 *   changed (treated as "not actually a fix"). Row moves to
 *   `validation_failed`, never apply.
 *
 * Writes one `auto_healing.validated` audit row tagged with
 * `{validated, signatureChanged}` so audit log readers can filter.
 */
export async function recordValidationOutcome(
  id: string,
  input: RecordValidationOutcomeInput,
): Promise<void> {
  const validated = input.outcome === "validated";
  const updates: Partial<typeof autoHealingRuns.$inferInsert> = {
    status: input.outcome,
    validationSignature: input.validationSignature ?? null,
    updatedAt: new Date(),
  };
  if (!validated) {
    updates.declineReason = input.reason;
  }
  const updated = await db
    .update(autoHealingRuns)
    .set(updates as never)
    .where(eq(autoHealingRuns.id, id))
    .returning({ orgId: autoHealingRuns.orgId });
  const orgId = updated[0]?.orgId;
  if (!orgId) return;
  await writeAudit(orgId, "auto_healing.validated", id, {
    validated,
    signatureChanged: !validated && (input as { reason?: string }).reason === "signature_changed",
    reason: validated ? null : (input as { reason: string }).reason,
  });
}

export type RecordDecisionInput = {
  actor: string;
  accepted: boolean;
  declineReason?: AutoHealingDeclineReason;
};

export type RecordDecisionResult = { applied: boolean };

/**
 * CAS-style transition `validated → applied | declined`. The UPDATE
 * filters on `status = "validated"`, so a second concurrent caller
 * (operator click racing the watcher's auto-apply, or vice versa)
 * sees zero rows affected and the helper returns `applied: false`.
 *
 * Writes one `auto_healing.applied` audit row on accept OR one
 * `auto_healing.declined` audit row on decline. Both rows mirror the
 * row's `decisionActor` so audit-log readers can distinguish auto vs
 * operator decisions via `metadata.decisionActor`.
 */
export async function recordDecision(
  id: string,
  input: RecordDecisionInput,
): Promise<RecordDecisionResult> {
  const newStatus: AutoHealingStatus = input.accepted ? "applied" : "declined";
  const updated = await db
    .update(autoHealingRuns)
    .set({
      status: newStatus,
      decisionActor: input.actor,
      declineReason: input.accepted ? null : input.declineReason ?? "manual_review",
      updatedAt: new Date(),
    })
    .where(and(eq(autoHealingRuns.id, id), eq(autoHealingRuns.status, "validated")))
    .returning({
      orgId: autoHealingRuns.orgId,
      signature: autoHealingRuns.signature,
      deadLetterId: autoHealingRuns.deadLetterId,
    });
  const row = updated[0];
  if (!row) return { applied: false };
  await writeAudit(
    row.orgId,
    input.accepted ? "auto_healing.applied" : "auto_healing.declined",
    id,
    {
      decisionActor: input.actor,
      signature: row.signature,
      deadLetterId: row.deadLetterId,
      declineReason: input.accepted ? null : input.declineReason ?? "manual_review",
    },
  );
  return { applied: true };
}

/**
 * Mark a row as `declined` with an immediate-rejection reason
 * (`loop_breaker_tripped`, `budget_exceeded`, `auto_apply_disabled`,
 * etc). Used by the scanner BEFORE proposal when one of the
 * front-of-loop gates fires. The actor is always `system_decline_<reason>`
 * because no operator was involved.
 */
export async function recordImmediateDecline(
  orgId: string,
  deadLetterId: string,
  signature: string,
  loopAttemptCount: number,
  reason: AutoHealingDeclineReason,
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date();
  await db.insert(autoHealingRuns).values({
    id,
    orgId,
    deadLetterId,
    signature,
    status: "declined",
    loopAttemptCount,
    decisionActor: `system_decline_${reason}`,
    declineReason: reason,
    createdAt: now,
    updatedAt: now,
  });
  await writeAudit(orgId, "auto_healing.declined", id, {
    decisionActor: `system_decline_${reason}`,
    signature,
    deadLetterId,
    declineReason: reason,
  });
  return id;
}

/**
 * Record a scanner-side failure that's neither a deliberate decline
 * nor a budget/loop gate. Used when an unexpected exception is
 * caught inside `runOrgScan` so the audit log captures the failure
 * mode. Row status is `failed`.
 */
export async function recordScannerFailure(
  orgId: string,
  deadLetterId: string,
  signature: string,
  loopAttemptCount: number,
  errorMessage: string,
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date();
  await db.insert(autoHealingRuns).values({
    id,
    orgId,
    deadLetterId,
    signature,
    status: "failed",
    loopAttemptCount,
    declineReason: "scanner_error",
    createdAt: now,
    updatedAt: now,
  });
  await writeAudit(orgId, "auto_healing.failed", id, {
    signature,
    deadLetterId,
    error: errorMessage,
  });
  return id;
}

// ─── Reads ──────────────────────────────────────────────────────────────────

/**
 * Count prior `auto_healing_runs` rows for the same `(orgId, signature)`
 * inside the window. Used by the scanner's loop-breaker gate; the
 * count includes every status (a previous validation_failed still
 * burns an attempt because the system spent budget on the LLM +
 * sandbox replay).
 */
export async function countRecentAttemptsBySignature(
  orgId: string,
  signature: string,
  windowDays: number,
): Promise<number> {
  const windowStart = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({ value: count() })
    .from(autoHealingRuns)
    .where(
      and(
        eq(autoHealingRuns.orgId, orgId),
        eq(autoHealingRuns.signature, signature),
        gte(autoHealingRuns.createdAt, windowStart),
      ),
    );
  return rows[0]?.value ?? 0;
}

/**
 * Idempotency check: don't re-diagnose a DLQ row that already has an
 * `auto_healing_runs` row, regardless of status. Returns the first
 * match (rows are scoped per-DLQ, so there's normally at most one).
 */
export async function getExistingForDeadLetter(
  orgId: string,
  deadLetterId: string,
): Promise<AutoHealingRun | null> {
  const rows = await db
    .select()
    .from(autoHealingRuns)
    .where(
      and(
        eq(autoHealingRuns.orgId, orgId),
        eq(autoHealingRuns.deadLetterId, deadLetterId),
      ),
    )
    .orderBy(desc(autoHealingRuns.createdAt))
    .limit(1);
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/**
 * Pending decisions list for the org. Capped per the project
 * pagination invariant.
 */
export async function listPendingForOrg(orgId: string, limit = 100): Promise<AutoHealingRun[]> {
  const capped = Math.max(1, Math.min(200, limit));
  const rows = await db
    .select()
    .from(autoHealingRuns)
    .where(
      and(
        eq(autoHealingRuns.orgId, orgId),
        eq(autoHealingRuns.status, "validated"),
      ),
    )
    .orderBy(desc(autoHealingRuns.createdAt))
    .limit(capped);
  return rows.map(rowToRecord);
}

/**
 * Detail-view single-row read scoped to the org. Returns null when
 * no row exists or the row belongs to a different tenant — both
 * paths surface as 404 at the route layer (no enumeration leak).
 */
export async function getByIdForOrg(orgId: string, id: string): Promise<AutoHealingRun | null> {
  const rows = await db
    .select()
    .from(autoHealingRuns)
    .where(and(eq(autoHealingRuns.orgId, orgId), eq(autoHealingRuns.id, id)))
    .limit(1);
  return rows[0] ? rowToRecord(rows[0]) : null;
}

/**
 * Watcher-side query: rows still in `validating` whose sandbox run
 * may have reached terminal status. The watcher joins against `runs`
 * to read terminal status; that join lives in the watcher module so
 * the data layer stays single-table.
 *
 * GLOBAL CROSS-TENANT BY DESIGN. The watcher runs as a system cron
 * and must see every org's validating rows in one pass — there's no
 * caller-supplied `orgId`. Don't add an `orgId` filter here, and
 * don't repurpose this helper for any per-tenant route surface; use
 * `listPendingForOrg` for those.
 */
export async function listValidatingRows(): Promise<AutoHealingRun[]> {
  const rows = await db
    .select()
    .from(autoHealingRuns)
    .where(eq(autoHealingRuns.status, "validating"))
    .orderBy(desc(autoHealingRuns.createdAt))
    .limit(500);
  return rows.map(rowToRecord);
}

/**
 * Watcher-side: rows stuck in `validating` for longer than
 * `staleHours` get auto-declined with reason `validation_timeout`.
 * Returns the count of rows that were swept so the watcher can log.
 */
export async function sweepStaleValidating(staleHours: number): Promise<number> {
  const staleBoundary = new Date(Date.now() - staleHours * 60 * 60 * 1000);
  const swept = await db
    .update(autoHealingRuns)
    .set({
      status: "declined",
      declineReason: "validation_timeout",
      decisionActor: "system_decline_validation_timeout",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(autoHealingRuns.status, "validating"),
        sql`${autoHealingRuns.createdAt} < ${staleBoundary}`,
      ),
    )
    .returning({ id: autoHealingRuns.id, orgId: autoHealingRuns.orgId });
  for (const row of swept) {
    await writeAudit(row.orgId, "auto_healing.declined", row.id, {
      decisionActor: "system_decline_validation_timeout",
      declineReason: "validation_timeout",
    });
  }
  return swept.length;
}

/**
 * Lookup helper used by the scanner's "find existing diagnosis IDs
 * for these dead letters" idempotency path. Returns the set of
 * `deadLetterId` values that already have an `auto_healing_runs`
 * row in any status.
 */
export async function getDeadLetterIdsWithExistingRun(
  orgId: string,
  deadLetterIds: string[],
): Promise<Set<string>> {
  if (deadLetterIds.length === 0) return new Set();
  const rows = await db
    .select({ deadLetterId: autoHealingRuns.deadLetterId })
    .from(autoHealingRuns)
    .where(
      and(
        eq(autoHealingRuns.orgId, orgId),
        inArray(autoHealingRuns.deadLetterId, deadLetterIds),
      ),
    );
  return new Set(rows.map((r) => r.deadLetterId));
}

// ─── Audit (private) ────────────────────────────────────────────────────────

async function writeAudit(
  orgId: string,
  action: string,
  targetId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      orgId,
      userId: null,
      action,
      targetType: "auto_healing_run",
      targetId,
      metadata: safePersistPayload(metadata) as Record<string, unknown>,
    });
  } catch (error) {
    console.warn("[auto-healing] audit write failed", { action, error });
  }
}

// Multi-tenant invariant: tenant-scoped reads and writes keep orgId in the predicate; document system/global exceptions - see AGENTS.md "AuthContext is Janusly-resolved".
