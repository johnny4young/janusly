/**
 * The single decision table for "a run wants to start but the workflow is
 * paused" — one place where the per-entry-point asymmetry is DELIBERATE and
 * documented, instead of three call sites re-deriving it:
 *
 * - `start` (operator/API): REJECT with the code that names the actual pause
 *   cause. Reporting a breaker pause as `upstream_degraded` sends the
 *   operator to check a status page for an outage that isn't there.
 * - `trigger` (inbound webhook/email/MCP event): BUFFER. The upstream system
 *   already committed the event and will never re-send it — dropping it
 *   trades a run flood for silent data loss. Parked as `buffered`, replayed
 *   by the resume backfill.
 * - `schedule` (cron tick): DROP, loudly. "The 3am run" means nothing at
 *   6am, and replaying hours of ticks on resume is a thundering herd — the
 *   opposite of what pausing was for. The next scheduled fire after resume
 *   is the correct next run.
 *
 * Fail-open on an unresolvable status (`null`/`undefined` → proceed): an
 * unreadable workflow row is not evidence of a pause, and failing closed
 * would strand an org's events behind a hiccuping read.
 *
 * Used by: `apps/api/src/routes/runs-routes.ts` (/start),
 * `apps/api/src/routes/trigger-ingest-routes.ts` (ingest),
 * `packages/engine/src/schedule-scheduler.ts` (cron fire). A NEW run entry
 * point (SDK write path, replay campaigns, MCP direct) must consume this
 * table rather than re-deriving the asymmetry — that is the whole point.
 */

import { WORKFLOW_STATUS_PAUSED_CIRCUIT_BREAKER } from "./circuitBreakerRepo";
import { WORKFLOW_STATUS_ACTIVE } from "./upstreamHealthSourcesRepo";

/** Where the run attempt is coming from. */
export type RunEntryPoint = "start" | "trigger" | "schedule";

/** What the entry point must do about the workflow's current status. */
export type WorkflowPauseAction =
  | { kind: "proceed" }
  | { kind: "reject"; code: "workflow_circuit_breaker_paused" | "upstream_degraded"; status: string }
  | { kind: "buffer"; reason: string }
  | { kind: "drop"; reason: string };

/**
 * Resolve the action for one run attempt. Pure — the caller supplies the
 * status it already read (or null when the read failed / row is gone).
 */
export function resolveWorkflowPauseAction(
  status: string | null | undefined,
  entryPoint: RunEntryPoint,
): WorkflowPauseAction {
  if (!status || status === WORKFLOW_STATUS_ACTIVE) return { kind: "proceed" };

  switch (entryPoint) {
    case "start":
      return {
        kind: "reject",
        code: status === WORKFLOW_STATUS_PAUSED_CIRCUIT_BREAKER
          ? "workflow_circuit_breaker_paused"
          : "upstream_degraded",
        status,
      };
    case "trigger":
      return { kind: "buffer", reason: status };
    case "schedule":
      return { kind: "drop", reason: status };
  }
}
