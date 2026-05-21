/**
 * Process-global recorder for memory commit/recall telemetry. Cousin
 * of the engine-side `integration-usage.ts` / `mcp-usage.ts` seams,
 * lives in `packages/data` because `memoryEntriesRepo` (the consumer)
 * is also in `packages/data` — the engine never sees the embed/insert
 * chokepoint directly.
 *
 * At process boot, the api + worker call
 * `setMemoryUsageRecorder(recordMemoryUsage)` (the recorder
 * implementation in `usageRepo.ts`). Every `commitMemory` and
 * `recallMemory` call (success OR failure) fires the recorder
 * fire-and-forget. Recorder failures are caught + dropped; telemetry
 * must never break the memory path (mirrors the AI fallback contract).
 *
 * Used by:
 * - `apps/api/src/index.ts` — boot path: `setMemoryUsageRecorder(recordMemoryUsage)`.
 * - `packages/engine/src/worker.ts` — boot path: same.
 * - `packages/data/src/memoryEntriesRepo.ts` — fires the recorder.
 *
 * Invariants:
 * - Multi-tenant scope: every record carries `orgId`.
 * - The recorder is process-global; never install one per request.
 */

export type MemoryUsageMetric = "memory.commit" | "memory.recall";

export type MemoryUsageRecord = {
  /** Closed enum so dashboards can group quickly. */
  metric: MemoryUsageMetric;
  /** Multi-tenant scope. Required. */
  orgId: string;
  /** Memory kind, when known (commit always has it; recall optionally filters by it). */
  kind?: string;
  /** Provider that produced (or attempted to produce) the embedding. */
  embeddingProvider: string;
  /** Model id used. */
  embeddingModel: string;
  /** Dimension of the produced vector. `null` on failure. */
  embeddingDimension: number | null;
  /** Workflow run id when the call fired from a workflow consumer. */
  runId?: string;
  /** Saved-workflow id (for the `?breakdown=workflow` axis). */
  workflowId?: string;
  ok: boolean;
  /** Stable error code on the failure path (e.g. `memory_disabled`, `embedding_failed`). */
  error?: string;
  /** Wall-clock latency from the caller's POV (ms). */
  latencyMs: number;
};

/** Sync or async — the repo awaits the returned promise inside its own try/catch. */
export type MemoryUsageRecorder = (record: MemoryUsageRecord) => void | Promise<void>;

let recorder: MemoryUsageRecorder | null = null;

/** Register the process-global memory-usage recorder. Pass `null` to disable. */
export function setMemoryUsageRecorder(fn: MemoryUsageRecorder | null): void {
  recorder = fn;
}

/** Inspect the currently registered recorder. */
export function getMemoryUsageRecorder(): MemoryUsageRecorder | null {
  return recorder;
}

/** Reset the registry. Tests that mutate it between cases call this. */
export function _resetMemoryUsageRecorderForTests(): void {
  recorder = null;
}
