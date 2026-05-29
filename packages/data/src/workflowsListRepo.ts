/**
 * Saved-workflows list with a per-workflow run summary (last-run status +
 * run count) for the Flows dashboard.
 *
 * Used by: `apps/api` GET /workflows route handler.
 *
 * Invariants:
 * - Multi-tenant: both the base `workflows` read and the run aggregate are
 *   scoped with `eq(<table>.orgId, orgId)`.
 * - Production runs only — the aggregate filters `isNull(runs.replayMode)`
 *   so sandbox/validation replays never inflate the counts (matches the
 *   health + failure-cluster rollups).
 * - Orphan-tolerant LEFT fold: a workflow with zero matching runs returns
 *   `runCount: 0` / `lastRunStatus: null`. The runs → workflow_versions →
 *   workflows join goes through the text `workflowVersionId` (no FK, per the
 *   cascade posture in AGENTS.md), so older snapshots are tolerated.
 * - The aggregate is scoped to exactly the page just selected (`inArray` on
 *   the page ids) so the pagination cap holds — an off-page workflow is
 *   never aggregated.
 */

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { db, runs, workflows, workflowVersions } from "@janusly/db";

/** One Flows-list row: the base workflow fields plus the run summary. */
export type WorkflowListRow = {
  id: string;
  orgId: string;
  name: string;
  createdBy: string | null;
  createdAt: Date | null;
  lastRunStatus: string | null;
  runCount: number;
};

/**
 * List an org's workflows (most-recent first, capped) with each row's
 * production run count and most-recent run status folded in.
 */
export async function listWorkflowsWithRunSummary(
  orgId: string,
  limit: number,
): Promise<WorkflowListRow[]> {
  // 1. Base list — same shape/scope/cap the flat handler used.
  const base = await db
    .select()
    .from(workflows)
    .where(eq(workflows.orgId, orgId))
    .orderBy(desc(workflows.createdAt))
    .limit(limit);
  if (base.length === 0) return [];

  // 2. Per-workflow run aggregate (runs → workflow_versions → workflows),
  //    scoped to the org + this page + production runs only.
  const ids = base.map((w) => w.id);
  const agg = await db
    .select({
      workflowId: workflowVersions.workflowId,
      runCount: sql<number>`count(${runs.id})::int`,
      lastRunStatus: sql<
        string | null
      >`(array_agg(${runs.status} ORDER BY ${runs.createdAt} DESC))[1]`,
    })
    .from(runs)
    .innerJoin(workflowVersions, eq(workflowVersions.id, runs.workflowVersionId))
    .where(
      and(
        eq(workflowVersions.orgId, orgId),
        isNull(runs.replayMode),
        inArray(workflowVersions.workflowId, ids),
      ),
    )
    .groupBy(workflowVersions.workflowId);

  const byId = new Map(agg.map((r) => [r.workflowId, r]));
  return base.map((w) => ({
    id: w.id,
    orgId: w.orgId,
    name: w.name,
    createdBy: w.createdBy ?? null,
    createdAt: w.createdAt ?? null,
    lastRunStatus: byId.get(w.id)?.lastRunStatus ?? null,
    runCount: byId.get(w.id)?.runCount ?? 0,
  }));
}
