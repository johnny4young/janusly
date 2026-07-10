/**
 * Repository for `recovery_feedback` rows — the operator → system
 * feedback channel of the recovery loop.
 *
 * When an operator clicks Apply, Cancel, or Iterate in the Recovery
 * dialog, the dialog records a row here capturing what was suggested
 * (`approachLabel`, `suggestionMode`), what they decided (`accepted`),
 * and (optionally) why (`comment`). Future patch suggestions for the
 * SAME workflow read back an aggregated summary of these decisions
 * via `summarizePastFeedback`, which the patch route then threads
 * into the LLM prompt as `extraContext.pastFeedbackSummary` so the
 * model can deprioritize approaches the operator has already rejected
 * for this workflow shape.
 *
 * That's the closed loop: every recovery teaches the next one.
 *
 * Used by:
 * - `apps/api/src/routes/recovery-routes.ts:POST /recovery/feedback` —
 *   write path (called from `RecoveryDialog.tsx` on Apply / Cancel /
 *   Iterate).
 * - `apps/api/src/routes/ai-routes.ts:POST /ai/patch-workflow` — read path,
 *   via `summarizePastFeedback` → `composeFeedbackHint` →
 *   `extraContext.pastFeedbackSummary` injected into the LLM prompt.
 *
 * Invariants:
 * - Multi-tenant scope: every source-feedback and health-projection query
 *   carries its table's `eq(...orgId, orgId)` predicate. Both table families
 *   lead their read indexes with `org_id` so no feedback read spans tenants.
 * - `comment` is operator free-text. Secret-shape substrings
 *   (`Bearer sk-…`, `ghp_…`, JWTs, etc.) are scrubbed via
 *   `scrubSecretShapes` at write time, then truncated to
 *   `COMMENT_MAX_LENGTH` so a leaked secret never lands in the DB
 *   and a runaway-length comment can't bloat the row.
 * - `summarizePastFeedback` caps the scan at the configured `limit`
 *   so a noisy workflow (1000s of failed recoveries) can't blow the
 *   prompt budget when the patch route enriches its prompt.
 */

import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import { db, recoveryFeedback, recoveryFeedbackHealth } from "@janusly/db";
import { scrubSecretShapes } from "@janusly/shared/src/error-signature";

/** Default scan window for `summarizePastFeedback` — older feedback is unlikely to be relevant. */
export const DEFAULT_FEEDBACK_WINDOW_DAYS = 30;

/** Default cap on rows scanned by `summarizePastFeedback` before grouping. */
export const DEFAULT_FEEDBACK_SCAN_LIMIT = 100;

/**
 * A recovery workflow's feedback becomes stale when no accepted fix has
 * arrived within this many days. It intentionally matches the prompt's
 * feedback window: once the prompt stops receiving a labeled signal, the
 * operator should be able to see that the learning loop is no longer fresh.
 */
export const DEFAULT_FEEDBACK_HEALTH_WINDOW_DAYS = DEFAULT_FEEDBACK_WINDOW_DAYS;

/** The closed approach vocabulary currently has six entries; keep the health read bounded defensively. */
const FEEDBACK_HEALTH_APPROACH_CAP = 20;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Hard cap on comment length post-redaction. The route's Zod schema enforces a 2000-char input cap; this is the belt-and-braces ceiling at write time. */
const COMMENT_MAX_LENGTH = 2000;

/** Closed enum mirrored from `apps/api/src/ai-schemas.ts` patch envelopes. */
export type RecoveryApproachLabel =
  | "add_retry"
  | "raise_timeout"
  | "swap_secret_ref"
  | "add_approval"
  | "fix_url"
  | "other";

export type RecoveryFeedbackInput = {
  orgId: string;
  userId: string | null;
  deadLetterId: string;
  workflowId: string;
  suggestionMode: "ai" | "fallback";
  approachLabel: RecoveryApproachLabel;
  accepted: boolean;
  comment: string | null;
  /**
   * Operator opt-in to reuse this decision as eval-dataset training
   * material. Default `false` — a row is NEVER eligible for an eval
   * example unless the operator explicitly consents. The dataset-build
   * query filters `accepted = true AND eval_consent = true`.
   */
  evalConsent?: boolean;
  /**
   * The model's raw self-rated confidence (0-100) for the decided-on
   * suggestion. Nullable — headless callers (MCP, CI) and rows written
   * before the column landed omit it. The daily confidence-calibration
   * sweep buckets only rows where this is non-null, so a missing value
   * silently drops out of the curve fit rather than skewing it toward 0.
   */
  rawConfidence?: number | null;
};

