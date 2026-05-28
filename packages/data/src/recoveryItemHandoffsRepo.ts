/**
 * Repository for the `recovery_item_handoffs` table — operator-driven
 * incident handoffs to external coordination systems (Slack / Linear /
 * GitHub / generic webhook).
 *
 * One row per `(orgId, recoveryItemId, destination)` triple. The unique
 * index makes `upsertHandoff` idempotent: the first call inserts, every
 * subsequent call bumps `dispatchCount` and updates the outcome fields
 * while preserving `firstDispatchedAt` + `externalId` + `externalUrl` so
 * the operator can still click through to the original GitHub issue /
 * Slack thread.
 *
 * Used by:
 *  - `apps/api/src/recovery-handoff-dispatcher.ts` (per-destination dispatch)
 *  - `apps/api/src/routes/recovery-handoff-routes.ts` (route entry)
 *
 * Invariants:
 *  - Every read filters by `orgId`. No helper bypasses the predicate.
 *  - `upsertHandoff` is the SOLE write path; concurrent calls are
 *    serialised by Postgres via the unique index.
 *  - Closed-enum validation lives in `@janusly/shared/src/recovery-handoff`
 *    (Zod). The repo doesn't re-validate inputs.
 */

import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db, recoveryItemHandoffs } from "@janusly/db";
import type {
  HandoffOutcome,
  RecoveryHandoffDestination,
} from "@janusly/shared";

export type RecoveryItemHandoffRow = typeof recoveryItemHandoffs.$inferSelect;

export type RecoveryItemHandoff = {
  id: string;
  orgId: string;
  recoveryItemId: string;
  destination: RecoveryHandoffDestination;
  credentialName: string;
  externalId: string | null;
  externalUrl: string | null;
  idempotencyKey: string;
  lastOutcome: HandoffOutcome;
  lastStatusCode: number | null;
  lastError: string | null;
  lastLatencyMs: number | null;
  dispatchCount: number;
  firstDispatchedAt: Date;
  lastDispatchedAt: Date;
  createdBy: string | null;
};

function hydrate(row: RecoveryItemHandoffRow): RecoveryItemHandoff {
  return {
    id: row.id,
    orgId: row.orgId,
    recoveryItemId: row.recoveryItemId,
    destination: row.destination as RecoveryHandoffDestination,
    credentialName: row.credentialName,
    externalId: row.externalId,
    externalUrl: row.externalUrl,
    idempotencyKey: row.idempotencyKey,
    lastOutcome: row.lastOutcome as HandoffOutcome,
    lastStatusCode: row.lastStatusCode,
    lastError: row.lastError,
    lastLatencyMs: row.lastLatencyMs,
    dispatchCount: row.dispatchCount,
    firstDispatchedAt: row.firstDispatchedAt,
    lastDispatchedAt: row.lastDispatchedAt,
    createdBy: row.createdBy,
  };
}

/** Idempotency lookup. Returns the existing handoff row when one exists. */
export async function getHandoffByKey(
  orgId: string,
  recoveryItemId: string,
  destination: RecoveryHandoffDestination,
): Promise<RecoveryItemHandoff | null> {
  const rows = await db
    .select()
    .from(recoveryItemHandoffs)
    .where(
      and(
        eq(recoveryItemHandoffs.orgId, orgId),
        eq(recoveryItemHandoffs.recoveryItemId, recoveryItemId),
        eq(recoveryItemHandoffs.destination, destination),
      ),
    );
  return rows[0] ? hydrate(rows[0]) : null;
}

/** List every handoff for a recovery item, ordered by first dispatch. */
export async function listHandoffsForItem(
  orgId: string,
  recoveryItemId: string,
): Promise<RecoveryItemHandoff[]> {
  const rows = await db
    .select()
    .from(recoveryItemHandoffs)
    .where(
      and(
        eq(recoveryItemHandoffs.orgId, orgId),
        eq(recoveryItemHandoffs.recoveryItemId, recoveryItemId),
      ),
    )
    .orderBy(asc(recoveryItemHandoffs.firstDispatchedAt));
  return rows.map(hydrate);
}

