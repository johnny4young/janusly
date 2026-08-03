/**
 * Process-global recorder for LLM usage telemetry. The DB write
 * lives in `packages/data/src/usageRepo.ts`; this module is the seam that
 * lets `packages/ai` stay DB-agnostic — zero `@janusly/db` imports.
 *
 * At boot, the api + worker processes call `setUsageRecorder(recordUsage)`.
 * `LlmClient.generateText` (in `./llm-client.ts`) fires the registered
 * function fire-and-forget on every successful AND failed call. Recorder
 * failures are caught and dropped — usage telemetry must never break an
 * LLM call (AGENTS.md fallback contract).
 *
 * Used by:
 * - `apps/api/src/index.ts` — boots `setUsageRecorder(recordUsage)`.
 * - `packages/engine/src/worker.ts` — boots `setUsageRecorder(recordUsage)`.
 * - `packages/ai/src/llm-client.ts` — fires the registered recorder.
 *
 * Invariants:
 * - Multi-tenant scope: every record carries `orgId`. The chokepoint skips
 *   firing the recorder when `orgId` is absent (unit tests + adhoc paths).
 * - The recorder is process-global; do not install one per request.
 * - Don't import this from `packages/ai` itself in a way that creates a
 *   reverse dependency on the abstraction.
 */

/** One row's worth of usage telemetry. The shape is the wire contract
 * between `packages/ai` (producer) and `packages/data` (writer). */
export type UsageRecord = {
  /** Multi-tenant scope. Required. */
  orgId: string;
  userId?: string;
  runId?: string;
  nodeId?: string;
  /**
   * Workflow id when the LLM call is attributable to a saved workflow.
   * Populated by `/ai/*` routes that already have the workflow id in
   * scope (explain, review, suggest-improvement, patch) and by the
   * engine's `ai`/`agent` node executors via `getRunMetadata`.
   * `/ai/generate-workflow` leaves this absent — the workflow doesn't
   * exist yet at LLM-call time.
   */
  workflowId?: string;
  /** Registry key from `LlmGenerateTextResult.provider` (e.g. "openai"). */
  provider: string;
  /** Resolved model id (e.g. "gpt-4o-mini"). */
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Input tokens served from a provider prompt cache. */
  cachedInputTokens?: number;
  /** Input tokens written while creating or refreshing a provider cache. */
  cacheCreationInputTokens?: number;
  /** Wall-clock latency from the abstraction's POV (ms). */
  latencyMs: number;
  /** Cost in USD; null when no price entry exists for the model. */
  costUsd?: number | null;
  /** Explicit provider-compatible simulator; never bill its token usage. */
  providerSimulated: boolean;
  /** "ai" on success, "fallback" when the underlying call threw. */
  mode: "ai" | "fallback";
  /** Set when mode === "fallback". */
  aiError?: string;
};

/** Function shape: called once per LLM attempt. Sync or async — the
 * chokepoint awaits the returned promise inside its own try/catch. */
export type UsageRecorder = (record: UsageRecord) => void | Promise<void>;

let recorder: UsageRecorder | null = null;

/** Register the process-global recorder. Pass `null` to disable. */
export function setUsageRecorder(fn: UsageRecorder | null): void {
  recorder = fn;
}

/** Inspect the currently registered recorder. */
export function getUsageRecorder(): UsageRecorder | null {
  return recorder;
}

/** Reset the registry. Tests that mutate it between cases call this. */
export function _resetUsageRecorderForTests(): void {
  recorder = null;
}
