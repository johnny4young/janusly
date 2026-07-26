/**
 * Shared concurrency policy for API operations that append workflow versions.
 *
 * Used by: `workflows-save.ts` and `workflows-rollback.ts`.
 *
 * Both operations allocate `max(version) + 1` under the same unique index.
 * They must classify the same Postgres race and use the same bounded retry
 * budget so one authoring path cannot degrade to an avoidable 500.
 */

/** Maximum transaction attempts, including the first allocation attempt. */
export const MAX_VERSION_WRITE_ATTEMPTS = 3;

/** Version appends are blocked while a deployment is actively splitting traffic. */
export class ActiveWorkflowRolloutError extends Error {
  constructor() {
    super("Workflow has an active rollout");
    this.name = "ActiveWorkflowRolloutError";
  }
}

const PG_UNIQUE_VIOLATION = "23505";
const RETRYABLE_VERSION_WRITE_CONSTRAINTS: ReadonlySet<string> = new Set([
  "workflow_versions_org_workflow_version_idx",
  "workflows_pkey",
]);

/**
 * Return true for the unique-constraint races an append-version retry can
 * safely resolve. Drizzle may wrap the driver error in nested `cause` values,
 * so the classifier walks a short, cycle-safe chain.
 */
export function isRetryableVersionWriteViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const candidates: object[] = [];
  const seen = new WeakSet<object>();
  let cursor: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (!cursor || typeof cursor !== "object" || seen.has(cursor)) break;
    seen.add(cursor);
    candidates.push(cursor);
    const next = (cursor as { cause?: unknown }).cause;
    if (!next || next === cursor) break;
    cursor = next;
  }

  for (const candidate of candidates) {
    const record = candidate as {
      code?: unknown;
      constraint?: unknown;
      constraint_name?: unknown;
    };
    if (record.code !== PG_UNIQUE_VIOLATION) continue;
    const constraint = typeof record.constraint === "string"
      ? record.constraint
      : typeof record.constraint_name === "string"
        ? record.constraint_name
        : null;

    // Some driver wrappers omit the constraint name. The append-version
    // transactions generate fresh primary keys and touch no other plausible
    // unique surface, so an otherwise unqualified 23505 is safe to retry.
    return constraint === null || RETRYABLE_VERSION_WRITE_CONSTRAINTS.has(constraint);
  }
  return false;
}
