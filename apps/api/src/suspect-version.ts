/**
 * "Suspect version" change correlation (M-08). Answers the first RCA question
 * — "what changed?" — by correlating a dead letter with the workflow version
 * its failing run executed: when that version was saved shortly before the
 * failure AND a predecessor version exists, the failure is tagged with the
 * suspect version plus both DAG snapshots so the UI can render the diff.
 *
 * Read-time resolution, deliberately NOT a write-path tag: no migration, no
 * new column, and the correlation self-corrects as versions/rows change. The
 * criterion is per-dead-letter — each dead letter's run pins the exact
 * version it ran on, so a failure that predates the save can never be
 * attributed to it (its run carries the older version id).
 *
 * Used by:
 * - `routes/dlq-routes.ts` — the `GET /dlq?id=` detail read attaches
 *   `suspectVersion` to the response envelope.
 * - `apps/web` DeadLettersPanel renders the "Started after v{N} was saved"
 *   chip + a WorkflowDiffView over the two returned snapshots.
 *
 * Invariant: this is informational correlation, not causality — the chip copy
 * must stay temporal ("started after ... was saved"), never causal ("broke
 * by ..."). Keep the window conservative.
 */

import { and, eq } from "drizzle-orm";

import { db, runs, workflowVersions } from "@janusly/db";

/** How soon after a version save a failure counts as "suspect" (24h). */
export const SUSPECT_VERSION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The correlation envelope attached to the `GET /dlq?id=` detail response. */
export type SuspectVersion = {
  workflowId: string;
  version: number;
  versionId: string;
  /** ISO timestamp of the suspect version's save. */
  savedAt: string;
  previousVersion: number;
  previousVersionId: string;
  /** The suspect version's DAG snapshot (diff `after` side). */
  dagJson: unknown;
  /** The predecessor's DAG snapshot (diff `before` side). */
  previousDagJson: unknown;
};

/**
 * Pure window check: the failure happened AT or AFTER the save, and no more
 * than `windowMs` later. Exposed for unit tests.
 */
export function isWithinSuspectWindow(
  versionSavedAt: Date,
  failureAt: Date,
  windowMs: number = SUSPECT_VERSION_WINDOW_MS,
): boolean {
  const delta = failureAt.getTime() - versionSavedAt.getTime();
  return delta >= 0 && delta <= windowMs;
}

/**
 * Resolve the suspect version for a failure: the failing run's own
 * `workflowVersionId`, when that version is v2+ (a predecessor exists to diff
 * against) and was saved within the window before the failure. Returns null
 * on any miss — orphaned run (no FK by design), v1, out-of-window, or a
 * predecessor pruned by retention.
 */
export async function resolveSuspectVersion(
  orgId: string,
  runId: string,
  failureAt: Date | null,
): Promise<SuspectVersion | null> {
  if (!failureAt) return null;

  const runRows = await db
    .select({ workflowVersionId: runs.workflowVersionId, orgId: runs.orgId })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1);
  const run = runRows[0];
  if (!run || run.orgId !== orgId) return null;

  const versionRows = await db
    .select()
    .from(workflowVersions)
    .where(and(eq(workflowVersions.id, run.workflowVersionId), eq(workflowVersions.orgId, orgId)))
    .limit(1);
  const version = versionRows[0];
  if (!version || version.version < 2 || !version.createdAt) return null;
  if (!isWithinSuspectWindow(version.createdAt, failureAt)) return null;

  const previousRows = await db
    .select()
    .from(workflowVersions)
    .where(and(
      eq(workflowVersions.workflowId, version.workflowId),
      eq(workflowVersions.orgId, orgId),
      eq(workflowVersions.version, version.version - 1),
    ))
    .limit(1);
  const previous = previousRows[0];
  if (!previous) return null;

  return {
    workflowId: version.workflowId,
    version: version.version,
    versionId: version.id,
    savedAt: version.createdAt.toISOString(),
    previousVersion: previous.version,
    previousVersionId: previous.id,
    dagJson: version.dagJson,
    previousDagJson: previous.dagJson,
  };
}
