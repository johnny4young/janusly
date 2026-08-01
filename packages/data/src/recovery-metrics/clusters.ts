/** Bounded terminal-recovery failure-cluster projections. */

import { db, deadLetters, recoveryImpactEvents, runs } from "@janusly/db";
import { and, eq, gte, isNull } from "drizzle-orm";
import { normalizeErrorSignature } from "@janusly/shared/src/error-signature";
import {
  RESOLVED_CLUSTERS_ROW_CAP,
  type ResolvedClustersRepo,
} from "./contracts";

/**
 * Count of distinct failure signatures with terminal recovery impact inside
 * the window. Group-by happens in
 * JS — pgvector / pg-extension functions for signature normalization don't
 * exist; the existing `normalizeErrorSignature` helper is the chokepoint and
 * lives in `@janusly/shared`.
 *
 * Multi-tenant scope: `eq(recoveryImpactEvents.orgId, orgId)`. Bounded at
 * `RESOLVED_CLUSTERS_ROW_CAP`; past the cap, the result is capped and
 * downstream rollup labels the count as "≥ cap" in the UI.
 *
 * NOTE: the cap is on the row count, not the cluster count. An org with
 * many entries per signature gets a true cluster count even when capped,
 * because the distinct-signature math runs over whatever rows came back.
 * Higher-cardinality deployments should replace this bounded scan with
 * pre-aggregated signatures.
 */
export async function queryFailureClustersResolved(
  orgId: string,
  since: Date,
): Promise<ResolvedClustersRepo> {
  const rows = await db
    .select({
      nodeId: deadLetters.nodeId,
      nodeJson: deadLetters.nodeJson,
      errorJson: deadLetters.errorJson,
    })
    .from(recoveryImpactEvents)
    .innerJoin(deadLetters, eq(deadLetters.id, recoveryImpactEvents.deadLetterId))
    .innerJoin(
      runs,
      and(
        eq(runs.id, recoveryImpactEvents.runId),
        eq(runs.orgId, recoveryImpactEvents.orgId),
      ),
    )
    .where(and(
      eq(recoveryImpactEvents.orgId, orgId),
      gte(recoveryImpactEvents.recoveredAt, since),
      isNull(runs.replayMode),
    ))
    .limit(RESOLVED_CLUSTERS_ROW_CAP + 1);

  const capped = rows.length > RESOLVED_CLUSTERS_ROW_CAP;
  const sample = capped ? rows.slice(0, RESOLVED_CLUSTERS_ROW_CAP) : rows;

  const signatures = new Set<string>();
  for (const row of sample) {
    // Derive nodeType + toolName from `nodeJson` so the normalizer's
    // signature is identical to what the failure-clusters surface
    // computes — same string for the same failure, regardless of which
    // query produced it.
    const node = (row.nodeJson as { type?: string; config?: { tool?: string } } | null) ?? null;
    const sig = normalizeErrorSignature(row.errorJson, {
      nodeId: row.nodeId,
      nodeType: node?.type,
      toolName: node?.config?.tool,
    });
    signatures.add(sig.signature);
  }

  return {
    totalClusters: signatures.size,
    totalEntries: sample.length,
    capped,
  };
}
