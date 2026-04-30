/**
 * Repository for rolling a workflow back to a prior version.
 *
 * Janusly never destructively mutates `workflow_versions`; rollback is
 * implemented as appending a NEW version whose `dagJson` is the target's,
 * with a `metadata.rollback` block recording the reason. That way the
 * version history is fully audit-able.
 *
 * Used by:
 * - `packages/domain/src/improvementEngine.ts` — calls this when an applied
 *   improvement performs worse than the baseline.
 * - `apps/api/src/index.ts` — exposed via the rollback admin endpoint.
 *
 * Invariants:
 * - Multi-tenant scope: every query filters on `orgId`.
 * - Throws when there's no version history or the target version is
 *   unknown — caller decides whether to surface or recover.
 */

import { db, workflowVersions } from "@janusly/db";
import { and, desc, eq } from "drizzle-orm";

/**
 * Append a new version of `workflowId` whose `dagJson` mirrors `targetVersion`,
 * stamped with rollback metadata for the audit trail.
 *
 * @returns identifiers for the new rollback row plus the previous and
 *          restored version numbers, useful for emitting `rollback.applied`
 *          events.
 */
export async function rollbackWorkflowVersion(input: {
  orgId: string;
  workflowId: string;
  targetVersion: number;
  createdBy?: string;
  reason?: string;
}) {
  const versions = await db
    .select()
    .from(workflowVersions)
    .where(and(eq(workflowVersions.orgId, input.orgId), eq(workflowVersions.workflowId, input.workflowId)))
    .orderBy(desc(workflowVersions.version));

  const latest = versions[0];
  const target = versions.find((version) => version.version === input.targetVersion);

  if (!latest) throw new Error("Workflow has no versions to rollback from");
  if (!target) throw new Error(`Target workflow version ${input.targetVersion} not found`);

  const nextVersion = (latest.version ?? 0) + 1;
  const versionId = crypto.randomUUID();

  await db.insert(workflowVersions).values({
    id: versionId,
    orgId: input.orgId,
    workflowId: input.workflowId,
    version: nextVersion,
    dagJson: {
      ...(target.dagJson as Record<string, unknown>),
      id: input.workflowId,
      metadata: {
        ...((target.dagJson as any)?.metadata ?? {}),
        rollback: {
          fromVersion: latest.version,
          toVersion: target.version,
          reason: input.reason ?? "automatic rollback",
        },
      },
    },
    createdBy: input.createdBy,
  });

  return {
    workflowId: input.workflowId,
    versionId,
    previousVersion: latest.version,
    restoredVersion: target.version,
    newVersion: nextVersion,
  };
}
