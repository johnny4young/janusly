/**
 * Repository for the `onboarding_progress` table — the thin per-`(orgId,
 * userId)` cache backing the "first recovered run" guided checklist.
 *
 * The row is NOT the source of truth for milestone completion. The six
 * advanceable milestones are DERIVED live from durable org-state via
 * `resolveOnboardingMilestones` (a credentials row, a succeeded run, a DLQ
 * row, a replayed/resolved DLQ row, a `workflow.pack_imported` audit row).
 * This repo persists only:
 * - `step` — a monotonic high-water mark (hysteresis so a reached milestone
 *   never visually un-checks if a derived signal later regresses).
 * - `status` — `active` / `skipped` / `completed`, with the `completed`
 *   transition guarded by a CAS so a single completion audit fires under
 *   parallel reads.
 *
 * Used by:
 * - `apps/api/src/routes/onboarding-routes.ts` — `GET`/`POST /onboarding`.
 *
 * Invariants:
 * - Multi-tenant scope: every read/write filters by `orgId` (and `userId`
 *   for the row itself). The milestone-derivation reads are org-scoped.
 * - Idempotent create via `ON CONFLICT (org_id, user_id) DO NOTHING` so
 *   concurrent first-reads converge on one row.
 * - High-water never regresses: `advanceOnboardingHighWater` only writes
 *   when the target step's index exceeds the persisted one.
 */

import { type AnyColumn, and, eq, gte, inArray, sql } from "drizzle-orm";
import {
  auditLogs,
  credentials,
  db,
  deadLetters,
  onboardingProgress,
  runs,
  recoveryItems,
} from "@janusly/db";
import {
  type OnboardingStep,
  stepIndex,
  isOnboardingStep,
} from "@janusly/shared/src/onboarding";

/** A persisted `onboarding_progress` row. */
export type OnboardingProgressRow = typeof onboardingProgress.$inferSelect;

/**
 * The five independently-derived milestone booleans (everything between
 * `org_created`, which is always true once authenticated, and the
 * `completed` aggregate). Computed fresh from durable org-state on each read.
 */
export type OnboardingMilestoneSignals = {
  credentialConfigured: boolean;
  packInstalled: boolean;
  firstRunSucceeded: boolean;
  failureInjected: boolean;
  recoveryApplied: boolean;
};

/** Fetch the onboarding row for `(orgId, userId)`, or `null` when absent. */
export async function getOnboardingProgress(
  orgId: string,
  userId: string,
): Promise<OnboardingProgressRow | null> {
  const rows = await db
    .select()
    .from(onboardingProgress)
    .where(and(eq(onboardingProgress.orgId, orgId), eq(onboardingProgress.userId, userId)));
  return rows[0] ?? null;
}

/**
 * Return the onboarding row for `(orgId, userId)`, creating it on first
 * access. Idempotent under concurrent first-reads: the insert uses
 * `ON CONFLICT (org_id, user_id) DO NOTHING`, then we re-select so the
 * caller always gets the canonical row (its own or the racing winner's).
 */
export async function ensureOnboardingRow(
  orgId: string,
  userId: string,
): Promise<OnboardingProgressRow> {
  await db
    .insert(onboardingProgress)
    .values({ id: crypto.randomUUID(), orgId, userId })
    .onConflictDoNothing({ target: [onboardingProgress.orgId, onboardingProgress.userId] });
  const row = await getOnboardingProgress(orgId, userId);
  if (!row) throw new Error("onboarding row missing immediately after ensure");
  return row;
}

/**
 * Advance the persisted high-water `step` to `targetStep` when (and only
 * when) it sits ahead of the current value. A no-op when the current step is
 * already at or beyond the target, so the write is monotonic and idempotent.
 * The row must already exist (call `ensureOnboardingRow` first).
 */
export async function advanceOnboardingHighWater(
  orgId: string,
  userId: string,
  targetStep: OnboardingStep,
): Promise<void> {
  const row = await getOnboardingProgress(orgId, userId);
  if (!row) return;
  const currentIndex = isOnboardingStep(row.step) ? stepIndex(row.step) : -1;
  if (stepIndex(targetStep) <= currentIndex) return;
  await db
    .update(onboardingProgress)
    .set({ step: targetStep, updatedAt: new Date() })
    .where(and(eq(onboardingProgress.orgId, orgId), eq(onboardingProgress.userId, userId)));
}

/**
 * Transition the row to `completed` exactly once, via CAS. Sets
 * `status='completed'`, `step='completed'`, and `completed_at` only when the
 * row is not already completed. Returns the updated row when this call won
 * the transition, or `null` when it was already completed (a concurrent read
 * won, or it was completed earlier). The caller MUST audit `onboarding.completed`
 * only on a non-null return so the audit can't double-fire under parallel reads.
 */
