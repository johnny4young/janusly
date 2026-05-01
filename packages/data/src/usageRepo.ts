/**
 * `usage_events` write path for ENG-012. The single chokepoint registered
 * as the `LlmClient` recorder via `setUsageRecorder(recordUsage)` at api +
 * worker boot; every successful or failed LLM call lands one row here.
 *
 * The schema is intentionally generic: `metric` + `quantity` for fast
 * aggregation (already used by `getUsageSummary` from ENG-004), `metadata`
 * jsonb for everything provider/model/cost-specific. Writing rows with
 * `metric: "llm.completion"` + `quantity: totalTokens` makes the existing
 * billing dashboard (`GET /billing/usage` → web "Usage summary" card) light
 * up automatically without UI changes.
 *
 * Used by:
 * - `apps/api/src/index.ts` — boot path: `setUsageRecorder(recordUsage)`.
 * - `packages/engine/src/worker.ts` — boot path: `setUsageRecorder(recordUsage)`.
 *
 * Invariants:
 * - Multi-tenant scope: `orgId` is always set explicitly from the record.
 * - The chokepoint in `packages/ai/src/llm-client.ts` already wraps this in
 *   try/catch. This function may throw (DB failures); they're caught and
 *   dropped upstream because telemetry must never break an LLM call.
 */

import { db, usageEvents } from "@janusly/db";
import type { UsageRecord } from "@janusly/ai";

export async function recordUsage(record: UsageRecord): Promise<void> {
  await db.insert(usageEvents).values({
    id: crypto.randomUUID(),
    orgId: record.orgId,
    userId: record.userId ?? null,
    runId: record.runId ?? null,
    metric: "llm.completion",
    quantity: record.totalTokens ?? 0,
    metadata: {
      provider: record.provider,
      model: record.model,
      inputTokens: record.inputTokens ?? null,
      outputTokens: record.outputTokens ?? null,
      latencyMs: record.latencyMs,
      costUsd: record.costUsd ?? null,
      nodeId: record.nodeId ?? null,
      mode: record.mode,
      aiError: record.aiError ?? null,
    },
  });
}
