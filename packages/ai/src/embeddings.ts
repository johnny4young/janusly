/**
 * Provider-neutral embeddings surface for Janusly's memory substrate.
 *
 * The v1 wired provider is self-hosted Ollama (bge-m3, 1024-dim).
 * Operators select a different provider via `JANUSLY_EMBEDDING_PROVIDER`
 * env or the per-tenant `org_configs.memory.embeddingProvider` row;
 * additional providers (Voyage, OpenAI) are listed in the catalog
 * `allowedValues` for future operator-configurable wire-up without code
 * changes. The memory policy documents the v1 posture and the DPA
 * implications of swapping providers.
 *
 * Used by:
 * - `packages/data/src/memoryEntriesRepo.ts` — `commitMemory` (embed the
 *   content before insert) and `recallMemory` (embed the query before
 *   the pgvector similarity scan).
 *
 * Invariants:
 * - Failures NEVER throw — every error becomes
 *   `{ ok: false, error: <stable code>, latencyMs }`. Memory callers
 *   degrade to empty recall + a warn audit, mirroring the AGENTS.md
 *   AI-fallback contract.
 * - The Ollama base URL is operator-supplied infrastructure config
 *   (env `OLLAMA_BASE_URL`, defaults to `http://ollama:11434` inside
 *   Compose). Workflow-author content NEVER influences the URL —
 *   only the embedding text body. This is why the Ollama call bypasses
 *   the `fetchHttpTarget` SSRF guard: the same posture the
 *   `engine/object-store.ts` S3Provider uses for its operator-supplied
 *   bucket endpoint.
 * - The returned `dimension` is read from the response array length,
 *   NOT from env or the catalog. Memory callers validate the dimension
 *   before persistence so a model mismatch cannot silently store a
 *   wrong-shape vector.
 */

export type EmbeddingResult =
  | {
      ok: true;
      embedding: number[];
      provider: string;
      model: string;
      dimension: number;
      latencyMs: number;
    }
  | {
      ok: false;
      error: string;
      latencyMs: number;
    };

export type EmbeddingOptions = {
  /** Override env-resolved provider for this call. */
  provider?: string;
  /** Override env-resolved model for this call. */
  model?: string;
  /** Override env-resolved base URL for this call. */
  baseUrl?: string;
  /** Override env-resolved timeout. */
  timeoutMs?: number;
};

const DEFAULT_PROVIDER = "ollama";
const DEFAULT_OLLAMA_MODEL = "bge-m3";
const DEFAULT_OLLAMA_BASE_URL = "http://ollama:11434";
const DEFAULT_TIMEOUT_MS = 30_000;

function resolveProvider(opts: EmbeddingOptions, env: NodeJS.ProcessEnv): string {
  return opts.provider || env.JANUSLY_EMBEDDING_PROVIDER || DEFAULT_PROVIDER;
}

function resolveModel(opts: EmbeddingOptions, env: NodeJS.ProcessEnv): string {
  return opts.model || env.JANUSLY_EMBEDDING_MODEL || DEFAULT_OLLAMA_MODEL;
}

function resolveOllamaBaseUrl(opts: EmbeddingOptions, env: NodeJS.ProcessEnv): string {
  const raw = (opts.baseUrl || env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL).trim();
  // Strip a trailing slash so we can append /api/embeddings unconditionally.
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function resolveTimeoutMs(opts: EmbeddingOptions, env: NodeJS.ProcessEnv): number {
  if (opts.timeoutMs && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0) {
    return opts.timeoutMs;
  }
  const raw = env.JANUSLY_OLLAMA_TIMEOUT_MS ? Number(env.JANUSLY_OLLAMA_TIMEOUT_MS) : NaN;
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/**
 * Generate a single embedding for `text`. Pure-functional over `env` so
 * tests can inject a fake `process.env` without touching the real one;
 * callers that pass `opts` get per-call overrides.
 */
export async function generateEmbedding(
  text: string,
  opts: EmbeddingOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<EmbeddingResult> {
  const startedAt = Date.now();
  const provider = resolveProvider(opts, env);
  const model = resolveModel(opts, env);

  if (provider !== "ollama") {
    return {
      ok: false,
      error: `embedding_provider_not_wired:${provider}`,
      latencyMs: Date.now() - startedAt,
    };
  }

  const baseUrl = resolveOllamaBaseUrl(opts, env);
  const timeoutMs = resolveTimeoutMs(opts, env);
  const url = `${baseUrl}/api/embeddings`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: text }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return {
      ok: false,
      error: classifyFetchError(error),
      latencyMs: Date.now() - startedAt,
    };
  }

  if (!response.ok) {
    let body = "";
    try {
      body = (await response.text()).slice(0, 200);
    } catch {
      // body read failed; the status code is enough.
    }
    return {
      ok: false,
      error: `ollama_http_${response.status}${body ? `:${body}` : ""}`,
      latencyMs: Date.now() - startedAt,
    };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return {
      ok: false,
      error: "ollama_malformed_json",
      latencyMs: Date.now() - startedAt,
    };
  }

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { embedding?: unknown }).embedding)
  ) {
    return {
      ok: false,
      error: "ollama_missing_embedding",
      latencyMs: Date.now() - startedAt,
    };
  }

  const embedding = (parsed as { embedding: unknown[] }).embedding.map((value) =>
    typeof value === "number" ? value : Number(value),
  );
  if (!embedding.every(Number.isFinite)) {
    return {
      ok: false,
      error: "ollama_non_finite_values",
      latencyMs: Date.now() - startedAt,
    };
  }

  return {
    ok: true,
    embedding,
    provider,
    model,
    dimension: embedding.length,
    latencyMs: Date.now() - startedAt,
  };
}

function classifyFetchError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof DOMException && error.name === "TimeoutError") return "ollama_timeout";
  if (message.includes("ECONNREFUSED")) return "ollama_unreachable";
  if (message.includes("ENOTFOUND")) return "ollama_dns";
  return `ollama_fetch_error:${message.slice(0, 120)}`;
}
