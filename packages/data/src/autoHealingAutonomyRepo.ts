/**
 * Bounded tenant-scoped facts used to explain and authorize narrow technical
 * recovery. The original failure snapshot comes from the DLQ; historical
 * success counts require both an applied supervised-healing decision and its
 * immutable terminal recovery impact event.
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import {
  autoHealingRuns,
  db,
  deadLetters,
  recoveryImpactEvents,
} from "@janusly/db";

export const AUTO_HEALING_AUTONOMY_FACT_LIMIT = 200;

export type AutoHealingAutonomyContext = {
  deadLetterId: string;
  workflowJson: unknown;
  nodeId: string;
  errorJson: unknown;
};

export type VerifiedAutoHealingRecoveryCount = {
  signature: string;
  count: number;
};

function boundedUnique(values: readonly string[]): string[] {
  return [...new Set(values)]
    .filter((value) => value.length > 0)
    .slice(0, AUTO_HEALING_AUTONOMY_FACT_LIMIT);
}

export async function listAutoHealingAutonomyContexts(
  orgId: string,
  deadLetterIds: readonly string[],
): Promise<AutoHealingAutonomyContext[]> {
  const ids = boundedUnique(deadLetterIds);
  if (ids.length === 0) return [];
  return db
    .select({
      deadLetterId: deadLetters.id,
      workflowJson: deadLetters.workflowJson,
      nodeId: deadLetters.nodeId,
      errorJson: deadLetters.errorJson,
    })
    .from(deadLetters)
    .where(and(
      eq(deadLetters.orgId, orgId),
      inArray(deadLetters.id, ids),
    ));
}

export async function queryVerifiedAutoHealingRecoveries(
  orgId: string,
  signatures: readonly string[],
): Promise<VerifiedAutoHealingRecoveryCount[]> {
  const bounded = boundedUnique(signatures);
  if (bounded.length === 0) return [];
  const rows = await db
    .select({
      signature: autoHealingRuns.signature,
      count:
        sql<number>`count(distinct ${recoveryImpactEvents.deadLetterId})::int`,
    })
    .from(autoHealingRuns)
    .innerJoin(
      recoveryImpactEvents,
      and(
        eq(
          recoveryImpactEvents.deadLetterId,
          autoHealingRuns.deadLetterId,
        ),
        eq(recoveryImpactEvents.orgId, autoHealingRuns.orgId),
      ),
    )
    .where(and(
      eq(autoHealingRuns.orgId, orgId),
      eq(autoHealingRuns.status, "applied"),
      inArray(autoHealingRuns.signature, bounded),
    ))
    .groupBy(autoHealingRuns.signature);
  return rows.map((row) => ({
    signature: row.signature,
    count: Math.max(0, Math.floor(Number(row.count) || 0)),
  }));
}
