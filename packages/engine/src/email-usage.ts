/**
 * Process-global recorder for `email.send` usage telemetry. Mirrors
 * the LLM-side `usage-recorder.ts` pattern: at process boot, the
 * api + worker call `setEmailUsageRecorder(recordEmailUsage)`. The
 * `email.send` tool fires the registered function fire-and-forget on
 * every send (success OR failure). Recorder failures are caught and
 * dropped — telemetry must never break a tool call.
 *
 * The DB write lives in `packages/data/src/usageRepo.ts:recordEmailUsage`.
 * This module is the seam that lets `packages/engine` stay DB-agnostic
 * for tools — zero `@janusly/db` imports.
 *
 * The recorder writes a `usage_events` row with `metric: "email.sent"`
 * + structured metadata (provider, providerMessageId, ok/error,
 * latencyMs, nodeId, workflowId). The existing
 * `getUsageBreakdown` aggregator picks these rows up automatically
 * — operators see "12 emails sent" alongside "12345 llm.completion"
 * with NO UI change.
 *
 * Used by:
 * - `apps/api/src/index.ts` — boot path: `setEmailUsageRecorder(recordEmailUsage)`.
 * - `packages/engine/src/worker.ts` — boot path: same.
 * - `packages/engine/src/tool-registry.ts:email.send` — fires the recorder.
 *
 * Invariants:
 * - Multi-tenant scope: every record carries `orgId`. The chokepoint
 *   skips the recorder when `orgId` is absent.
 * - The recorder is process-global; do not install one per request.
 */

export type EmailUsageRecord = {
  /** Multi-tenant scope. Required. */
  orgId: string;
  /** Workflow run id when the send fired from a `tool` node. Optional for ad-hoc paths. */
  runId?: string;
  /** Workflow node id when the send fired from a `tool` node. */
  nodeId?: string;
  /** Saved-workflow id (for the `?breakdown=workflow` axis). */
  workflowId?: string;
  /** Recipient address (rendered with the tool's `to` input). */
  to: string;
  /** Sender address (final value after the JANUSLY_MAILER_FROM fallback). */
  from: string;
  provider: "resend" | "sendgrid" | "simulator" | "noop";
  /** Set when `ok === true`. */
  providerMessageId?: string;
  ok: boolean;
  /** Set when `ok === false`. */
  error?: string;
  /** Wall-clock latency from the tool's POV (ms). */
  latencyMs: number;
};

/** Sync or async — the tool awaits the returned promise inside its own try/catch. */
export type EmailUsageRecorder = (record: EmailUsageRecord) => void | Promise<void>;

let recorder: EmailUsageRecorder | null = null;

/** Register the process-global email-usage recorder. Pass `null` to disable. */
export function setEmailUsageRecorder(fn: EmailUsageRecorder | null): void {
  recorder = fn;
}

/** Inspect the currently registered recorder. */
export function getEmailUsageRecorder(): EmailUsageRecorder | null {
  return recorder;
}

/** Reset the registry. Tests that mutate it between cases call this. */
export function _resetEmailUsageRecorderForTests(): void {
  recorder = null;
}
