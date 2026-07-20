/**
 * Workflow-save helper — single-transaction "insert a new workflow_versions
 * row, conditionally insert the workflow row" primitive used by
 * `POST /workflows/save`. Wraps the `db.transaction` body in a small
 * unique-constraint retry loop so concurrent saves for the same
 * `(orgId, workflowId)` resolve cleanly instead of surfacing a 5xx.
 *
 * Race condition the retry resolves:
 *   Two operators (or the operator + an automation) save the same
 *   workflow concurrently. Both transactions read the latest
 *   `workflow_versions` row, both compute the same `nextVersion`, both
 *   try to INSERT. The unique index
 *   `(orgId, workflowId, version)` rejects the second INSERT with
 *   Postgres `23505`. Without retry the loser's request errors out;
 *   with retry, the loser re-reads the now-newer latest version,
 *   bumps `nextVersion`, and INSERTs again. Bounded at
 *   `MAX_VERSION_WRITE_ATTEMPTS` attempts — pathological contention falls
 *   through to a `kind: "conflict"` result so the route can return
 *   a clean 409 ("please retry") instead of a generic 500.
 *
 * Why retry over advisory lock:
 *   - Local fix to one route, no schema/migration change.
 *   - No `pg_advisory_xact_lock` raw-SQL escape hatch; Drizzle's
 *     ergonomics for raw SQL inside transactions are minimal.
 *   - Standard Postgres concurrency idiom; the unique index already
 *     protects integrity, retry just gives a clean UX layer.
 *
 * Multi-tenant scope: every query inside the transaction filters by
 * both `orgId` and `workflowId`, mirroring the inline handler exactly.
 *
 * Used by `apps/api/src/routes/workflows-routes.ts:POST /workflows/save`. Sister to
 * `rollbackWorkflowToVersion` in `workflows-rollback.ts` which uses
 * the same single-transaction pattern but for rollbacks.
 */

import { and, desc, eq } from "drizzle-orm";
import { db, workflowVersions, workflows } from "@janusly/db";
import type { Workflow } from "@janusly/shared";
import { syncWorkflowSchedules } from "@janusly/engine/src/schedule-scheduler";

import {
  isRetryableVersionWriteViolation,
  MAX_VERSION_WRITE_ATTEMPTS,
} from "./workflow-version-write";

/**
 * Result of an attempted save. `kind: "conflict"` is non-throwing so
 * the route layer can map it to HTTP 409 without a try/catch around
 * the helper. Non-retryable errors (Postgres errors other than the
 * version unique-constraint violation) propagate as throws.
 */
export type SaveWorkflowResult =
  | {
      kind: "ok";
      /** The newly-inserted `workflow_versions` row id. */
      versionId: string;
      /** The new version number (`max(version) + 1`). */
      version: number;
      /** The workflow id used (input or freshly generated). */
      workflowId: string;
      /** The workflow name used (input or defaulted to the id). */
      workflowName: string;
      /** Number of transaction attempts that ran before success. `1` on first-try success. */
      attempts: number;
    }
  | {
      kind: "conflict";
      /** Number of transaction attempts that ran before giving up. */
      attempts: number;
    }
  | {
      /**
       * The target workflow exists but is soft-deleted (`deletedAt` set).
       * Saving must not silently resurrect it or append a hidden version —
       * the route maps this to the standard `workflow_not_found` 404, same as
       * every other soft-delete gate. The operator restores explicitly first.
       */
      kind: "deleted";
    };

/** Backward-compatible aliases retained for focused save-helper tests. */
export const MAX_SAVE_ATTEMPTS = MAX_VERSION_WRITE_ATTEMPTS;
export const isRetryableSaveViolation = isRetryableVersionWriteViolation;

/**
 * Save a workflow as a new version. Generates the workflow id, name,
 * and version-row id from the parsed workflow input. Wraps the
 * single-transaction insert in a bounded retry loop so concurrent
 * saves resolve cleanly. The caller is responsible for the audit
 * write (so the route can include the auth context).
 */