/** Org-scoped recency feed (admin debugging UI). Capped at the limit. */
export async function listRecentHandoffs(
  orgId: string,
  limit = 50,
): Promise<RecoveryItemHandoff[]> {
  const safeLimit = Math.min(Math.max(1, limit), 200);
  const rows = await db
    .select()
    .from(recoveryItemHandoffs)
    .where(eq(recoveryItemHandoffs.orgId, orgId))
    .orderBy(desc(recoveryItemHandoffs.lastDispatchedAt))
    .limit(safeLimit);
  return rows.map(hydrate);
}

export type UpsertHandoffInput = {
  orgId: string;
  recoveryItemId: string;
  destination: RecoveryHandoffDestination;
  credentialName: string;
  idempotencyKey: string;
  outcome: HandoffOutcome;
  statusCode?: number | null;
  error?: string | null;
  latencyMs: number;
  externalId?: string | null;
  externalUrl?: string | null;
  createdBy: string;
};

/**
 * INSERT … ON CONFLICT DO UPDATE on `(orgId, recoveryItemId, destination)`.
 * First call inserts with `dispatchCount = 1`. Every subsequent call:
 *  - increments `dispatchCount`
 *  - updates `lastOutcome` / `lastStatusCode` / `lastError` / `lastLatencyMs`
 *  - bumps `lastDispatchedAt`
 *  - preserves `firstDispatchedAt`, `createdBy`, and the original
 *    `externalId` / `externalUrl` (when the previous successful dispatch
 *    returned them — a subsequent failed call WON'T overwrite a valid
 *    `externalId` with `null`)
 */
export async function upsertHandoff(input: UpsertHandoffInput): Promise<RecoveryItemHandoff> {
  const id = crypto.randomUUID();
  const now = new Date();
  await db
    .insert(recoveryItemHandoffs)
    .values({
      id,
      orgId: input.orgId,
      recoveryItemId: input.recoveryItemId,
      destination: input.destination,
      credentialName: input.credentialName,
      idempotencyKey: input.idempotencyKey,
      externalId: input.externalId ?? null,
      externalUrl: input.externalUrl ?? null,
      lastOutcome: input.outcome,
      lastStatusCode: input.statusCode ?? null,
      lastError: input.error ?? null,
      lastLatencyMs: input.latencyMs,
      dispatchCount: 1,
      firstDispatchedAt: now,
      lastDispatchedAt: now,
      createdBy: input.createdBy,
    })
    .onConflictDoUpdate({
      target: [
        recoveryItemHandoffs.orgId,
        recoveryItemHandoffs.recoveryItemId,
        recoveryItemHandoffs.destination,
      ],
      set: {
        credentialName: input.credentialName,
        // COALESCE preserves the original externalId/URL when the second
        // call doesn't return one (e.g., a failed dispatch shouldn't wipe
        // the successful first attempt's issue number).
        externalId: sql`COALESCE(EXCLUDED.external_id, ${recoveryItemHandoffs.externalId})`,
        externalUrl: sql`COALESCE(EXCLUDED.external_url, ${recoveryItemHandoffs.externalUrl})`,
        lastOutcome: input.outcome,
        lastStatusCode: input.statusCode ?? null,
        lastError: input.error ?? null,
        lastLatencyMs: input.latencyMs,
        dispatchCount: sql`${recoveryItemHandoffs.dispatchCount} + 1`,
        lastDispatchedAt: now,
      },
    });

  const row = await getHandoffByKey(input.orgId, input.recoveryItemId, input.destination);
  if (!row) throw new Error("handoff row missing immediately after upsert");
  return row;
}

// Multi-tenant invariant: tenant-scoped reads and writes keep orgId in the predicate; document system/global exceptions - see AGENTS.md "Decision engine / RL".
