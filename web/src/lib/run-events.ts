/**
 * Cross-process catalogue of the lifecycle event types the engine writes to
 * `run_events.type`. Lives in `src/lib` (zero runtime deps) so BOTH the
 * engine (which emits them) and the web (which localises them) can reference
 * one source of truth — the same split as `sensitive-keys.ts`.
 *
 * Used by:
 * - The workflow runtime emits
 *   them via `workflowEvent()` / `appendEvent()`.
 * - `web/src/i18n/server-events.test.ts` asserts every member has a
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
  "node.transient_retry",
  "node.waiting",
  "node.resumed",
  "node.succeeded",
  "node.failed",
  "node.skipped",
  "node.subworkflow.started",
  "node.subworkflow.completed",
  "node.subworkflow.failed",
  "node.subworkflow.reattached",
  "loop.for_each.started",
  "loop.failure_budget.exceeded",
  "loop.completed",
  "run.reopened",
  "parent.notify.failed",
  "decision.made",
  "agent.memory.recalled",
  "agent.reasoning",
  "improvement.evaluated",
  "rollback.triggered",
  "rollback.completed",
  "run.status_checked",
] as const;

/** Per-field caps for the stable operator-facing agent rationale contract. */
export const AGENT_REASONING_AGENT_MAX_CHARS = 120;
export const AGENT_REASONING_SCOPE_MAX_CHARS = 160;
export const AGENT_REASONING_TOOL_MAX_CHARS = 160;
export const AGENT_REASONING_REASON_MAX_CHARS = 500;

/**
 * Stable operator-facing projection of an agent planning decision. It is an
 * operational rationale, not hidden chain-of-thought: no prompt context,
 * tool input/output, memory content, final answer, or provider error belongs
 * in this payload.
 */
export type AgentReasoningEventPayload = {
  agent: string;
  iteration: number;
  planner: "rules" | "ai";
  mode: "rules" | "ai" | "fallback";
  scope: string;
  /** Exact legacy `*.step.planned` event replaced by this safe projection. */
  replacesEventId: string;
  decision: "finish" | "use_tool";
  tool: string | null;
  reason: string;
};
