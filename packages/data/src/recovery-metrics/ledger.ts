/** Constant-time and operator-scoped recovery impact projections. */

import { db, recoveryImpactEvents, recoveryImpactRollups, runs } from "@janusly/db";
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import type { RecoveryLedgerRepo } from "./contracts";

/** Read the tenant's constant-time lifetime recovery projection. */
export async function queryRecoveryLedger(orgId: string): Promise<RecoveryLedgerRepo> {
  const rows = await db
    .select({
      totalRecovered: recoveryImpactRollups.totalRecovered,
      downtimeEndedMs: recoveryImpactRollups.downtimeEndedMs,
      since: recoveryImpactRollups.firstRecoveredAt,
    })
    .from(recoveryImpactRollups)
    .where(eq(recoveryImpactRollups.orgId, orgId))
    .limit(1);

  const row = rows[0];
  const totalRecovered = Number(row?.totalRecovered ?? 0);
  const downtimeEndedMs = Number(row?.downtimeEndedMs ?? 0);
  const since = row?.since ?? null;
  return {
    totalRecovered: Number.isFinite(totalRecovered) ? Math.max(0, Math.floor(totalRecovered)) : 0,
    downtimeEndedMs: Number.isFinite(downtimeEndedMs) ? Math.max(0, Math.round(downtimeEndedMs)) : 0,
    sinceIso: since ? (since instanceof Date ? since : new Date(since)).toISOString() : null,
  };
}

/** Count terminally successful DLQ recoveries attributed to one operator. */
export async function queryOperatorRecoveryCount(
  orgId: string,
  userId: string,
  since: Date,
): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(recoveryImpactEvents)
    .innerJoin(
      runs,
      and(
        eq(runs.id, recoveryImpactEvents.runId),
        eq(runs.orgId, recoveryImpactEvents.orgId),
      ),
    )
    .where(and(
      eq(recoveryImpactEvents.orgId, orgId),
      eq(recoveryImpactEvents.userId, userId),
      gte(recoveryImpactEvents.recoveredAt, since),
      isNull(runs.replayMode),
    ));
  const count = Number(rows[0]?.count ?? 0);
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}
