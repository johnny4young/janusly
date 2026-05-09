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
 *   `MAX_SAVE_ATTEMPTS` retries — pathological contention falls
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
 * Used by `apps/api/src/index.ts:POST /workflows/save`. Sister to
 * `rollbackWorkflowToVersion` in `workflows-rollback.ts` which uses
 * the same single-transaction pattern but for rollbacks.
 */

import { and, desc, eq } from "drizzle-orm";
import { db, workflowVersions, workflows } from "@janusly/db";
import type { Workflow } from "@janusly/shared";

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
    };

/**
 * Maximum total transaction attempts (including the first). Three is
 * enough headroom: a single 23505 retry resolves microseconds-fast (the
 * winning row has already committed by the time the loser re-reads),
 * and three attempts cover the typical "two concurrent + one extra
 * for rapid contention" pattern. Pathological contention falls through
 * to `kind: "conflict"`.
 */
export const MAX_SAVE_ATTEMPTS = 3;

/** Postgres SQLSTATE for unique-violation. The retry only fires on this code. */
const PG_UNIQUE_VIOLATION = "23505";

/**
 * Unique-constraint names whose violation triggers a retry. Two
 * concurrent saves on the same `(orgId, workflowId)` race on either:
 *
 *   - `workflow_versions_org_workflow_version_idx` — both writers
 *     computed the same `nextVersion`. Loser re-reads, bumps version.
 *   - `workflows_pkey` — both writers see no existing workflow row
 *     and both try to INSERT with the caller-provided `workflowId`.
 *     Loser sees the just-committed row on retry and skips the
 *     workflows-INSERT branch (the existing `existingWorkflow[0]`
 *     check inside the transaction is what closes the loop).
 *
 * Both belong to the same race; treating them uniformly as
 * "retryable save violations" keeps the route's contract simple.
 * Other 23505s are genuine bugs and re-throw.
 */
const RETRYABLE_SAVE_CONSTRAINTS: readonly string[] = [
  "workflow_versions_org_workflow_version_idx",
  "workflows_pkey",
];

/**
 * Probe the underlying Postgres error for one of the retryable
 * unique-constraint shapes. Drizzle wraps the pg driver error in
 * different ways depending on the failure mode, so we walk both
 * `err.code`, `err.cause?.code`, and the `constraint` /
 * `constraint_name` fields defensively.
 *
 * Returns `true` only when the error is BOTH a 23505 AND on one of
 * the retryable indexes (or no constraint name is exposed — defensive
 * default, since the only realistic 23505 sources inside this
 * transaction are the two listed above). Any other shape returns
 * `false` so the caller re-throws.
 */
export function isRetryableSaveViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;

  // Walk a small chain in case Drizzle wrapped the pg error.
  const candidates: unknown[] = [err];
  const seen = new WeakSet<object>();
  let cursor: unknown = err;
  for (let i = 0; i < 5; i += 1) {
    if (!cursor || typeof cursor !== "object" || seen.has(cursor as object)) break;
    seen.add(cursor as object);
    candidates.push(cursor);
    const next = (cursor as { cause?: unknown }).cause;
    if (next === cursor || !next) break;
    cursor = next;
  }

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const obj = candidate as { code?: unknown; constraint?: unknown; constraint_name?: unknown };
    if (obj.code !== PG_UNIQUE_VIOLATION) continue;
    const constraint = typeof obj.constraint === "string"
      ? obj.constraint
      : typeof obj.constraint_name === "string"
        ? obj.constraint_name
        : null;
    // Match one of the retryable indexes by name when available; when
    // the driver doesn't expose the constraint name, accept any 23505
    // since no other unique index in the save transaction can
    // plausibly fire (the only other unique surfaces are the
    // workflow_versions PK on `id` — protected by per-attempt fresh
    // UUIDs — and audit / usage tables this route never touches).
    if (constraint === null || RETRYABLE_SAVE_CONSTRAINTS.includes(constraint)) return true;
    return false;
  }
  return false;
}

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
}): Promise<SaveWorkflowResult> {
  const { orgId, userId, parsedWorkflow } = args;
  const workflowId = parsedWorkflow.id ?? crypto.randomUUID();
  const workflowName = parsedWorkflow.name ?? workflowId;

  for (let attempt = 1; attempt <= MAX_SAVE_ATTEMPTS; attempt += 1) {
    // A fresh `versionId` per attempt — the previous attempt's INSERT
    // was rolled back when the transaction aborted, but generating a
    // new UUID makes log lines unambiguous if a row partially landed
    // and then rolled back (it didn't, but the discipline costs
    // nothing).
    const versionId = crypto.randomUUID();
    try {
      const { nextVersion } = await db.transaction(async (tx) => {
        const existingVersions = await tx.select().from(workflowVersions)
          .where(and(eq(workflowVersions.workflowId, workflowId), eq(workflowVersions.orgId, orgId)))
          .orderBy(desc(workflowVersions.version));
        const computedVersion = (existingVersions[0]?.version ?? 0) + 1;

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
          createdBy: userId,
        });

        return { nextVersion: computedVersion };
      });

      return {
        kind: "ok",
        versionId,
        version: nextVersion,
        workflowId,
        workflowName,
        attempts: attempt,
      };
    } catch (err) {
      if (isRetryableSaveViolation(err) && attempt < MAX_SAVE_ATTEMPTS) {
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
      if (isRetryableSaveViolation(err)) {
        return { kind: "conflict", attempts: MAX_SAVE_ATTEMPTS };
      }
      throw err;
    }
  }

  // Defensive — all paths above either return or throw. Fall-through
  // here means we ran out of attempts without a successful return,
  // matching the "exhausted with 23505" case.
  return { kind: "conflict", attempts: MAX_SAVE_ATTEMPTS };
}
