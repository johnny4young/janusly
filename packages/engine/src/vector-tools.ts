/**
 * Vector memory tools — expose the org-scoped pgvector memory substrate as
 * workflow `tool` nodes so a workflow can store and semantically recall its
 * own text (a "vector store" / RAG primitive).
 *
 * Used by:
 * - `packages/engine/src/tool-registry.ts` — registers the public
 *   `vector.search` and `vector.upsert` tools.
 *
 * Invariants:
 * - Multi-tenant boundary is `executionContext.orgId`; the substrate
 *   (`commitMemory` / `recallMemory`) scopes every read/write by org.
 * - Both wrap the SAME substrate the recovery-recall path uses and never
 *   bypass its two-flag consent (`JANUSLY_MEMORY_ENABLED` + per-tenant
 *   `org_configs.memory.enabled` + `memory.allowedKinds`): when memory is
 *   off (the default), `vector.upsert` returns
 *   `{ ok: false, error: "memory_disabled" }` and `vector.search` returns
 *   an empty result — neither throws.
 * - Tool-written vectors use a dedicated `workflow_vector` kind so operator
 *   data stays isolated from the recovery substrate's internal kinds.
 * - The substrate already scrubs secrets (`scrubSecretShapes`), bounds
 *   payloads (`safePersistPayload`), and records `memory.commit` /
 *   `memory.recall` usage, so these tools add no telemetry of their own.
 * - Runtime failures return `{ ok: false, error, latencyMs }` envelopes and
 *   never throw, mirroring the tool / AI-fallback contract.
 */

import { z } from "zod";

import { commitMemory, getMemoryConfig, recallMemory } from "@janusly/data";
import { scrubSecretShapes } from "@janusly/shared/src/error-signature";
import type { ToolExecutionContext } from "./tool-registry";

/** Dedicated memory kind for operator/tool-written vectors — keeps them out of
 *  the recovery substrate's internal kinds (recovery_rationale, run_summary, …). */
const WORKFLOW_VECTOR_KIND = "workflow_vector" as const;
const DEFAULT_TOP_K = 8;
const MAX_TOP_K = 50;
const MAX_CONTENT_CHARS = 8192;

export const vectorSearchInput = z.object({
  /** Natural-language query; embedded server-side and matched by cosine similarity. */
  query: z.string().min(1).max(MAX_CONTENT_CHARS),
  /** Max matches to return (1..50, default 8); the tenant's `memory.recallMaxEntries` still caps the underlying recall. */
  topK: z.number().int().min(1).max(MAX_TOP_K).optional(),
});

const vectorMatchOutput = z.object({
  content: z.string(),
  similarity: z.number(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  createdAt: z.string(),
});

export const vectorSearchOutput = z.object({
  ok: z.boolean(),
  entries: z.array(vectorMatchOutput).optional(),
  error: z.string().optional(),
  latencyMs: z.number(),
});

export const vectorUpsertInput = z.object({
  /** Text to embed + store in the org's vector memory. */
  content: z.string().min(1).max(MAX_CONTENT_CHARS),
  /** Optional structured tags stored alongside the vector (bounded to 8 KB by the substrate). */
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const vectorUpsertOutput = z.object({
  ok: z.boolean(),
  id: z.string().optional(),
  error: z.string().optional(),
  latencyMs: z.number(),
});

export const vectorSearchTool = {
  name: "vector.search" as const,
  description: "Semantically search the org's vector memory store and return the closest stored entries.",
  inputSchema: vectorSearchInput,
  outputSchema: vectorSearchOutput,
  inputExample: { query: "customers likely to churn", topK: 5 },
  async execute(
    input: z.infer<typeof vectorSearchInput>,
    _context: Record<string, unknown>,
    executionContext: ToolExecutionContext,
  ): Promise<z.infer<typeof vectorSearchOutput>> {
    const start = Date.now();
    const orgId = executionContext.orgId;
    if (!orgId) {
      return { ok: false, error: "vector.search requires multi-tenant context", latencyMs: Date.now() - start };
    }
    try {
      if (!(await isWorkflowVectorKindAllowed(orgId))) {
        return { ok: true, entries: [], latencyMs: Date.now() - start };
      }
      const { entries } = await recallMemory({ orgId, kind: WORKFLOW_VECTOR_KIND, query: input.query });
      const topK = input.topK ?? DEFAULT_TOP_K;
      const shaped = entries.slice(0, topK).map((entry) => ({
        content: entry.content,
        similarity: entry.similarity,
        metadata: entry.metadata,
        createdAt: entry.createdAt.toISOString(),
      }));
      return { ok: true, entries: shaped, latencyMs: Date.now() - start };
    } catch (err) {
      return { ok: false, error: safeError(err), latencyMs: Date.now() - start };
    }
  },
};

export const vectorUpsertTool = {
  name: "vector.upsert" as const,
  description: "Embed and store a text value in the org's vector memory store for later semantic recall.",
  inputSchema: vectorUpsertInput,
  outputSchema: vectorUpsertOutput,
  inputExample: { content: "Customer cus_123 churned after a failed payment", metadata: { customerId: "cus_123" } },
  writeSide: true as const,
  async execute(
    input: z.infer<typeof vectorUpsertInput>,
    _context: Record<string, unknown>,
    executionContext: ToolExecutionContext,
  ): Promise<z.infer<typeof vectorUpsertOutput>> {
    const start = Date.now();
    const orgId = executionContext.orgId;
    if (!orgId) {
      return { ok: false, error: "vector.upsert requires multi-tenant context", latencyMs: Date.now() - start };
    }
    try {
      const result = await commitMemory({
        orgId,
        runId: executionContext.runId,
        workflowId: executionContext.workflowId,
        kind: WORKFLOW_VECTOR_KIND,
        content: input.content,
        metadata: input.metadata,
      });
      if (result.ok) {
        return { ok: true, id: result.entryId, latencyMs: Date.now() - start };
      }
      // The CommitMemoryError union is a closed set of codes (memory_disabled /
      // kind_disabled / embedding_failed / content_empty / …) — safe to surface
      // verbatim so a workflow can branch on `ok` / `error`.
      return { ok: false, error: result.error, latencyMs: Date.now() - start };
    } catch (err) {
      return { ok: false, error: safeError(err), latencyMs: Date.now() - start };
    }
  },
};

async function isWorkflowVectorKindAllowed(orgId: string): Promise<boolean> {
  try {
    const config = await getMemoryConfig(orgId);
    return config.allowedKinds.has(WORKFLOW_VECTOR_KIND);
  } catch {
    return false;
  }
}

/** Defense-in-depth for the unexpected-throw path (the substrate is designed to
 *  return envelopes, not throw): scrub secret shapes and bound the message. */
function safeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : "vector memory operation failed";
  const withoutUrls = raw.replace(/postgres(?:ql)?:\/\/\S+/gi, "[REDACTED]");
  const scrubbed = scrubSecretShapes(withoutUrls).trim();
  return scrubbed ? scrubbed.slice(0, 300) : "vector memory operation failed";
}
