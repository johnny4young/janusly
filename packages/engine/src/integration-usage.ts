/**
 * Process-global recorder for integration-tool usage telemetry. Sister to
 * `email-usage.ts`: at process boot, the api + worker call
 * `setIntegrationUsageRecorder(recordIntegrationUsage)`. Each integration
 * tool (`slack.post`, `github.create_issue`, `webhook.send`, future
 * additions) fires the recorder fire-and-forget on every call — success
 * OR failure. Recorder failures are caught + dropped; telemetry must
 * never break a tool path.
 *
 * The DB write lives in
 * `packages/data/src/usageRepo.ts:recordIntegrationUsage`. This module is
 * the seam that lets `packages/engine` stay DB-agnostic for tools — zero
 * `@janusly/db` imports.
 *
 * The recorder writes a `usage_events` row with `metric: "tool.<name>"`
 * (e.g. `tool.slack.post`) + structured metadata
 * (credentialName, ok/error, statusCode, latencyMs, nodeId, workflowId).
 * The existing `getUsageBreakdown` aggregator picks these rows up
 * automatically — operators see "12 tool.slack.post" alongside their
 * existing LLM totals with no UI change.
 *
 * Used by:
 * - `apps/api/src/index.ts` — boot path: `setIntegrationUsageRecorder(recordIntegrationUsage)`.
 * - `packages/engine/src/worker.ts` — boot path: same.
 * - `packages/engine/src/integration-tools.ts` — fires the recorder.
 *
 * Invariants:
 * - Multi-tenant scope: every record carries `orgId`. The fire helper
 *   skips the recorder when `orgId` is absent.
 * - The recorder is process-global; do not install one per request.
 * - The credentialName field is the operator-friendly name (e.g.
 *   "incidents-slack"), NOT the secret-ref env-var name. Never log or
 *   write the secret-ref through this path.
 */

export type IntegrationUsageRecord = {
  /** Multi-tenant scope. Required. */
  orgId: string;
  /** Stable identifier for the tool that fired (e.g. "slack.post"). */
  tool: string;
  /** Operator-friendly credential name. NEVER the env-var name. */
  credentialName: string;
  /** Workflow run id when the tool fired from a `tool` node. */
  runId?: string;
  /** Workflow node id when the tool fired from a `tool` node. */
  nodeId?: string;
  /** Saved-workflow id (for the `?breakdown=workflow` axis). */
  workflowId?: string;
  ok: boolean;
  /** Upstream HTTP status when relevant (Slack/GitHub/webhook response). */
  statusCode?: number;
  /** Set when `ok === false`. Mirrors the AI-fallback contract for write-side tools. */
  error?: string;
  /** Wall-clock latency from the tool's POV (ms). */
  latencyMs: number;
};

/** Sync or async — the tool awaits the returned promise inside its own try/catch. */
export type IntegrationUsageRecorder = (record: IntegrationUsageRecord) => void | Promise<void>;

let recorder: IntegrationUsageRecorder | null = null;

/** Register the process-global integration-usage recorder. Pass `null` to disable. */
export function setIntegrationUsageRecorder(fn: IntegrationUsageRecorder | null): void {
  recorder = fn;
}

/** Inspect the currently registered recorder. */
export function getIntegrationUsageRecorder(): IntegrationUsageRecorder | null {
  return recorder;
}

/** Reset the registry. Tests that mutate it between cases call this. */
export function _resetIntegrationUsageRecorderForTests(): void {
  recorder = null;
}
