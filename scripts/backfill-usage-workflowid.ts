/**
 * One-off backfill for `usage_events.metadata.workflowId`. Older rows
 * written before workflow attribution shipped have no `workflowId` key
 * in their metadata payload. This script resolves the workflow id where
 * possible and writes a sentinel for legacy rows that genuinely cannot
 * be attributed — preserving the cost / token / latency aggregates
 * while making the workflow-axis breakdown legible.
 *
 * Idempotent: re-running the script is safe. Rows whose
 * `metadata.workflowId` key is already present are skipped. That
 * includes new `/ai/generate-workflow` rows where the recorder
 * intentionally writes `workflowId: null` because no saved workflow
 * exists yet.
 *
 * Strategy per row:
 *
 *   1. If the row has a `runId`, resolve the workflow id via the same
 *      join `getRunMetadata` uses (`runs → workflow_versions`). When
 *      the join produces a non-null id, write it. The runtime path
 *      always populates workflowId at write time now, so this branch
 *      mostly hits dev/test data from before the upgrade.
 *   2. If the legacy row has no `runId` OR the join returns null (the run
 *      row was deleted, the version was orphaned), write the sentinel
 *      `"_legacy_pre_attribution"`. The web UI renders this as
 *      "Legacy" so operators can distinguish "data from before
 *      attribution shipped" from genuinely-unattributed
 *      `/ai/generate-workflow` rows. Those newer rows already have a
 *      `workflowId` key with JSON null and are intentionally skipped.
 *
 * Multi-tenant scope: this script does NOT filter by org — it's a
 * dev/operator tool an admin runs against the whole DB. Each row's
 * `orgId` is preserved verbatim; only the `metadata` payload is
 * rewritten.
 *
 * Usage:
 *   pnpm backfill:usage-workflowid
 */

import { eq, sql } from "drizzle-orm";
import { db, runs, usageEvents, workflowVersions } from "@janusly/db";

const LEGACY_SENTINEL = "_legacy_pre_attribution";

type UsageMetadata = Record<string, unknown> & { workflowId?: string | null };

async function main(): Promise<void> {
  // Pull every legacy row whose metadata is missing the `workflowId`
  // key. Do NOT match JSON null values: new `/ai/generate-workflow`
  // calls intentionally write `{ workflowId: null }` because no saved
  // workflow exists at generation time, and those should remain in the
  // UI's `workflow=unknown` bucket rather than being re-labeled Legacy.
  const candidates = await db
    .select({
      id: usageEvents.id,
      runId: usageEvents.runId,
      metadata: usageEvents.metadata,
    })
    .from(usageEvents)
    .where(sql`metadata IS NULL OR (metadata ? 'workflowId') IS FALSE`);

  console.log(`[backfill] Inspecting ${candidates.length} rows missing metadata.workflowId.`);

  let resolved = 0;
  let sentinel = 0;

  for (const row of candidates) {
    let resolvedWorkflowId: string | null = null;

    if (row.runId) {
      const lookup = await db
        .select({ workflowId: workflowVersions.workflowId })
        .from(runs)
        .leftJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
        .where(eq(runs.id, row.runId))
        .limit(1);
      resolvedWorkflowId = lookup[0]?.workflowId ?? null;
    }

    const nextWorkflowId = resolvedWorkflowId ?? LEGACY_SENTINEL;

    // Preserve every existing key on the metadata jsonb verbatim;
    // only the `workflowId` field is added/overwritten.
    const previousMetadata: UsageMetadata = (row.metadata && typeof row.metadata === "object")
      ? (row.metadata as UsageMetadata)
      : {};
    const nextMetadata: UsageMetadata = { ...previousMetadata, workflowId: nextWorkflowId };

    await db
      .update(usageEvents)
      .set({ metadata: nextMetadata })
      .where(eq(usageEvents.id, row.id));

    if (resolvedWorkflowId) {
      resolved += 1;
    } else {
      sentinel += 1;
    }
  }

  // Sanity check: count rows whose workflowId is now populated.
  const totalRow = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(usageEvents)
    .where(sql`metadata->>'workflowId' IS NOT NULL`);

  console.log(`[backfill] Done.`);
  console.log(`[backfill]   resolved via runs join : ${resolved}`);
  console.log(`[backfill]   tagged with sentinel   : ${sentinel}`);
  console.log(`[backfill]   total rows attributed  : ${totalRow[0]?.n ?? 0}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[backfill] Failed:", err);
    process.exit(1);
  });