/**
 * Persist a single operator decision row. Multi-tenant scope baked in:
 * every column comes from the validated input. The free-text `comment`
 * is scrubbed for known secret-shape substrings (`Bearer sk-…`,
 * `ghp_…`, JWTs) and truncated to `COMMENT_MAX_LENGTH` so a leaked
 * secret never lands in the DB and a runaway comment can't bloat the
 * row. Returns only after the insert completes; `POST
 * /recovery/feedback` awaits this before responding `{ ok: true }` so
 * successful route responses mean the decision row exists.
 */
export async function recordRecoveryFeedback(input: RecoveryFeedbackInput): Promise<void> {
  let safeComment: string | null = null;
  if (input.comment != null && input.comment.length > 0) {
    const scrubbed = scrubSecretShapes(input.comment);
    safeComment = scrubbed.length > COMMENT_MAX_LENGTH ? scrubbed.slice(0, COMMENT_MAX_LENGTH) : scrubbed;
  }

  const recordedAt = new Date();
  await db.transaction(async (tx) => {
    await tx.insert(recoveryFeedback).values({
      id: crypto.randomUUID(),
      orgId: input.orgId,
      userId: input.userId,
      deadLetterId: input.deadLetterId,
      workflowId: input.workflowId,
      suggestionMode: input.suggestionMode,
      approachLabel: input.approachLabel,
      accepted: input.accepted,
      comment: safeComment,
      evalConsent: input.evalConsent ?? false,
      rawConfidence: input.rawConfidence ?? null,
      createdAt: recordedAt,
    });
    // Keep the compact freshness projection in the SAME transaction as the
    // source decision. A rejection advances `feedbackLastSeen` but leaves a
    // prior accepted fix intact; an accepted decision refreshes both clocks.
    // The conflict update uses the greater timestamp so a later-committing,
    // older concurrent request cannot make either freshness clock regress.
    await tx
      .insert(recoveryFeedbackHealth)
      .values({
        id: crypto.randomUUID(),
        orgId: input.orgId,
        workflowId: input.workflowId,
        approachLabel: input.approachLabel,
        feedbackLastSeen: recordedAt,
        acceptedFixLastSeen: input.accepted ? recordedAt : null,
      })
      .onConflictDoUpdate({
        target: [
          recoveryFeedbackHealth.orgId,
          recoveryFeedbackHealth.workflowId,
          recoveryFeedbackHealth.approachLabel,
        ],
        set: {
          feedbackLastSeen: sql`GREATEST(EXCLUDED.feedback_last_seen, ${recoveryFeedbackHealth.feedbackLastSeen})`,
          ...(input.accepted
            ? {
                acceptedFixLastSeen: sql`COALESCE(
                  GREATEST(EXCLUDED.accepted_fix_last_seen, ${recoveryFeedbackHealth.acceptedFixLastSeen}),
                  EXCLUDED.accepted_fix_last_seen
                )`,
              }
            : {}),
        },
      });
  });
}

/**
 * Per-`approachLabel` aggregation the patch route reads on every
 * recovery to enrich the LLM prompt. Includes up to 3 most-recent
 * rejection comments per approach so the LLM can see why the
 * operator pushed back, not just that they did.
 */
export type FeedbackSummary = {
  approachLabel: RecoveryApproachLabel;
  acceptedCount: number;
  rejectedCount: number;
  /** Latest 3 non-null rejection comments for this approach, newest first. */
  rejectionComments: string[];
};

/** The operator-visible freshness state for one workflow + recovery approach. */
export type FeedbackHealthState = "active" | "stale" | "no_accepted_fix";

/**
 * Latest labeled feedback for one approach. `feedbackLastSeen` includes
 * accept and reject decisions because both steer future prompts; the separate
 * accepted-fix fields make it explicit when no accepted fix has refreshed the
 * durable learning signal.
 */
export type FeedbackApproachHealth = {
  approachLabel: RecoveryApproachLabel;
  feedbackLastSeen: Date;
  acceptedFixLastSeen: Date | null;
  acceptedFixAgeDays: number | null;
  state: FeedbackHealthState;
};

/** Read-only envelope shared by the patch response and recovery-health route. */
export type RecoveryFeedbackHealthSnapshot = {
  windowDays: number;
  approaches: FeedbackApproachHealth[];
};

type FeedbackHealthRow = {
  approachLabel: string;
  feedbackLastSeen: Date | null;
  acceptedFixLastSeen: Date | null;
};

/**
 * Shape durable feedback-health rows into the stable, locale-neutral health
 * envelope the API exposes. Exported as pure logic so the stale boundary is
 * regression-tested without a database clock.
 */
