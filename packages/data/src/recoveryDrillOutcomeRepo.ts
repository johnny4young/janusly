/**
 * Measured outcome projection for code-authored recovery drills.
 *
 * Used by `apps/api/src/routes/dlq-routes.ts` to enrich the legacy DLQ detail
 * read after the route has verified the row carries drill provenance.
 *
 * Invariants:
 * - A replay claim or `dead_letters.status='replayed'` is never recovery.
 * - Only an immutable `recovery_impact_events` row proves terminal recovery.
 * - Explicit accepted loss comes from recovery-item resolution, with the
 *   append-only `dlq.resolved` audit as a fallback when item auto-creation is
 *   disabled.
 * - Recurrence matches the existing seven-day, production-only signature
 *   semantics used by `queryRecoveryRecurrence`.
 * - The same-run/node replay chain is capped so one detail read cannot become
 *   an unbounded historical scan.
 */

import { db } from "@janusly/db";
import { sql } from "drizzle-orm";

const REPLAY_CHAIN_LIMIT = 100;
const RECURRENCE_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

export type RecoveryDrillOutcomeStatus =
  | "awaiting_action"
  | "replay_in_progress"
  | "recovered"
  | "accepted_loss"
  | "measurement_incomplete";

export type RecoveryDrillRecurrenceStatus =
  | "not_applicable"
  | "monitoring"
  | "clear"
  | "recurred";

/** Locale-neutral facts returned to the web on a drill DLQ detail read. */
export type RecoveryDrillOutcome = {
  status: RecoveryDrillOutcomeStatus;
  startedAt: string | null;
  completedAt: string | null;
  elapsedMs: number | null;
  evidence: "terminal_impact" | "explicit_resolution" | null;
  attemptCount: number;
  latestDeadLetterId: string;
  chainCapped: boolean;
  recurrence: {
    status: RecoveryDrillRecurrenceStatus;
    windowEndsAt: string | null;
    recurredAt: string | null;
  };
};

/** Database facts kept separate so outcome precedence is pure-unit testable. */
export type RecoveryDrillOutcomeFacts = {
  rootCreatedAt: Date | null;
  rootStatus: string;
  latestDeadLetterId: string;
  latestStatus: string;
  attemptCount: number;
  chainCapped: boolean;
  replayStartedAt: Date | null;
  recoveredAt: Date | null;
  acceptedItemAt: Date | null;
  acceptedAuditAt: Date | null;
  recurredAt: Date | null;
};

function boundedElapsedMs(startedAt: Date | null, completedAt: Date | null): number | null {
  if (!startedAt || !completedAt) return null;
  return Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.max(0, completedAt.getTime() - startedAt.getTime()),
  );
}

function earliestDate(left: Date | null, right: Date | null): Date | null {
  if (!left) return right;
  if (!right) return left;
  return left <= right ? left : right;
}

/** Compose truthful status, duration, and recurrence from durable facts. */
export function buildRecoveryDrillOutcome(
  facts: RecoveryDrillOutcomeFacts,
  now = new Date(),
): RecoveryDrillOutcome {
  const acceptedAt = earliestDate(facts.acceptedItemAt, facts.acceptedAuditAt);
  const recovered = Boolean(facts.recoveredAt);
  const accepted = !recovered && (
    Boolean(facts.acceptedItemAt)
    || (Boolean(facts.acceptedAuditAt) && facts.latestStatus !== "open")
    || facts.latestStatus === "resolved"
  );
  const completedAt = facts.chainCapped
    ? null
    : recovered
      ? facts.recoveredAt
      : accepted
        ? acceptedAt
        : null;
  const status: RecoveryDrillOutcomeStatus = facts.chainCapped
    ? "measurement_incomplete"
    : recovered
      ? "recovered"
      : accepted
        ? "accepted_loss"
        : facts.latestStatus === "open"
          ? "awaiting_action"
          : facts.replayStartedAt
            ? "replay_in_progress"
            : "awaiting_action";

  let recurrence: RecoveryDrillOutcome["recurrence"] = {
    status: "not_applicable",
    windowEndsAt: null,
    recurredAt: null,
  };
  if (facts.recoveredAt && !facts.chainCapped) {
    const windowEndsAt = new Date(facts.recoveredAt.getTime() + RECURRENCE_WINDOW_MS);
    recurrence = facts.recurredAt
      ? {
          status: "recurred",
          windowEndsAt: windowEndsAt.toISOString(),
          recurredAt: facts.recurredAt.toISOString(),
        }
      : {
          status: now >= windowEndsAt ? "clear" : "monitoring",
          windowEndsAt: windowEndsAt.toISOString(),
          recurredAt: null,
        };
  }

  const attemptCount = Number.isFinite(facts.attemptCount)
    ? Math.max(1, Math.min(REPLAY_CHAIN_LIMIT, Math.floor(facts.attemptCount)))
    : 1;
  return {
    status,
    startedAt: facts.rootCreatedAt?.toISOString() ?? null,
    completedAt: completedAt?.toISOString() ?? null,
    elapsedMs: boundedElapsedMs(facts.rootCreatedAt, completedAt),
    evidence: facts.chainCapped
      ? null
      : recovered
        ? "terminal_impact"
        : accepted
          ? "explicit_resolution"
          : null,
    attemptCount,
    latestDeadLetterId: facts.latestDeadLetterId,
    chainCapped: facts.chainCapped,
    recurrence,
  };
}

