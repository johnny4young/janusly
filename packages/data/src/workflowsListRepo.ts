/**
 * Saved-workflows list with per-workflow run and buffered-trigger summaries
 * for the Flows dashboard.
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
 * - Buffered-trigger counts use one page-scoped aggregate, never one query per
 *   workflow.
 */

import { and, desc, eq, ilike, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";

import { db, runs, triggerEvents, workflowMetadata, workflows, workflowVersions } from "@janusly/db";
import { TRIGGER_BACKFILL_CLAIM_LEASE_MS } from "./triggerEventsRepo";

/** One Flows-list row: the base workflow fields plus the run summary. */
export type WorkflowListRow = {
  id: string;
  orgId: string;
  name: string;
  createdBy: string | null;
  createdAt: Date | null;
  lastRunStatus: string | null;
  runCount: number;
  /** Events accepted during a pause that still need a run. */
  bufferedTriggerCount: number;
  /** Operational status — `active` or `paused_upstream_degraded`. Drives the paused pill + force-run affordance. */
  status: string;
  /** Operator-visible reason when paused; null when active. */
  pausedReason: string | null;
  /** Operator-assigned tags from `workflow_metadata` (empty when the workflow has no metadata row). */
  tags: string[];
  /** Operator-assigned folder from `workflow_metadata` (null = ungrouped / no metadata row). Drives the Flows-list grouping. */
  folder: string | null;
  /**
   * Soft-delete tombstone timestamp. `null` for an active workflow (the active
   * list always returns null since it filters them out); the deletion time for a
   * trash-list row, which the web renders as the "Deleted {date}" label.
   */
  deletedAt: Date | null;
};

/**
 * Optional Flows-list filters, applied in the WHERE clause before the cap.
 * `tags` is an AND set — a row must contain EVERY listed tag (one jsonb
 * containment over the whole array). `folder` is scalar equality. `search` is a
 * case-insensitive substring over the workflow name OR id (mirrors the web's
 * client-side filter) — a non-empty term narrows to matching rows. `before` is a
 * keyset cursor — return only rows strictly OLDER than this `(createdAt, id)` in
 * the list's `(createdAt DESC, id DESC)` order, so "Load more" pages forward
 * without the offset drift of numeric paging.
 */
export type WorkflowListFilters = {
  tags?: string[];
  folder?: string;
  search?: string;
  before?: { createdAt: Date; id: string };
};

/**
 * Escape the LIKE/ILIKE metacharacters (`\` `%` `_`) in a user search term so it
 * matches literally — Postgres uses `\` as the default LIKE escape, so a name
 * containing a literal `%` isn't treated as a wildcard. The term is already
 * parameter-bound by drizzle (no SQL injection); this is match-correctness only.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * List an org's workflows (most-recent first, capped) with each row's
 * production run count, most-recent run status, and operator tags + folder
 * folded in.
 *
 * The `tags` (AND set) / `folder` / `search` filters (when set) are applied in
 * the WHERE clause BEFORE the cap, so a matching workflow surfaces even if it's
 * older than the newest `limit` rows.
 */
export async function listWorkflowsWithRunSummary(
  orgId: string,
  limit: number,
  filters: WorkflowListFilters = {},
): Promise<WorkflowListRow[]> {
  // 1. Base list — LEFT JOIN workflow_metadata for tags + folder; the optional
  //    filters are applied BEFORE the cap (tags = jsonb-containment, folder =
  //    scalar equality).
  // Soft-deleted workflows (deletedAt set) are excluded from every list.
  const conditions = [eq(workflows.orgId, orgId), isNull(workflows.deletedAt)];
  if (filters.tags && filters.tags.length > 0) {
    // `tags @> '["a","b"]'::jsonb` — true only when the row's array contains ALL
    // listed tags, so multiple tags AND together in one containment. A workflow
    // with no metadata row (tags null) never matches, which is correct.
    conditions.push(sql`${workflowMetadata.tags} @> ${JSON.stringify(filters.tags)}::jsonb`);
  }
  if (filters.folder) {
    // Scalar equality on the single folder column. A workflow with no metadata
    // row (folder null) never matches, which is correct.
    conditions.push(eq(workflowMetadata.folder, filters.folder));
  }
  if (filters.search) {
    // Case-insensitive substring over name OR id (mirrors the client filter).
    // Applied before the cap, so a name match surfaces beyond the newest page
    // — the same beyond-cap reach the tag/folder filters already give.
    const pattern = `%${escapeLikePattern(filters.search)}%`;
    conditions.push(or(ilike(workflows.name, pattern), ilike(workflows.id, pattern))!);
  }
  if (filters.before) {
    // Keyset cursor — rows strictly after `(createdAt, id)` in the
    // `(createdAt DESC, id DESC)` order: older createdAt, or the same createdAt
    // with a smaller id (the unique PK tiebreaker). Composes with the filters
    // above via the shared `and(...conditions)`, so paging stays within the
    // filtered set. Applied BEFORE the cap, so it pages past it.
    conditions.push(
      or(
        lt(workflows.createdAt, filters.before.createdAt),
        and(eq(workflows.createdAt, filters.before.createdAt), lt(workflows.id, filters.before.id)),
      )!,
    );
  }
  const base = await db
    .select({
      id: workflows.id,
      orgId: workflows.orgId,
      name: workflows.name,
      createdBy: workflows.createdBy,
      createdAt: workflows.createdAt,
      status: workflows.status,
      pausedReason: workflows.pausedReason,
      tags: workflowMetadata.tags,
      folder: workflowMetadata.folder,
      deletedAt: workflows.deletedAt,
    })
    .from(workflows)
    .leftJoin(
      workflowMetadata,
      and(eq(workflowMetadata.orgId, orgId), eq(workflowMetadata.workflowId, workflows.id)),
    )
    .where(and(...conditions))
    // `id` (the unique PK) is the tiebreaker so the order is total — required for
    // the `before` keyset to never skip or repeat a row across pages. The
    // `(org_id, created_at DESC)` index still serves the range scan; equal-
    // createdAt ties (rare) sort by id in memory.
    .orderBy(desc(workflows.createdAt), desc(workflows.id))
    .limit(limit);

  return foldRunSummary(orgId, base);
}

/**
 * The base-row shape both list paths select before the run aggregate is folded
 * in. Mirrors the `workflows` columns plus the LEFT-JOINed `workflow_metadata`
 * tags + folder.
 */
type WorkflowBaseRow = {
  id: string;
  orgId: string;
  name: string;
  createdBy: string | null;
  createdAt: Date | null;
  status: string | null;
  pausedReason: string | null;
  tags: unknown;
  folder: string | null;
  deletedAt: Date | null;
};

/**
 * Fold the per-workflow production-run aggregate (run count + most-recent
 * status) into a page of base rows. Shared by the active + trash list paths so
 * the aggregate query, org/page/production-run scoping, and the orphan-tolerant
 * `runCount: 0` default live in exactly one place.
 */
async function foldRunSummary(orgId: string, base: WorkflowBaseRow[]): Promise<WorkflowListRow[]> {
  if (base.length === 0) return [];

  // Per-workflow run aggregate (runs → workflow_versions → workflows), scoped
  // to the org + this page + production runs only.
  const ids = base.map((w) => w.id);
  const staleBackfillBefore = new Date(Date.now() - TRIGGER_BACKFILL_CLAIM_LEASE_MS);
  const [agg, buffered] = await Promise.all([
    db
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
      .groupBy(workflowVersions.workflowId),
    db
      .select({
        workflowId: triggerEvents.workflowId,
        count: sql<number>`count(${triggerEvents.id})::int`,
      })
      .from(triggerEvents)
      .where(and(
        eq(triggerEvents.orgId, orgId),
        or(
          eq(triggerEvents.status, "buffered"),
          and(
            eq(triggerEvents.status, "backfilling"),
            lt(triggerEvents.backfillClaimedAt, staleBackfillBefore),
          ),
        ),
        inArray(triggerEvents.workflowId, ids),
      ))
      .groupBy(triggerEvents.workflowId),
  ]);

  const byId = new Map(agg.map((r) => [r.workflowId, r]));
  const bufferedById = new Map(buffered.map((r) => [r.workflowId, r.count]));
  return base.map((w) => ({
    id: w.id,
    orgId: w.orgId,
    name: w.name,
    createdBy: w.createdBy ?? null,
    createdAt: w.createdAt ?? null,
    lastRunStatus: byId.get(w.id)?.lastRunStatus ?? null,
    runCount: byId.get(w.id)?.runCount ?? 0,
    bufferedTriggerCount: bufferedById.get(w.id) ?? 0,
    status: w.status ?? "active",
    pausedReason: w.pausedReason ?? null,
    tags: Array.isArray(w.tags) ? (w.tags as string[]) : [],
    folder: w.folder ?? null,
    deletedAt: w.deletedAt ?? null,
  }));
}

/**
 * List an org's SOFT-DELETED workflows (most-recently-deleted first, capped)
 * with the same run summary + tags + folder fold as the active list — the data
 * behind the Flows "Trash" view.
 *
 * Counterpart to `listWorkflowsWithRunSummary`: identical shape but
 * `isNotNull(deletedAt)` and ordered by `deletedAt DESC`. The trash set is
 * bounded by the retention sweep (it purges tombstones past
 * `retention.deletedWorkflowsDays`), so v1 is a single capped read with no
 * keyset cursor.
 */
export async function listDeletedWorkflowsWithRunSummary(
  orgId: string,
  limit: number,
  before?: { deletedAt: Date; id: string },
): Promise<WorkflowListRow[]> {
  const conditions = [eq(workflows.orgId, orgId), isNotNull(workflows.deletedAt)];
  if (before) {
    // Keyset cursor — rows strictly after `(deletedAt, id)` in the
    // `(deletedAt DESC, id DESC)` order: an older deletedAt, or the same
    // deletedAt with a smaller id (the unique PK tiebreaker). The `deletedAt`
    // analogue of the active list's `createdAt` keyset; `deletedAt` is non-null
    // here (the isNotNull filter above), so the comparison is total.
    conditions.push(
      or(
        lt(workflows.deletedAt, before.deletedAt),
        and(eq(workflows.deletedAt, before.deletedAt), lt(workflows.id, before.id)),
      )!,
    );
  }
  const base = await db
    .select({
      id: workflows.id,
      orgId: workflows.orgId,
      name: workflows.name,
      createdBy: workflows.createdBy,
      createdAt: workflows.createdAt,
      status: workflows.status,
      pausedReason: workflows.pausedReason,
      tags: workflowMetadata.tags,
      folder: workflowMetadata.folder,
      deletedAt: workflows.deletedAt,
    })
    .from(workflows)
    .leftJoin(
      workflowMetadata,
      and(eq(workflowMetadata.orgId, orgId), eq(workflowMetadata.workflowId, workflows.id)),
    )
    .where(and(...conditions))
    // Most-recently-deleted first; `id` is the total-order tiebreaker.
    .orderBy(desc(workflows.deletedAt), desc(workflows.id))
    .limit(limit);

  return foldRunSummary(orgId, base);
}