export function buildRecoveryFeedbackHealth(
  rows: FeedbackHealthRow[],
  options: { now?: Date; windowDays?: number } = {},
): RecoveryFeedbackHealthSnapshot {
  const now = options.now ?? new Date();
  const windowDays = options.windowDays ?? DEFAULT_FEEDBACK_HEALTH_WINDOW_DAYS;
  const nowMs = now.getTime();
  const approaches: FeedbackApproachHealth[] = [];

  for (const row of rows) {
    if (!(row.feedbackLastSeen instanceof Date) || Number.isNaN(row.feedbackLastSeen.getTime())) continue;
    const acceptedFixAgeDays = row.acceptedFixLastSeen instanceof Date && !Number.isNaN(row.acceptedFixLastSeen.getTime())
      ? Math.max(0, Math.floor((nowMs - row.acceptedFixLastSeen.getTime()) / MS_PER_DAY))
      : null;
    const state: FeedbackHealthState = acceptedFixAgeDays === null
      ? "no_accepted_fix"
      : acceptedFixAgeDays < windowDays
        ? "active"
        : "stale";
    approaches.push({
      approachLabel: row.approachLabel as RecoveryApproachLabel,
      feedbackLastSeen: row.feedbackLastSeen,
      acceptedFixLastSeen: row.acceptedFixLastSeen,
      acceptedFixAgeDays,
      state,
    });
  }

  return { windowDays, approaches };
}

/**
 * Aggregate the last `windowDays` of feedback for one workflow into a
 * per-approach summary. Returns an empty array for first-time recoveries
 * (no rows match) so the prompt stays unchanged in the cold-start case.
 *
 * Caps the scan at `limit` rows. With a 30-day window and a noisy
 * workflow, this still produces a representative summary while keeping
 * the read cheap and the prompt budget bounded.
 */
export async function summarizePastFeedback(
  orgId: string,
  workflowId: string,
  windowDays: number = DEFAULT_FEEDBACK_WINDOW_DAYS,
  limit: number = DEFAULT_FEEDBACK_SCAN_LIMIT,
): Promise<FeedbackSummary[]> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const rows = await db
    .select({
      approachLabel: recoveryFeedback.approachLabel,
      accepted: recoveryFeedback.accepted,
      comment: recoveryFeedback.comment,
    })
    .from(recoveryFeedback)
    .where(and(
      eq(recoveryFeedback.orgId, orgId),
      eq(recoveryFeedback.workflowId, workflowId),
      gte(recoveryFeedback.createdAt, since),
    ))
    .orderBy(desc(recoveryFeedback.createdAt))
    .limit(limit);

  // Group by approachLabel in JS — Postgres-side GROUP BY would lose the
  // newest-first comment order without a window function, and the row
  // count is small (capped at `limit`).
  const buckets = new Map<RecoveryApproachLabel, FeedbackSummary>();
  for (const row of rows) {
    const label = row.approachLabel as RecoveryApproachLabel;
    let bucket = buckets.get(label);
    if (!bucket) {
      bucket = {
        approachLabel: label,
        acceptedCount: 0,
        rejectedCount: 0,
        rejectionComments: [],
      };
      buckets.set(label, bucket);
    }
    if (row.accepted) {
      bucket.acceptedCount += 1;
    } else {
      bucket.rejectedCount += 1;
      if (typeof row.comment === "string" && row.comment.length > 0 && bucket.rejectionComments.length < 3) {
        bucket.rejectionComments.push(row.comment);
      }
    }
  }
  return Array.from(buckets.values());
}

/**
 * Return the durable freshness projection per `(orgId, workflowId,
 * approachLabel)` without exposing feedback comments. The tracker survives
 * retention of source feedback rows, so a stale workflow never masquerades
 * as a first-time workflow after its prompt window expires.
 */
export async function queryRecoveryFeedbackHealth(
  orgId: string,
  workflowId: string,
  options: { now?: Date; windowDays?: number } = {},
): Promise<RecoveryFeedbackHealthSnapshot> {
  const rows = await db
    .select({
      approachLabel: recoveryFeedbackHealth.approachLabel,
      feedbackLastSeen: recoveryFeedbackHealth.feedbackLastSeen,
      acceptedFixLastSeen: recoveryFeedbackHealth.acceptedFixLastSeen,
    })
    .from(recoveryFeedbackHealth)
    .where(and(
      eq(recoveryFeedbackHealth.orgId, orgId),
      eq(recoveryFeedbackHealth.workflowId, workflowId),
    ))
    .orderBy(asc(recoveryFeedbackHealth.approachLabel))
    .limit(FEEDBACK_HEALTH_APPROACH_CAP);

  return buildRecoveryFeedbackHealth(rows, options);
}

// Multi-tenant invariant: tenant-scoped reads and writes keep orgId in the predicate; document system/global exceptions - see AGENTS.md "AuthContext is Janusly-resolved".
