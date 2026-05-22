/**
 * Repository for the per-workflow SLO carried on `workflow_versions.slo_json`.
 *
 * Janusly's SLO model is "the latest version owns the current SLO":
 *   - `getWorkflowSlo` reads the latest version's `slo_json`.
 *   - `setWorkflowSlo` updates the latest version in place.
 *   - The save chokepoint in `apps/api/src/workflows-save.ts` and the
 *     rollback flow in `workflowRollbackRepo.ts` both carry the prior
 *     latest's `slo_json` forward when minting a new version, so the SLO
 *     stays attached across DAG edits and rollbacks.
 *
 * Used by `apps/api/src/routes/workflows-routes.ts` for the admin
 * `POST /workflows/:id/slo` route and by the `/workflows/health` route
 * (which threads the SLO through `computeWorkflowHealth`).
 *
 * Multi-tenant: every query carries `eq(workflow_versions.orgId, orgId)`.
 */

import { db, workflowVersions } from "@janusly/db";
import type { WorkflowSlo } from "@janusly/shared";
import { and, desc, eq } from "drizzle-orm";

/**
 * Read the SLO attached to the latest version of `workflowId`. Returns
 * `undefined` when the workflow has no versions (caller decides whether
 * to surface as a 404), and `null` when the latest version has no SLO
 * declared.
 */
export async function getWorkflowSlo(
  orgId: string,
  workflowId: string,
): Promise<{ versionId: string; slo: WorkflowSlo | null } | undefined> {
  const rows = await db
    .select({ id: workflowVersions.id, sloJson: workflowVersions.sloJson })
    .from(workflowVersions)
    .where(and(eq(workflowVersions.orgId, orgId), eq(workflowVersions.workflowId, workflowId)))
    .orderBy(desc(workflowVersions.version))
    .limit(1);
  const latest = rows[0];
  if (!latest) return undefined;
  return {
    versionId: latest.id,
    slo: (latest.sloJson as WorkflowSlo | null) ?? null,
  };
}

/**
 * Write `slo` (or `null` to clear) onto the latest version of `workflowId`.
 * Returns the updated version id plus the previous SLO so the caller can
 * include it in the audit row.
 */
export async function setWorkflowSlo(
  orgId: string,
  workflowId: string,
  slo: WorkflowSlo | null,
): Promise<{ versionId: string; previousSlo: WorkflowSlo | null } | undefined> {
  const existing = await getWorkflowSlo(orgId, workflowId);
  if (!existing) return undefined;
  await db
    .update(workflowVersions)
    .set({ sloJson: slo })
    .where(and(eq(workflowVersions.orgId, orgId), eq(workflowVersions.id, existing.versionId)));
  return { versionId: existing.versionId, previousSlo: existing.slo };
}
