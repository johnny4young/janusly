/**
 * DI seam exposing a `workflow_metadata.severityDefault` lookup to the
 * engine package. Decouples `@janusly/engine` (which must not import
 * `@janusly/data` directly) from the api-side resolver that actually
 * reads the row.
 *
 * Production wiring lives in `apps/api/src/workflow-metadata-bootstrap.ts`
 * (and the worker process boot) which calls
 * `setRecoveryItemSeverityDefault(resolver)` once at startup. Mirror of
 * the `setRecoveryItemCreator` pattern from `recovery-item-creator.ts`.
 *
 * Invariants:
 *  - Never throws on the caller. A downstream failure (Postgres blip,
 *    missing row) returns null so the engine falls back to its hardcoded
 *    severity default.
 *  - When no resolver is registered the seam returns null — used by
 *    tests and by processes that boot without the metadata module.
 */

import type { RecoveryItemSeverity } from "@janusly/shared";

export type RecoveryItemSeverityDefaultResolver = (
  orgId: string,
  workflowId: string,
) => Promise<RecoveryItemSeverity | null>;

let resolver: RecoveryItemSeverityDefaultResolver | null = null;

/** Register the production resolver. Last write wins. */
export function setRecoveryItemSeverityDefault(
  r: RecoveryItemSeverityDefaultResolver | null,
): void {
  resolver = r;
}

/**
 * Look up the per-workflow severity default. Never throws — a failure
 * during the read degrades silently to null so the caller's hardcoded
 * default applies.
 */
export async function getRecoveryItemSeverityDefault(
  orgId: string,
  workflowId: string,
): Promise<RecoveryItemSeverity | null> {
  if (!resolver) return null;
  try {
    return await resolver(orgId, workflowId);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[recovery-item-severity-default] resolver threw", {
      err,
      orgId,
      workflowId,
    });
    return null;
  }
}
