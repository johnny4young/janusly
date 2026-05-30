/**
 * Rollback helper — single-transaction "save the source version's DAG as a
 * new version" primitive used by `POST /workflows/rollback`.
 *
 * History stays forward-only: rolling back to v3 from a workflow at v5
 * inserts a new v6 row whose `dagJson` is structurally equal to v3. The
 * audit row in the route layer captures the source version so operators
 * can trace why v6 looks like v3.
 *
 * Multi-tenant scope: the source-version load filters by both `orgId` and
 * `workflowId`, so a `sourceVersionId` from another org or pointing at a
 * different workflow returns `not_found` instead of leaking the row.
 *
 * Race-safety: the read-then-insert runs inside one Drizzle transaction,
 * and `(orgId, workflowId, version)` is a unique index — concurrent
 * rollbacks/saves resolve via the same constraint that already protects
 * `POST /workflows/save`.
 */

import { and, desc, eq } from "drizzle-orm";
import { db, workflowVersions } from "@janusly/db";

/** Result of an attempted rollback. `ok: false` cases are non-throwing so
 *  the route layer can map them to HTTP statuses without a try/catch. */
export type RollbackResult =
  | {
      ok: true;
      /** The newly-inserted `workflow_versions` row id. */
      versionId: string;
      /** The new version number (`max(version) + 1`). */
      version: number;
      /** The source version number — what the operator clicked on. */
      sourceVersion: number;
      /** Echoes the input so the audit trail is self-contained. */
      sourceVersionId: string;
    }
  | { ok: false; code: "not_found" };

/** Successful rollback payload narrowed for callers that need audit metadata. */
export type SuccessfulRollbackResult = Extract<RollbackResult, { ok: true }>;

/** Stable audit metadata shape for the route's `workflow.rolled_back` row. */
export function rollbackAuditMetadata(result: SuccessfulRollbackResult) {
  return {
    sourceVersionId: result.sourceVersionId,
    sourceVersion: result.sourceVersion,
    newVersion: result.version,
  };
}

/**
 * Roll a workflow back to a prior version by inserting a new version row
 * with the source's `dagJson`. The caller is responsible for the audit
 * write (so the route can include the auth context cleanly).
 */
export async function rollbackWorkflowToVersion(args: {
  orgId: string;
  userId: string;
  workflowId: string;
  sourceVersionId: string;
}): Promise<RollbackResult> {
  return await db.transaction(async (tx) => {
    const sourceRows = await tx
      .select()
      .from(workflowVersions)
      .where(
        and(
          eq(workflowVersions.orgId, args.orgId),
          eq(workflowVersions.id, args.sourceVersionId),
          eq(workflowVersions.workflowId, args.workflowId),
        ),
      );
    const source = sourceRows[0];
    if (!source) return { ok: false, code: "not_found" } as const;

    const existing = await tx
      .select()
      .from(workflowVersions)
      .where(
        and(
          eq(workflowVersions.orgId, args.orgId),
          eq(workflowVersions.workflowId, args.workflowId),
        ),
      )
      .orderBy(desc(workflowVersions.version));
    const nextVersion = (existing[0]?.version ?? 0) + 1;

    const versionId = crypto.randomUUID();
    await tx.insert(workflowVersions).values({
      id: versionId,
      orgId: args.orgId,
      workflowId: args.workflowId,
      version: nextVersion,
      dagJson: source.dagJson,
      // Carry forward the SLO + upstream-health subscription from the current
      // latest — a DAG rollback should not drop the operator's reliability
      // contract or upstream-pause subscription.
      sloJson: existing[0]?.sloJson ?? null,
      upstreamHealthSources: (existing[0]?.upstreamHealthSources as string[] | null) ?? null,
      createdBy: args.userId,
    });

    return {
      ok: true,
      versionId,
      version: nextVersion,
      sourceVersion: source.version,
      sourceVersionId: args.sourceVersionId,
    };
  });
}
