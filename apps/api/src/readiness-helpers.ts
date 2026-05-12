/**
 * DB-aware sidecars to the engine's pure `checkWorkflowReadiness` rule
 * set. The engine result is per-DAG (no I/O); the rollback-availability
 * check needs a `workflow_versions` lookup and lives here so the engine
 * package stays I/O-free.
 *
 * Used by `apps/api/src/routes/workflows-routes.ts` and
 * `apps/api/src/routes/runs-routes.ts` (the production-mode `/start`
 * gate).
 *
 * Invariants:
 * - Multi-tenant scope: the rollback query carries
 *   `eq(workflowVersions.orgId, orgId)`.
 * - Anonymous workflows (no `id`) skip the check — `workflow_versions`
 *   is keyed by the saved id, so an ad-hoc workflow has nothing to
 *   count.
 */

import { and, eq } from "drizzle-orm";

import { db, workflowVersions } from "@janusly/db";
import type { ReadinessIssue, ReadinessResult } from "@janusly/engine/src/workflow-readiness";

/**
 * Layer the DB-aware rollback-availability check on top of the pure
 * `checkWorkflowReadiness` result. Workflows with only one persisted
 * version have no rollback target if a future save introduces a
 * regression; the readiness gate surfaces this as a `warn` so the
 * operator knows.
 */
export async function checkRollbackAvailability(orgId: string, workflowId: string | undefined): Promise<ReadinessIssue[]> {
  if (!workflowId) return [];
  const rows = await db
    .select({ id: workflowVersions.id })
    .from(workflowVersions)
    .where(and(eq(workflowVersions.orgId, orgId), eq(workflowVersions.workflowId, workflowId)));
  if (rows.length >= 2) return [];
  return [{
    code: "workflow_missing_rollback_version",
    severity: "warn",
    message: "Only one workflow version exists. If a future save introduces a regression there is no prior version to roll back to.",
    suggestion: "Save the workflow at least once more (or duplicate the current version) so the runtime improvement path can roll back if confidence drops.",
  }];
}

/** Combine the pure readiness result with extra issues from DB-aware checks. Re-rolls up status to the worst severity across the union. */
export function mergeReadiness(base: ReadinessResult, extra: ReadinessIssue[]): ReadinessResult {
  const issues = [...base.issues, ...extra];
  const status = issues.some((issue) => issue.severity === "fail")
    ? "fail"
    : issues.some((issue) => issue.severity === "warn")
      ? "warn"
      : "pass";
  return { status, issues };
}