export async function saveWorkflowVersion(args: {
  orgId: string;
  userId: string | null;
  parsedWorkflow: Workflow;
  /**
   * Optional upstream-health source tags for the new version. `undefined`
   * means "no explicit value in the save body" → carry forward the prior
   * version's tags (same posture as the SLO carry-forward). An explicit array
   * (including `[]`) overrides — `[]` clears the subscription.
   */
  upstreamHealthSources?: string[];
}): Promise<SaveWorkflowResult> {
  const { orgId, userId, parsedWorkflow, upstreamHealthSources } = args;
  const workflowId = parsedWorkflow.id ?? crypto.randomUUID();
  const workflowName = parsedWorkflow.name ?? workflowId;

  // Reject a save against a soft-deleted workflow: an EXISTING tombstoned row
  // must behave as "not found" (the operator restores it explicitly first), not
  // silently gain a hidden version. A brand-new id (no row) falls through to the
  // insert path below; an active row takes the normal update path. The
  // delete-races-save TOCTOU is benign — the loser is hidden + retention-swept.
  const existingForGate = await db
    .select({ deletedAt: workflows.deletedAt })
    .from(workflows)
    .where(and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)))
    .limit(1);
  if (existingForGate[0]?.deletedAt) return { kind: "deleted" };

  for (let attempt = 1; attempt <= MAX_VERSION_WRITE_ATTEMPTS; attempt += 1) {
    // A fresh `versionId` per attempt — the previous attempt's INSERT
    // was rolled back when the transaction aborted, but generating a
    // new UUID makes log lines unambiguous if a row partially landed
    // and then rolled back (it didn't, but the discipline costs
    // nothing).
    const versionId = crypto.randomUUID();
    try {
      const { nextVersion } = await db.transaction(async (tx) => {
        const latestVersions = await tx.select({
          version: workflowVersions.version,
          sloJson: workflowVersions.sloJson,
          upstreamHealthSources: workflowVersions.upstreamHealthSources,
        }).from(workflowVersions)
          .where(and(eq(workflowVersions.workflowId, workflowId), eq(workflowVersions.orgId, orgId)))
          .orderBy(desc(workflowVersions.version))
          .limit(1);
        const latestVersion = latestVersions[0];
        const computedVersion = (latestVersion?.version ?? 0) + 1;
        // Carry forward the prior version's SLO so the operator does not
        // have to re-declare it on every workflow edit. A dedicated
        // setWorkflowSlo route writes to the latest version in place.
        const inheritedSloJson = latestVersion?.sloJson ?? null;
        // Carry forward upstream-health source tags the same way. An explicit
        // value in the save body overrides; `undefined` inherits.
        const resolvedUpstreamHealthSources =
          upstreamHealthSources !== undefined
            ? upstreamHealthSources
            : ((latestVersion?.upstreamHealthSources as string[] | null) ?? null);

        const existingWorkflow = await tx.select().from(workflows)
          .where(and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)));
        if (existingWorkflow[0]) {
          if (existingWorkflow[0].name !== workflowName) {
            await tx.update(workflows).set({ name: workflowName })
              .where(and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)));
          }
        } else {
          await tx.insert(workflows).values({ id: workflowId, orgId, name: workflowName, createdBy: userId });
        }

        await tx.insert(workflowVersions).values({
          id: versionId,
          orgId,
          workflowId,
          version: computedVersion,
          dagJson: { ...parsedWorkflow, id: workflowId, name: workflowName },
          sloJson: inheritedSloJson,
          upstreamHealthSources: resolvedUpstreamHealthSources,
          createdBy: userId,
        });

        return { nextVersion: computedVersion };
      });

      // Reconcile cron-driven trigger entries OUTSIDE the save
      // transaction. A failure here is logged but never undoes the
      // save — the next save (or the worker's cold-start replay) will
      // re-sync via the deterministic `schedule:<orgId>:<versionId>:<nodeId>`
      // BullMQ scheduler id.
      try {
        await syncWorkflowSchedules({
          orgId,
          workflowId,
          workflowVersionId: versionId,
          nodes: parsedWorkflow.nodes,
          createdBy: userId,
        });
      } catch (err) {
        console.error("[workflows-save] schedule sync failed", { workflowId, versionId, err });
      }

      return {
        kind: "ok",
        versionId,
        version: nextVersion,
        workflowId,
        workflowName,
        attempts: attempt,
      };
    } catch (err) {
      if (isRetryableVersionWriteViolation(err) && attempt < MAX_VERSION_WRITE_ATTEMPTS) {
        // Lost the version-uniqueness race against a concurrent saver.
        // The other writer's row has committed; the next loop
        // iteration's `select latest version` will see it and bump
        // `nextVersion` accordingly.
        continue;
      }
      // Either a non-23505 error, a 23505 on a different constraint
      // (genuine bug), or we've exhausted the retry budget — propagate.
      // The "exhausted with 23505" case becomes the conflict envelope
      // below by construction (we only reach here when retry isn't
      // permitted).
      if (isRetryableVersionWriteViolation(err)) {
        return { kind: "conflict", attempts: MAX_VERSION_WRITE_ATTEMPTS };
      }
      throw err;
    }
  }

  // Defensive — all paths above either return or throw. Fall-through
  // here means we ran out of attempts without a successful return,
  // matching the "exhausted with 23505" case.
  return { kind: "conflict", attempts: MAX_VERSION_WRITE_ATTEMPTS };
}
