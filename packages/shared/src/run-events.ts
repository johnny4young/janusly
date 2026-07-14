/**
 * Cross-process catalogue of the lifecycle event types the engine writes to
 * `run_events.type`. Lives in `@janusly/shared` (zero runtime deps) so BOTH the
 * engine (which emits them) and the web (which localises them) can reference
 * one source of truth — the same split as `sensitive-keys.ts`.
 *
 * Used by:
 * - `packages/engine/src/core/events.ts` re-exports these; the runtime emits
 *   them via `workflowEvent()` / `appendEvent()`.
 * - `apps/web/src/i18n/server-events.test.ts` asserts every member has a
 *   `runEvents.<type>` label in both the `en` and `es` catalogs, so no
 *   lifecycle event ever renders as a raw type string on the run timeline.
 *
 * Invariant: adding a member here is a cross-process contract change — it must
 * gain a localized label in every locale catalog (the contract test enforces
 * this) and, if the web renders it specially, a consumer update.
 */

/** Closed catalogue of lifecycle event types the runtime emits to `run_events`. */
export const WORKFLOW_EVENT_TYPES = [
  "run.started",
  "run.succeeded",
  "run.failed",
  "run.cancelled",
  "node.queued",
  "node.running",
  "node.retry",
  "node.waiting",
  "node.resumed",
  "node.succeeded",
  "node.failed",
  "node.skipped",
  "decision.made",
  "agent.memory.recalled",
  "improvement.evaluated",
  "rollback.triggered",
  "rollback.completed",
  "run.status_checked",
] as const;

/** Union of the lifecycle event-type strings. */
export type WorkflowEventType = (typeof WORKFLOW_EVENT_TYPES)[number];
