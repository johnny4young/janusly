/**
 * Workflow event type catalogue + builder. The runtime emits these strings
 * from `core/runtime.ts` and `node-registry.ts`; the web's run timeline +
 * Multi-agent timeline parse them downstream.
 *
 * Used by `core/runtime.ts`, `node-registry.ts`, `start-run.ts`, and the web
 * panels that consume `run_events.type`.
 *
 * Invariants:
 * - Event-type strings are part of the cross-process contract. Renaming any
 *   string here means updating the web consumers (`MultiAgentTimeline.tsx`,
 *   `eventUtils.ts`) and any downstream analytics that filter on them.
 * - Every member must have a matching `runEvents.<type>` label in the web i18n
 *   catalog (both `en` and `es`); `server-events.test.ts` asserts this union is
 *   fully covered so no lifecycle event renders as a raw type string.
 * - Most members are emitted via `workflowEvent()` from `core/runtime.ts`, but
 *   the run-level ones (`run.*`) and `node.resumed` are appended directly via
 *   `appendEvent()` in `start-run.ts` / `persistence-ports/event.ts` /
 *   `resume-run.ts`.
 */

import type { WorkflowEvent } from "./types";

// The catalogue + union live in `@janusly/shared` (zero-dep) so the web can
// reference the same source of truth without depending on the engine. Re-export
// here so engine-internal consumers keep importing from `./events`.
export { WORKFLOW_EVENT_TYPES, type WorkflowEventType } from "@janusly/shared/src/run-events";
import type { WorkflowEventType } from "@janusly/shared/src/run-events";

/** Build a `WorkflowEvent` with a fresh timestamp and defaulted `payload`. */
export function workflowEvent(input: {
  runId: string;
  nodeId?: string;
  type: WorkflowEventType;
  payload?: unknown;
}): WorkflowEvent {
  return {
    runId: input.runId,
    nodeId: input.nodeId,
    type: input.type,
    payload: input.payload ?? {},
    timestamp: new Date(),
  };
}

/** Current time as an ISO-8601 string — used in event payload bodies. */
export function nowIso() {
  return new Date().toISOString();
}
