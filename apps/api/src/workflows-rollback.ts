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
import { db, workflowRollouts, workflowVersions, workflows } from "@janusly/db";
import { syncWorkflowSchedules } from "@janusly/engine/src/schedule-scheduler";
import { WorkflowSchema, type WorkflowNode } from "@janusly/shared";

import {
  isRetryableVersionWriteViolation,
  MAX_VERSION_WRITE_ATTEMPTS,
  ActiveWorkflowRolloutError,
} from "./workflow-version-write";

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
      /** Number of allocation attempts before the version was appended. */
      attempts: number;
    }
  | { ok: false; code: "source_not_found" | "parent_not_found" | "deleted" | "malformed" | "rollout_active" }
  | { ok: false; code: "conflict"; attempts: number };

/** Successful rollback payload narrowed for callers that need audit metadata. */
export type SuccessfulRollbackResult = Extract<RollbackResult, { ok: true }>;

/** Stable audit metadata shape for the route's `workflow.rolled_back` row. */
export function rollbackAuditMetadata(result: SuccessfulRollbackResult) {
  return {
    sourceVersionId: result.sourceVersionId,
    sourceVersion: result.sourceVersion,
    newVersion: result.version,
    attempts: result.attempts,
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
  for (let attempt = 1; attempt <= MAX_VERSION_WRITE_ATTEMPTS; attempt += 1) {
    try {
      const transactionResult = await db.transaction(async (tx) => {
        // Rollback requires an active parent. Historical storage remains
        // orphan-tolerant, but a mutation must not append new orphan history.
        const workflowRows = await tx
          .select({ deletedAt: workflows.deletedAt })
          .from(workflows)
          .where(and(eq(workflows.id, args.workflowId), eq(workflows.orgId, args.orgId)))
          .limit(1)
          .for("update");
        if (!workflowRows[0]) return { ok: false, code: "parent_not_found" } as const;
        if (workflowRows[0].deletedAt) return { ok: false, code: "deleted" } as const;
        const activeRollout = await tx.select({ id: workflowRollouts.id })
          .from(workflowRollouts)
          .where(and(
            eq(workflowRollouts.orgId, args.orgId),
            eq(workflowRollouts.workflowId, args.workflowId),
            eq(workflowRollouts.status, "active"),
          ))
          .limit(1);
        if (activeRollout[0]) throw new ActiveWorkflowRolloutError();

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
        if (!source) return { ok: false, code: "source_not_found" } as const;
        const parsedSource = WorkflowSchema.safeParse(source.dagJson);
        if (!parsedSource.success) return { ok: false, code: "malformed" } as const;

        const latestVersions = await tx
          .select({
            version: workflowVersions.version,
            sloJson: workflowVersions.sloJson,
            upstreamHealthSources: workflowVersions.upstreamHealthSources,
          })
          .from(workflowVersions)
          .where(
            and(
              eq(workflowVersions.orgId, args.orgId),
              eq(workflowVersions.workflowId, args.workflowId),
            ),
          )
          .orderBy(desc(workflowVersions.version))
          .limit(1);
        const latestVersion = latestVersions[0];
        const nextVersion = (latestVersion?.version ?? 0) + 1;
        const versionId = crypto.randomUUID();

        await tx.insert(workflowVersions).values({
          id: versionId,
          orgId: args.orgId,
          workflowId: args.workflowId,
          version: nextVersion,
          dagJson: source.dagJson,
          // Carry forward the current reliability declarations. Rolling back
          // the DAG must not silently clear an SLO or upstream subscription.
          sloJson: latestVersion?.sloJson ?? null,
          upstreamHealthSources: (latestVersion?.upstreamHealthSources as string[] | null) ?? null,
          createdBy: args.userId,
        });

        return {
          ok: true,
          versionId,
          version: nextVersion,
          sourceVersion: source.version,
          sourceVersionId: args.sourceVersionId,
          attempts: attempt,
          scheduleNodes: parsedSource.data.nodes,
        } as const;
      });

      if (!transactionResult.ok) return transactionResult;
      const { scheduleNodes, ...result } = transactionResult as typeof transactionResult & {
        scheduleNodes: WorkflowNode[];
      };

      // Scheduler reconciliation is deliberately outside the DB transaction:
      // Redis/network work must not hold a Postgres transaction open. A failure
      // never undoes the committed rollback; cold-start replay repairs it.
      try {
        await syncWorkflowSchedules({
          orgId: args.orgId,
          workflowId: args.workflowId,
          workflowVersionId: result.versionId,
          nodes: scheduleNodes,
          createdBy: args.userId,
        });
      } catch (error) {
        console.error("[workflows-rollback] schedule sync failed", {
          workflowId: args.workflowId,
          versionId: result.versionId,
          error,
        });
      }
      return result;
    } catch (error) {
      if (error instanceof ActiveWorkflowRolloutError) return { ok: false, code: "rollout_active" };
      if (isRetryableVersionWriteViolation(error) && attempt < MAX_VERSION_WRITE_ATTEMPTS) continue;
      if (isRetryableVersionWriteViolation(error)) {
        return { ok: false, code: "conflict", attempts: MAX_VERSION_WRITE_ATTEMPTS };
      }
      throw error;
    }
  }

  return { ok: false, code: "conflict", attempts: MAX_VERSION_WRITE_ATTEMPTS };
}
