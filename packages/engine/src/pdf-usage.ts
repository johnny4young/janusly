/**
 * Process-global recorder for `pdf.generate` usage telemetry. Sister to
 * `email-usage.ts` and `integration-usage.ts`. At process boot, the api
 * + worker call `setPdfUsageRecorder(recordPdfUsage)`. The `pdf.generate`
 * tool fires the registered function fire-and-forget on every call —
 * success OR failure. Recorder failures are caught and dropped:
 * telemetry must never break a tool path.
 *
 * The DB write lives in `packages/data/src/usageRepo.ts:recordPdfUsage`.
 * This module is the seam that lets `packages/engine` stay DB-agnostic
 * for tools — zero `@janusly/db` imports.
 *
 * The recorder writes a `usage_events` row with `metric: "pdf.generated"`
 * and `quantity` set to the produced PDF's byte length (or 0 on failure)
 * + structured metadata (provider, ok/error, latencyMs, nodeId,
 * workflowId, key). The existing `getUsageBreakdown` aggregator picks
 * these rows up automatically — operators see "12 pdf.generated"
 * alongside email + LLM totals with no UI change.
 *
 * Used by:
 * - `apps/api/src/index.ts` — boot path: `setPdfUsageRecorder(recordPdfUsage)`.
 * - `packages/engine/src/worker.ts` — boot path: same.
 * - `packages/engine/src/tool-registry.ts:pdf.generate` — fires the recorder.
 *
 * Invariants:
 * - Multi-tenant scope: every record carries `orgId`. The chokepoint
 *   skips the recorder when `orgId` is absent.
 * - The recorder is process-global; do not install one per request.
 * - The `key` field is the per-org-prefixed object key (e.g.
 *   `orgs/<orgId>/pdfs/...`), NOT a presigned or public URL — keep the
 *   recorder DB-agnostic by passing the key only.
 */

export type PdfUsageRecord = {
  /** Multi-tenant scope. Required. */
  orgId: string;
  /** Workflow run id when the call fired from a `tool` node. Optional for ad-hoc paths. */
  runId?: string;
  /** Workflow node id when the call fired from a `tool` node. */
  nodeId?: string;
  /** Saved-workflow id (for the `?breakdown=workflow` axis). */
  workflowId?: string;
  /** Object-store provider that handled the upload. */
  provider: "s3" | "local" | "noop";
  /** Per-org-prefixed object key. Set on success. */
  key?: string;
  /** Produced PDF size in bytes. `0` on failure. */
  contentLength: number;
  ok: boolean;
  /** Set when `ok === false`. Mirrors the AI-fallback contract for write-side tools. */
  error?: string;
  /** Wall-clock latency from the tool's POV (ms). */
  latencyMs: number;
};

/** Sync or async — the tool awaits the returned promise inside its own try/catch. */
export type PdfUsageRecorder = (record: PdfUsageRecord) => void | Promise<void>;

let recorder: PdfUsageRecorder | null = null;

/** Register the process-global pdf-usage recorder. Pass `null` to disable. */
export function setPdfUsageRecorder(fn: PdfUsageRecorder | null): void {
  recorder = fn;
}

/** Inspect the currently registered recorder. */
export function getPdfUsageRecorder(): PdfUsageRecorder | null {
  return recorder;
}

/** Reset the registry. Tests that mutate it between cases call this. */
export function _resetPdfUsageRecorderForTests(): void {
  recorder = null;
}