export async function completeOnboardingCas(
  orgId: string,
  userId: string,
): Promise<OnboardingProgressRow | null> {
  const now = new Date();
  const updated = await db
    .update(onboardingProgress)
    .set({ status: "completed", step: "completed", completedAt: now, updatedAt: now })
    .where(
      and(
        eq(onboardingProgress.orgId, orgId),
        eq(onboardingProgress.userId, userId),
        sql`${onboardingProgress.status} <> 'completed'`,
      ),
    )
    .returning();
  return updated[0] ?? null;
}

/**
 * Apply an operator skip/resume transition, via CAS. `skipped` is allowed
 * only from `active` (and stamps `skipped_at`); `active` (resume) is allowed
 * only from `skipped` (and clears `skipped_at`, preserving the high-water
 * `step`). Returns the updated row when the transition applied, or `null`
 * when the precondition wasn't met (e.g. already completed). The caller
 * audits only on a non-null return.
 */
export async function setOnboardingStatus(
  orgId: string,
  userId: string,
  target: "skipped" | "active",
): Promise<OnboardingProgressRow | null> {
  const now = new Date();
  const allowedPre = target === "skipped" ? "active" : "skipped";
  const patch =
    target === "skipped"
      ? { status: "skipped" as const, skippedAt: now, updatedAt: now }
      : { status: "active" as const, skippedAt: null, updatedAt: now };
  const updated = await db
    .update(onboardingProgress)
    .set(patch)
    .where(
      and(
        eq(onboardingProgress.orgId, orgId),
        eq(onboardingProgress.userId, userId),
        eq(onboardingProgress.status, allowedPre),
      ),
    )
    .returning();
  return updated[0] ?? null;
}

/**
 * Derive the five advanceable onboarding milestones from durable org-state.
 * Each is a bounded `SELECT … LIMIT 1` EXISTS run concurrently. All reads are
 * org-scoped. Counts ANY succeeded run regardless of `replayMode` so the
 * sample-run (validation) demo advances.
 *
 * When `since` is provided (the restart epoch), every signal is windowed to
 * rows with `created_at >= since` — so a restarted onboarding only counts
 * activity AFTER the restart and the operator can replay the whole flow on
 * the same tenant. `undefined` = no window (normal operation, all activity
 * counts).
 */
export async function resolveOnboardingMilestones(
  orgId: string,
  since?: Date,
): Promise<OnboardingMilestoneSignals> {
  /** Restart-epoch window conjunct: `created_at >= since`, or no-op when unset. */
  const w = (col: AnyColumn) => (since ? gte(col, since) : undefined);
  const [credentialRows, packRows, runRows, dlqRows, dlqRecoveredRows, recoveryItemRows] =
    await Promise.all([
      db
        .select({ id: credentials.id })
        .from(credentials)
        .where(and(eq(credentials.orgId, orgId), w(credentials.createdAt)))
        .limit(1),
      db
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.orgId, orgId),
            eq(auditLogs.action, "workflow.pack_imported"),
            w(auditLogs.createdAt),
          ),
        )
        .limit(1),
      db
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.orgId, orgId), eq(runs.status, "succeeded"), w(runs.createdAt)))
        .limit(1),
      db
        .select({ id: deadLetters.id })
        .from(deadLetters)
        .where(and(eq(deadLetters.orgId, orgId), w(deadLetters.createdAt)))
        .limit(1),
      db
        .select({ id: deadLetters.id })
        .from(deadLetters)
        .where(
          and(
            eq(deadLetters.orgId, orgId),
            inArray(deadLetters.status, ["replayed", "resolved"]),
            w(deadLetters.createdAt),
          ),
        )
        .limit(1),
      db
        .select({ id: recoveryItems.id })
        .from(recoveryItems)
        .where(
          and(eq(recoveryItems.orgId, orgId), eq(recoveryItems.status, "resolved"), w(recoveryItems.createdAt)),
        )
        .limit(1),
    ]);

  return {
    credentialConfigured: credentialRows.length > 0,
    packInstalled: packRows.length > 0,
    firstRunSucceeded: runRows.length > 0,
    failureInjected: dlqRows.length > 0,
    recoveryApplied: dlqRecoveredRows.length > 0 || recoveryItemRows.length > 0,
  };
}

/**
 * Restart onboarding for `(orgId, userId)` — replay the whole flow on the
 * same tenant. Unconditionally resets `status='active'`, `step='org_created'`,
 * clears skip/complete, and stamps the `restarted_at` epoch so milestone
 * derivation only counts activity AFTER this moment (so even a completed
 * onboarding shows the banner again from step one). Returns the updated row,
 * or `null` when no row exists (the caller ensures the row first).
 */
export async function restartOnboarding(
  orgId: string,
  userId: string,
): Promise<OnboardingProgressRow | null> {
  const now = new Date();
  const updated = await db
    .update(onboardingProgress)
    .set({
      status: "active",
      step: "org_created",
      restartedAt: now,
      skippedAt: null,
      completedAt: null,
      updatedAt: now,
    })
    .where(and(eq(onboardingProgress.orgId, orgId), eq(onboardingProgress.userId, userId)))
    .returning();
  return updated[0] ?? null;
}
