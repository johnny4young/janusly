/**
 * Bounded, organization-scoped evidence report for controlled recovery drills.
 *
 * Used by:
 * - `apps/api/src/routes/recovery-routes.ts` for the in-product summary.
 * - `apps/api/src/routes/reports-routes.ts` for Markdown/JSON evidence exports.
 *
 * Invariants:
 * - Only server-authored `solution_pack_drill` runs enter the report.
 * - Terminal impact remains the only recovery proof; replay enqueue is never a win.
 * - Accepted loss is explicit and excluded from recovered outcomes.
 * - The run sample and every same-run/node replay chain are independently capped.
 * - Actor identifiers never leave this repository; callers receive only a closed
 *   operator/automated/unknown classification.
 */

import { db } from "@janusly/db";
import { sql } from "drizzle-orm";

import {
  buildRecoveryDrillOutcome,
  RECOVERY_DRILL_REPLAY_CHAIN_LIMIT,
  type RecoveryDrillOutcome,
  type RecoveryDrillOutcomeFacts,
} from "./recoveryDrillOutcomeRepo";

const VALIDATION_SAMPLE_LIMIT = 100;

export type RecoveryValidationResolutionMode = "operator" | "automated" | "unknown";

export type RecoveryValidationSample = {
  runId: string;
  runCreatedAt: string;
  packId: string;
  fixtureId: string;
  failureMode: string;
  recoveryPath: string;
  resolutionMode: RecoveryValidationResolutionMode;
  outcome: RecoveryDrillOutcome | null;
};

export type RecoveryValidationBreakdown = {
  key: string;
  total: number;
  completed: number;
  recovered: number;
  acceptedLoss: number;
  recoveryRatePercent: number | null;
};

export type RecoveryValidationReport = {
  generatedAt: string;
  windowDays: number;
  sampleLimit: number;
  sampleCapped: boolean;
  totals: {
    drills: number;
    completed: number;
    recovered: number;
    acceptedLoss: number;
    awaitingAction: number;
    replayInProgress: number;
    measurementIncomplete: number;
    missingEvidence: number;
    completionRatePercent: number | null;
    recoveryRatePercent: number | null;
  };
  resolution: {
    operator: number;
    automated: number;
    unknown: number;
    operatorInterventionRatePercent: number | null;
  };
  timing: {
    medianElapsedMs: number | null;
    p90ElapsedMs: number | null;
    averageElapsedMs: number | null;
    p95ElapsedMs: number | null;
    sampleSize: number;
  };
  byFailureMode: RecoveryValidationBreakdown[];
  byRecoveryPath: RecoveryValidationBreakdown[];
  samples: RecoveryValidationSample[];
};

type ValidationRow = {
  run_id: string;
  run_created_at: Date | string;
  pack_id: string;
  fixture_id: string;
  failure_mode: string;
  recovery_path: string;
  sample_capped: boolean;
  root_dead_letter_id: string | null;
  root_created_at: Date | string | null;
  root_status: string | null;
  latest_dead_letter_id: string | null;
  latest_status: string | null;
  attempt_count: number | string | null;
  chain_capped: boolean | null;
  replay_started_at: Date | string | null;
  recovered_at: Date | string | null;
  recovered_by: string | null;
  accepted_item_at: Date | string | null;
  accepted_item_by: string | null;
  accepted_audit_at: Date | string | null;
  accepted_audit_by: string | null;
  recurred_at: Date | string | null;
};

function asDate(value: Date | string | null): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function roundPercent(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1_000) / 10;
}

function discretePercentile(sortedValues: number[], percentile: number): number | null {
  if (sortedValues.length === 0) return null;
  const index = Math.max(0, Math.ceil(sortedValues.length * percentile) - 1);
  return sortedValues[index] ?? null;
}

function median(sortedValues: number[]): number | null {
  if (sortedValues.length === 0) return null;
  const middle = Math.floor(sortedValues.length / 2);
  if (sortedValues.length % 2 === 1) return sortedValues[middle] ?? null;
  return Math.round(((sortedValues[middle - 1] ?? 0) + (sortedValues[middle] ?? 0)) / 2);
}

function resolutionMode(userId: string | null): RecoveryValidationResolutionMode {
  if (!userId) return "unknown";
  return userId === "system" || userId.startsWith("system:") ? "automated" : "operator";
}

function acceptedActor(row: ValidationRow): string | null {
  const itemAt = asDate(row.accepted_item_at);
  const auditAt = asDate(row.accepted_audit_at);
  if (!itemAt) return row.accepted_audit_by;
  if (!auditAt) return row.accepted_item_by;
  return itemAt <= auditAt ? row.accepted_item_by : row.accepted_audit_by;
}