type OutcomeRow = {
  root_created_at: Date | string | null;
  root_status: string;
  latest_dead_letter_id: string;
  latest_status: string;
  attempt_count: number | string;
  chain_capped: boolean;
  replay_started_at: Date | string | null;
  recovered_at: Date | string | null;
  accepted_item_at: Date | string | null;
  accepted_audit_at: Date | string | null;
  recurred_at: Date | string | null;
};

function asDate(value: Date | string | null): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Query one drill's complete same-run/node recovery chain. Returns `null` for
 * an absent or cross-tenant root; callers attach it only after provenance is
 * established. Every CTE remains rooted in the caller's `orgId`.
 */
export async function queryRecoveryDrillOutcome(
  orgId: string,
  deadLetterId: string,
  now = new Date(),
): Promise<RecoveryDrillOutcome | null> {
  const rows = await db.execute<OutcomeRow>(sql`
    WITH root AS (
      SELECT
        "id",
        "org_id",
        "run_id",
        "node_id",
        "status",
        "created_at"
      FROM "dead_letters"
      WHERE "org_id" = ${orgId}
        AND "id" = ${deadLetterId}
      LIMIT 1
    ), chain_scan AS MATERIALIZED (
      SELECT
        dl."id",
        dl."status",
        dl."created_at",
        coalesce(dl."replay_claimed_at", dl."replayed_at") AS replay_started_at,
        impact."recovered_at"
      FROM root
      INNER JOIN "dead_letters" dl
        ON dl."org_id" = root."org_id"
       AND dl."run_id" = root."run_id"
       AND dl."node_id" = root."node_id"
       AND (
         dl."id" = root."id"
         OR (
           root."created_at" IS NOT NULL
           AND dl."created_at" >= root."created_at"
         )
       )
      LEFT JOIN "recovery_impact_events" impact
        ON impact."org_id" = root."org_id"
       AND impact."dead_letter_id" = dl."id"
      ORDER BY dl."created_at" ASC NULLS FIRST, dl."id" ASC
      LIMIT ${REPLAY_CHAIN_LIMIT + 1}
    ), chain AS MATERIALIZED (
      SELECT *
      FROM chain_scan
      ORDER BY "created_at" ASC NULLS FIRST, "id" ASC
      LIMIT ${REPLAY_CHAIN_LIMIT}
    ), latest AS (
      SELECT "id", "status"
      FROM chain
      ORDER BY "created_at" DESC NULLS LAST, "id" DESC
      LIMIT 1
    ), recovered AS (
      SELECT "recovered_at"
      FROM chain
      WHERE "recovered_at" IS NOT NULL
      ORDER BY "recovered_at" ASC
      LIMIT 1
    ), accepted_item AS (
      SELECT min(item."resolved_at") AS accepted_at
      FROM "recovery_items" item
      WHERE item."org_id" = ${orgId}
        AND item."resolution_reason" = 'accepted_loss'
        AND item."resolved_at" IS NOT NULL
        AND (
          item."dead_letter_id" IN (SELECT "id" FROM chain)
          OR EXISTS (
            SELECT 1
            FROM "recovery_item_children" child
            WHERE child."org_id" = item."org_id"
              AND child."recovery_item_id" = item."id"
              AND child."dead_letter_id" IN (SELECT "id" FROM chain)
          )
        )
    ), accepted_audit AS (
      SELECT min(audit."created_at") AS accepted_at
      FROM "audit_logs" audit
      WHERE audit."org_id" = ${orgId}
        AND audit."action" = 'dlq.resolved'
        AND audit."target_type" = 'dlq'
        AND audit."target_id" IN (SELECT "id" FROM chain)
    ), root_item AS (
      SELECT item."id", item."error_signature"
      FROM "recovery_items" item
      WHERE item."org_id" = ${orgId}
        AND item."error_signature" IS NOT NULL
        AND (
          item."dead_letter_id" IN (SELECT "id" FROM chain)
          OR EXISTS (
            SELECT 1
            FROM "recovery_item_children" child
            WHERE child."org_id" = item."org_id"
              AND child."recovery_item_id" = item."id"
              AND child."dead_letter_id" IN (SELECT "id" FROM chain)
          )
        )
      ORDER BY item."created_at" ASC NULLS LAST, item."id" ASC
      LIMIT 1
    ), recurrence AS (
      SELECT min(candidate_at) AS recurred_at
      FROM (
        SELECT later_item."first_occurred_at" AS candidate_at
        FROM root_item
        CROSS JOIN recovered
        INNER JOIN "recovery_items" later_item
          ON later_item."org_id" = ${orgId}
         AND later_item."id" <> root_item."id"
         AND later_item."error_signature" = root_item."error_signature"
        INNER JOIN "dead_letters" later_dlq
          ON later_dlq."org_id" = later_item."org_id"
         AND later_dlq."id" = later_item."dead_letter_id"
        INNER JOIN "runs" later_run
          ON later_run."org_id" = later_item."org_id"
         AND later_run."id" = later_dlq."run_id"
        WHERE later_item."first_occurred_at" > recovered."recovered_at"
          AND later_item."first_occurred_at" <= recovered."recovered_at" + interval '7 days'
          AND later_run."replay_mode" IS NULL

        UNION ALL

        SELECT child."occurred_at" AS candidate_at
        FROM root_item
        CROSS JOIN recovered
        INNER JOIN "recovery_item_children" child
          ON child."org_id" = ${orgId}
         AND child."recovery_item_id" = root_item."id"
        INNER JOIN "dead_letters" child_dlq
          ON child_dlq."org_id" = child."org_id"
         AND child_dlq."id" = child."dead_letter_id"
        INNER JOIN "runs" child_run
          ON child_run."org_id" = child."org_id"
         AND child_run."id" = child_dlq."run_id"
        WHERE child."occurred_at" > recovered."recovered_at"
          AND child."occurred_at" <= recovered."recovered_at" + interval '7 days'
          AND child_run."replay_mode" IS NULL
      ) candidates
    )
    SELECT
      root."created_at" AS root_created_at,
      root."status" AS root_status,
      latest."id" AS latest_dead_letter_id,
      latest."status" AS latest_status,
      (SELECT count(*)::int FROM chain) AS attempt_count,
      (SELECT count(*) > ${REPLAY_CHAIN_LIMIT} FROM chain_scan) AS chain_capped,
      (SELECT min(replay_started_at) FROM chain) AS replay_started_at,
      recovered."recovered_at" AS recovered_at,
      accepted_item.accepted_at AS accepted_item_at,
      accepted_audit.accepted_at AS accepted_audit_at,
      recurrence.recurred_at AS recurred_at
    FROM root
    INNER JOIN latest ON true
    LEFT JOIN recovered ON true
    LEFT JOIN accepted_item ON true
    LEFT JOIN accepted_audit ON true
    LEFT JOIN recurrence ON true
  `);

  const row = rows[0];
  if (!row) return null;
  return buildRecoveryDrillOutcome({
    rootCreatedAt: asDate(row.root_created_at),
    rootStatus: row.root_status,
    latestDeadLetterId: row.latest_dead_letter_id,
    latestStatus: row.latest_status,
    attemptCount: Number(row.attempt_count),
    chainCapped: Boolean(row.chain_capped),
    replayStartedAt: asDate(row.replay_started_at),
    recoveredAt: asDate(row.recovered_at),
    acceptedItemAt: asDate(row.accepted_item_at),
    acceptedAuditAt: asDate(row.accepted_audit_at),
    recurredAt: asDate(row.recurred_at),
  }, now);
}