function buildBreakdown(
  samples: RecoveryValidationSample[],
  readKey: (sample: RecoveryValidationSample) => string,
): RecoveryValidationBreakdown[] {
  const groups = new Map<string, RecoveryValidationBreakdown>();
  for (const sample of samples) {
    const key = readKey(sample);
    const current = groups.get(key) ?? {
      key,
      total: 0,
      completed: 0,
      recovered: 0,
      acceptedLoss: 0,
      recoveryRatePercent: null,
    };
    current.total += 1;
    if (sample.outcome?.status === "recovered") {
      current.completed += 1;
      current.recovered += 1;
    } else if (sample.outcome?.status === "accepted_loss") {
      current.completed += 1;
      current.acceptedLoss += 1;
    }
    groups.set(key, current);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      recoveryRatePercent: roundPercent(group.recovered, group.completed),
    }))
    .sort((left, right) => right.total - left.total || left.key.localeCompare(right.key));
}

/** Compose aggregate validation evidence from bounded locale-neutral samples. */
export function buildRecoveryValidationReport(args: {
  samples: RecoveryValidationSample[];
  windowDays: number;
  generatedAt?: Date;
  sampleCapped?: boolean;
}): RecoveryValidationReport {
  const generatedAt = args.generatedAt ?? new Date();
  const samples = args.samples.slice(0, VALIDATION_SAMPLE_LIMIT);
  const statuses = {
    recovered: 0,
    acceptedLoss: 0,
    awaitingAction: 0,
    replayInProgress: 0,
    measurementIncomplete: 0,
    missingEvidence: 0,
  };
  const resolution = { operator: 0, automated: 0, unknown: 0 };
  const elapsedSamples: number[] = [];

  for (const sample of samples) {
    const status = sample.outcome?.status;
    if (!status) statuses.missingEvidence += 1;
    else if (status === "recovered") statuses.recovered += 1;
    else if (status === "accepted_loss") statuses.acceptedLoss += 1;
    else if (status === "awaiting_action") statuses.awaitingAction += 1;
    else if (status === "replay_in_progress") statuses.replayInProgress += 1;
    else statuses.measurementIncomplete += 1;

    if (status === "recovered" || status === "accepted_loss") {
      resolution[sample.resolutionMode] += 1;
    }
    if (
      status === "recovered"
      && sample.outcome?.elapsedMs != null
      && Number.isFinite(sample.outcome.elapsedMs)
    ) {
      elapsedSamples.push(Math.max(0, sample.outcome.elapsedMs));
    }
  }

  elapsedSamples.sort((left, right) => left - right);
  const completed = statuses.recovered + statuses.acceptedLoss;
  const knownResolution = resolution.operator + resolution.automated;
  const averageElapsedMs = elapsedSamples.length > 0
    ? Math.round(elapsedSamples.reduce((sum, value) => sum + value, 0) / elapsedSamples.length)
    : null;

  return {
    generatedAt: generatedAt.toISOString(),
    windowDays: Math.min(90, Math.max(1, Math.floor(args.windowDays))),
    sampleLimit: VALIDATION_SAMPLE_LIMIT,
    sampleCapped: Boolean(args.sampleCapped) || args.samples.length > VALIDATION_SAMPLE_LIMIT,
    totals: {
      drills: samples.length,
      completed,
      recovered: statuses.recovered,
      acceptedLoss: statuses.acceptedLoss,
      awaitingAction: statuses.awaitingAction,
      replayInProgress: statuses.replayInProgress,
      measurementIncomplete: statuses.measurementIncomplete,
      missingEvidence: statuses.missingEvidence,
      completionRatePercent: roundPercent(completed, samples.length),
      recoveryRatePercent: roundPercent(statuses.recovered, completed),
    },
    resolution: {
      ...resolution,
      operatorInterventionRatePercent: roundPercent(resolution.operator, knownResolution),
    },
    timing: {
      medianElapsedMs: median(elapsedSamples),
      p90ElapsedMs: discretePercentile(elapsedSamples, 0.9),
      averageElapsedMs,
      p95ElapsedMs: discretePercentile(elapsedSamples, 0.95),
      sampleSize: elapsedSamples.length,
    },
    byFailureMode: buildBreakdown(samples, (sample) => sample.failureMode),
    byRecoveryPath: buildBreakdown(samples, (sample) => sample.recoveryPath),
    samples,
  };
}

/**
 * Query the newest controlled drills in one bounded database round trip.
 * PostgreSQL evaluates each replay-chain projection through a lateral join,
 * avoiding an API-level N+1 while retaining the per-root chain cap.
 */
export async function queryRecoveryValidation(
  orgId: string,
  requestedWindowDays = 30,
  now = new Date(),
): Promise<RecoveryValidationReport> {
  const windowDays = Math.min(90, Math.max(1, Math.floor(requestedWindowDays)));
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1_000);
  const rows = await db.execute<ValidationRow>(sql`
    WITH drill_scan AS MATERIALIZED (
      SELECT
        run."id" AS run_id,
        run."created_at" AS run_created_at,
        left(run."input_json"->'drill'->>'packId', 120) AS pack_id,
        left(run."input_json"->'drill'->>'fixtureId', 120) AS fixture_id,
        left(run."input_json"->'drill'->>'failureMode', 120) AS failure_mode,
        left(run."input_json"->'drill'->>'recoveryPath', 120) AS recovery_path
      FROM "runs" run
      WHERE run."org_id" = ${orgId}
        AND run."created_at" >= ${since.toISOString()}::timestamptz
        AND run."input_json"->'drill'->>'kind' = 'solution_pack_drill'
        AND nullif(run."input_json"->'drill'->>'packId', '') IS NOT NULL
        AND nullif(run."input_json"->'drill'->>'fixtureId', '') IS NOT NULL
        AND nullif(run."input_json"->'drill'->>'failureMode', '') IS NOT NULL
        AND nullif(run."input_json"->'drill'->>'recoveryPath', '') IS NOT NULL
      ORDER BY run."created_at" DESC, run."id" DESC
      LIMIT ${VALIDATION_SAMPLE_LIMIT + 1}
    ), drill_runs AS MATERIALIZED (
      SELECT *
      FROM drill_scan
      ORDER BY run_created_at DESC, run_id DESC
      LIMIT ${VALIDATION_SAMPLE_LIMIT}
    )
    SELECT
      drill.run_id,
      drill.run_created_at,
      drill.pack_id,
      drill.fixture_id,
      drill.failure_mode,
      drill.recovery_path,
      (SELECT count(*) > ${VALIDATION_SAMPLE_LIMIT} FROM drill_scan) AS sample_capped,
      root.id AS root_dead_letter_id,
      root.created_at AS root_created_at,
      root.status AS root_status,
      facts.latest_dead_letter_id,
      facts.latest_status,
      facts.attempt_count,
      facts.chain_capped,
      facts.replay_started_at,
      facts.recovered_at,
      facts.recovered_by,
      facts.accepted_item_at,
      facts.accepted_item_by,
      facts.accepted_audit_at,
      facts.accepted_audit_by,
      facts.recurred_at
    FROM drill_runs drill
    LEFT JOIN LATERAL (
      SELECT dl."id", dl."created_at", dl."status", dl."node_id"
      FROM "dead_letters" dl
      WHERE dl."org_id" = ${orgId}
        AND dl."run_id" = drill.run_id
      ORDER BY dl."created_at" ASC NULLS FIRST, dl."id" ASC
      LIMIT 1
    ) root ON true
    LEFT JOIN LATERAL (
      WITH chain_scan AS MATERIALIZED (
        SELECT
          dl."id",
          dl."status",
          dl."created_at",
          coalesce(dl."replay_claimed_at", dl."replayed_at") AS replay_started_at,
          impact."recovered_at",
          impact."user_id" AS recovered_by
        FROM "dead_letters" dl
        LEFT JOIN "recovery_impact_events" impact
          ON impact."org_id" = ${orgId}
         AND impact."dead_letter_id" = dl."id"
        WHERE dl."org_id" = ${orgId}
          AND dl."run_id" = drill.run_id
          AND dl."node_id" = root.node_id
          AND (
            dl."id" = root.id
            OR (
              root.created_at IS NOT NULL
              AND dl."created_at" >= root.created_at
            )
          )
        ORDER BY dl."created_at" ASC NULLS FIRST, dl."id" ASC
        LIMIT ${RECOVERY_DRILL_REPLAY_CHAIN_LIMIT + 1}
      ), chain AS MATERIALIZED (
        SELECT *
        FROM chain_scan
        ORDER BY created_at ASC NULLS FIRST, id ASC
        LIMIT ${RECOVERY_DRILL_REPLAY_CHAIN_LIMIT}
      ), latest AS (
        SELECT id, status
        FROM chain
        ORDER BY created_at DESC NULLS LAST, id DESC
        LIMIT 1
      ), recovered AS (
        SELECT recovered_at, recovered_by
        FROM chain
        WHERE recovered_at IS NOT NULL
        ORDER BY recovered_at ASC
        LIMIT 1
      ), accepted_item AS (
        SELECT item."resolved_at" AS accepted_at, item."resolved_by" AS accepted_by
        FROM "recovery_items" item
        WHERE item."org_id" = ${orgId}
          AND item."resolution_reason" = 'accepted_loss'
          AND item."resolved_at" IS NOT NULL
          AND (
            item."dead_letter_id" IN (SELECT id FROM chain)
            OR EXISTS (
              SELECT 1
              FROM "recovery_item_children" child
              WHERE child."org_id" = item."org_id"
                AND child."recovery_item_id" = item."id"
                AND child."dead_letter_id" IN (SELECT id FROM chain)
            )
          )
        ORDER BY item."resolved_at" ASC, item."id" ASC
        LIMIT 1
      ), accepted_audit AS (
        SELECT audit."created_at" AS accepted_at, audit."user_id" AS accepted_by
        FROM "audit_logs" audit
        WHERE audit."org_id" = ${orgId}
          AND audit."action" = 'dlq.resolved'
          AND audit."target_type" = 'dlq'
          AND audit."target_id" IN (SELECT id FROM chain)
        ORDER BY audit."created_at" ASC NULLS LAST, audit."id" ASC
        LIMIT 1
      ), root_item AS (
        SELECT item."id", item."error_signature"
        FROM "recovery_items" item
        WHERE item."org_id" = ${orgId}
          AND item."error_signature" IS NOT NULL
          AND (
            item."dead_letter_id" IN (SELECT id FROM chain)
            OR EXISTS (
              SELECT 1
              FROM "recovery_item_children" child
              WHERE child."org_id" = item."org_id"
                AND child."recovery_item_id" = item."id"
                AND child."dead_letter_id" IN (SELECT id FROM chain)
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
          WHERE later_item."first_occurred_at" > recovered.recovered_at
            AND later_item."first_occurred_at" <= recovered.recovered_at + interval '7 days'
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
          WHERE child."occurred_at" > recovered.recovered_at
            AND child."occurred_at" <= recovered.recovered_at + interval '7 days'
            AND child_run."replay_mode" IS NULL
        ) candidates
      )
      SELECT
        latest.id AS latest_dead_letter_id,
        latest.status AS latest_status,
        (SELECT count(*)::int FROM chain) AS attempt_count,
        (SELECT count(*) > ${RECOVERY_DRILL_REPLAY_CHAIN_LIMIT} FROM chain_scan) AS chain_capped,
        (SELECT min(replay_started_at) FROM chain) AS replay_started_at,
        recovered.recovered_at,
        recovered.recovered_by,
        accepted_item.accepted_at AS accepted_item_at,
        accepted_item.accepted_by AS accepted_item_by,
        accepted_audit.accepted_at AS accepted_audit_at,
        accepted_audit.accepted_by AS accepted_audit_by,
        recurrence.recurred_at
      FROM latest
      LEFT JOIN recovered ON true
      LEFT JOIN accepted_item ON true
      LEFT JOIN accepted_audit ON true
      LEFT JOIN recurrence ON true
    ) facts ON root.id IS NOT NULL
    ORDER BY drill.run_created_at DESC, drill.run_id DESC
  `);

  const samples = rows.map((row): RecoveryValidationSample => {
    const hasOutcome = Boolean(
      row.root_dead_letter_id
      && row.root_status
      && row.latest_dead_letter_id
      && row.latest_status,
    );
    let outcome: RecoveryDrillOutcome | null = null;
    if (hasOutcome) {
      const facts: RecoveryDrillOutcomeFacts = {
        rootCreatedAt: asDate(row.root_created_at),
        rootStatus: row.root_status as string,
        latestDeadLetterId: row.latest_dead_letter_id as string,
        latestStatus: row.latest_status as string,
        attemptCount: Number(row.attempt_count),
        chainCapped: Boolean(row.chain_capped),
        replayStartedAt: asDate(row.replay_started_at),
        recoveredAt: asDate(row.recovered_at),
        acceptedItemAt: asDate(row.accepted_item_at),
        acceptedAuditAt: asDate(row.accepted_audit_at),
        recurredAt: asDate(row.recurred_at),
      };
      outcome = buildRecoveryDrillOutcome(facts, now);
    }

    const actor = outcome?.status === "recovered"
      ? row.recovered_by
      : outcome?.status === "accepted_loss"
        ? acceptedActor(row)
        : null;
    const runCreatedAt = asDate(row.run_created_at) ?? now;
    return {
      runId: row.run_id,
      runCreatedAt: runCreatedAt.toISOString(),
      packId: row.pack_id,
      fixtureId: row.fixture_id,
      failureMode: row.failure_mode,
      recoveryPath: row.recovery_path,
      resolutionMode: resolutionMode(actor),
      outcome,
    };
  });

  return buildRecoveryValidationReport({
    samples,
    windowDays,
    generatedAt: now,
    sampleCapped: Boolean(rows[0]?.sample_capped),
  });
}
