/**
 * Provider-neutral LLM client — the single chokepoint every AI surface in
 * Janusly speaks through. Built on the Vercel AI SDK (`ai` + `@ai-sdk/*`)
 * so the call sites never name a vendor.
 *
 * Three concerns, in order:
 *   (a) PROVIDERS registry  — adding a new provider is a single record entry
 *                              with four required fields. No conditional on
 *                              the provider name lives anywhere else.
 *   (b) Public types        — `LlmClient`, `LlmGenerateTextInput/Result`,
 *                              `ResolvedLlmConfig` — what every caller sees.
 *   (c) Factory             — `resolveLlmConfig(env)` reads env vars,
 *                              `createLlmClient(cfg)` returns a bound client,
 *                              `getLlmClient()` is the memoised singleton.
 *
 * Used by:
 * - `packages/ai/src/runExplainer.ts` — `/ai/explain-run`.
 * - `apps/api/src/index.ts`           — `/ai/generate-workflow`,
 *                                        `/ai/explain-workflow`,
 *                                        `/ai/explain-run`.
 * - `packages/engine/src/agent-planner.ts` — `agent` planner `"openai"`.
 * - `packages/engine/src/node-registry.ts` — the `ai` step type.
 *
 * Invariants:
 * - The fallback contract (AGENTS.md) lives ABOVE this module: every caller
 *   wraps `generateText(...)` in try/catch and degrades to
 *   `{ mode: "fallback", aiError, ... }`. New error sources here (unknown
 *   provider, missing override key) intentionally throw so they flow through
 *   that same try/catch.
 * - `JANUSLY_LLM_PROVIDER` (default `"openai"`) selects the deploy-time
 *   default. Per-call overrides go through `modelHint` — bare model id uses
 *   the configured provider, `"<provider>/<model>"` overrides for that call.
 *   A non-default provider key is enough for explicit overrides to work even
 *   when the default provider key is absent.
 * - Test-only escapes (`_resetLlmClientForTests`,
 *   `_registerProviderForTests`, `_unregisterProviderForTests`) are
 *   intentionally underscore-prefixed; production code must never call them.
 */

import { generateText as aiGenerateText, Output, type LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { computeCostUsd, getModelPrice } from "./pricing";
import { getUsageRecorder, type UsageRecord } from "./usage-recorder";

// ─── (a) Provider registry ───────────────────────────────────────────────
//
// Adding a provider = one entry below. No conditionals elsewhere read the
// provider name. The four required fields are: which env vars hold the API
// key + model id, the default model when none is set, and a `create(apiKey)`
// closure that returns a `(modelId) => LanguageModel` factory bound to the
// API key. Optional `jsonModeOptions` returns provider-specific kwargs for
// `generateText` when JSON output is requested.

/** Shape of one entry in the `PROVIDERS` registry. */
export type ProviderSpec = {
  /** Env var that holds the API key. e.g. "OPENAI_API_KEY". */
  envApiKey: string;
  /** Env var that holds the override model id. e.g. "OPENAI_MODEL". */
  envModel: string;
  /** Default model id when `envModel` is unset. */
  defaultModel: string;
  /** Build a model factory bound to the given API key. */
  create: (apiKey: string) => (modelId: string) => LanguageModel;
  /** Optional: provider-specific JSON-mode wiring spread into `generateText` opts. */
  jsonModeOptions?: () => Record<string, unknown>;
};

const PROVIDERS: Record<string, ProviderSpec> = {
  openai: {
    envApiKey: "OPENAI_API_KEY",
    envModel: "OPENAI_MODEL",
    defaultModel: "gpt-4o-mini",
    create: (apiKey) => {
      const openai = createOpenAI({ apiKey });
      return (modelId) => openai(modelId);
    },
    jsonModeOptions: () => ({
      providerOptions: { openai: { responseFormat: { type: "json_object" } } },
    }),
  },
  anthropic: {
    envApiKey: "ANTHROPIC_API_KEY",
    envModel: "ANTHROPIC_MODEL",
    defaultModel: "claude-haiku-4-5-20251001",
    create: (apiKey) => {
      // Defensive baseURL handling: Claude Desktop sets a shell-wide
      // `ANTHROPIC_BASE_URL=https://api.anthropic.com` (without `/v1`) which
      // the SDK reads as-is, producing `/messages` 404s instead of
      // `/v1/messages`. Auto-append `/v1` when the env points at the
      // canonical host but is missing the version segment, so a stale
      // shell var doesn't quietly break the AI surface. Operators who
      // intentionally proxy elsewhere set their own URL with `/v1` and the
      // condition below leaves it alone.
      const envBaseURL = process.env.ANTHROPIC_BASE_URL?.trim();
      const needsV1 =
        envBaseURL &&
        /^https?:\/\/api\.anthropic\.com\/?$/i.test(envBaseURL);
      const baseURL = needsV1 ? "https://api.anthropic.com/v1" : undefined;
      const anthropic = createAnthropic(baseURL ? { apiKey, baseURL } : { apiKey });
      return (modelId) => anthropic(modelId);
    },
    // No jsonModeOptions — Anthropic relies on the prompt's "Output only JSON".
  },
  // Add a new provider here. e.g. ollama / mistral / google. Four fields.
};

// ─── (b) Public types ────────────────────────────────────────────────────

/** Input accepted by `LlmClient.generateText`. */
export type LlmGenerateTextInput = {
  /** Optional system prompt — combined with `prompt` per the AI SDK contract. */
  system?: string;
  /** User prompt body. Required. */
  prompt: string;
  /** Provider-agnostic JSON-mode hint. The registry maps it per provider. */
  responseFormat?: "json" | "text";
  /**
   * Override the env-resolved model (and optionally provider) for one call.
   * Two forms:
   *   - bare model id           — uses the configured provider, this model
   *   - `"<provider>/<model>"` — uses that provider with that model, ignoring
   *                              `JANUSLY_LLM_PROVIDER` for this one call
   */
  modelHint?: string;
  /**
   * Per-call context for usage telemetry. Optional so unit tests
   * and outside callers can omit it; in production every call site fills at
   * least `orgId` so the multi-tenant scope on `usage_events` holds. The
   * chokepoint silently skips firing the recorder when `orgId` is absent.
   */
  context?: {
    orgId: string;
    userId?: string;
    runId?: string;
    nodeId?: string;
  };
};

/** Provider-neutral result shape. */
export type LlmGenerateTextResult = {
  /** The generated text. Empty string when the model produced no text. */
  text: string;
  /** AI SDK's finish reason (`"stop" | "length" | …`). */
  finishReason?: string;
  /** Token usage (passthrough from the AI SDK; telemetry reads it). */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  /** Resolved provider name (registry key). Surfaced for telemetry. */
  provider: string;
  /** Resolved model id. */
  model: string;
  /** Wall-clock latency from the abstraction's POV (ms). */
  latencyMs: number;
  /** Cost in USD; null when no price entry exists for the model. */
  costUsd?: number | null;
};

/**
 * Input accepted by `LlmClient.generateObject`. Mirrors
 * `LlmGenerateTextInput` but locks the model output to a typed object that
 * conforms to `schema`. The provider's structured-output surface (OpenAI's
 * `response_format: json_schema`, Anthropic's tool-use trick) handles the
 * wire format, so the `responseFormat` JSON-mode hint isn't applicable.
 */
export type LlmGenerateObjectInput<T> = {
  /** Optional system prompt — combined with `prompt` per the AI SDK contract. */
  system?: string;
  /** User prompt body. Required. */
  prompt: string;
  /** Required Zod schema (or any `FlexibleSchema`) the model must conform to. */
  schema: Parameters<typeof Output.object<T>>[0]["schema"];
  /** Optional name surfaced to the model for some providers' guidance. */
  schemaName?: string;
  /** Optional description surfaced to the model for some providers' guidance. */
  schemaDescription?: string;
  /** Same `bare-id` or `"<provider>/<model>"` semantics as `generateText`. */
  modelHint?: string;
  /** Same telemetry context shape used by `generateText`. */
  context?: {
    orgId: string;
    userId?: string;
    runId?: string;
    nodeId?: string;
  };
};

/** Result of `LlmClient.generateObject<T>`. */
export type LlmGenerateObjectResult<T> = {
  /** The typed, schema-validated object the model emitted. */
  object: T;
  /** AI SDK's finish reason (`"stop" | "length" | …`). */
  finishReason?: string;
  /** Token usage (passthrough from the AI SDK). */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  /** Resolved provider name (registry key). */
  provider: string;
  /** Resolved model id. */
  model: string;
  /** Wall-clock latency from the abstraction's POV (ms). */
  latencyMs: number;
  /** Cost in USD; null when no price entry exists for the model. */
  costUsd?: number | null;
};

/** The single capability every AI surface depends on. */
export type LlmClient = {
  generateText(input: LlmGenerateTextInput): Promise<LlmGenerateTextResult>;
  /**
   * Schema-aware generation. The model is asked to emit an object
   * that conforms to `input.schema`; the AI SDK's `Output.object()` plumbs
   * the JSON Schema through each provider's structured-output capability and
   * validates the response. Throws when the model emits something the schema
   * rejects — caller's outer try/catch maps to `{ mode: "fallback", aiError }`
   * (AGENTS.md fallback contract).
   */
  generateObject<T>(input: LlmGenerateObjectInput<T>): Promise<LlmGenerateObjectResult<T>>;
};

/** Output of `resolveLlmConfig` — fully-defaulted, provider-agnostic. */
export type ResolvedLlmConfig = {
  /** Default provider name (registry key). */
  provider: string;
  /** API keys per provider — only the ones with a configured env key are present. */
  apiKeys: Record<string, string>;
  /** Default model per provider (env override or registry default). */
  defaultModels: Record<string, string>;
  /** Single timeout shared across providers. */
  timeoutMs: number;
  /** AI SDK-built-in retry on rate-limit + 5xx. */
  maxRetries: number;
};

// ─── (c) Factory ─────────────────────────────────────────────────────────

/**
 * Read every registered provider's env vars. Returns `null` only when no
 * registered provider has an API key — every AI surface still falls back to
 * its deterministic path. If only a non-default provider has a key, callers
 * can still use explicit `provider/model` specs; calls with no override throw
 * a missing-default-key error that the caller's fallback contract handles.
 *
 * Pure over `env` so tests can pass a fake `process.env` without touching
 * the real one.
 */
export function resolveLlmConfig(env: NodeJS.ProcessEnv): ResolvedLlmConfig | null {
  const providerName = (env.JANUSLY_LLM_PROVIDER ?? "openai").toLowerCase();
  if (!PROVIDERS[providerName]) {
    // Unknown provider — log via stderr and fall back to "openai".
    // eslint-disable-next-line no-console
    console.warn(`[llm-client] unknown JANUSLY_LLM_PROVIDER=${providerName}; falling back to openai`);
  }
  const resolvedProvider = PROVIDERS[providerName] ? providerName : "openai";

  const apiKeys: Record<string, string> = {};
  const defaultModels: Record<string, string> = {};
  for (const [name, spec] of Object.entries(PROVIDERS)) {
    const key = env[spec.envApiKey];
    if (key) apiKeys[name] = key;
    defaultModels[name] = env[spec.envModel] ?? spec.defaultModel;
  }
  if (Object.keys(apiKeys).length === 0) return null;

  return {
    provider: resolvedProvider,
    apiKeys,
    defaultModels,
    timeoutMs: Number(env.OPENAI_TIMEOUT_MS ?? 30_000),
    maxRetries: Number(env.OPENAI_MAX_RETRIES ?? 2),
  };
}

/**
 * Parse an optional `"provider/model"` spec. Bare model ids return
 * `[null, modelId]` so the configured provider stays in effect; a slash
 * triggers a per-call provider override.
 */
function parseModelSpec(spec: string | undefined): [string | null, string | undefined] {
  if (!spec) return [null, undefined];
  const ix = spec.indexOf("/");
  if (ix < 0) return [null, spec];
  return [spec.slice(0, ix).toLowerCase(), spec.slice(ix + 1)];
}

/**
 * Bind a `LlmClient` to a resolved config. Per-provider model factories are
 * memoised inside the closure so repeat calls don't re-instantiate
 * `createOpenAI` / `createAnthropic` clients.
 */
export function createLlmClient(cfg: ResolvedLlmConfig): LlmClient {
  const factories = new Map<string, (modelId: string) => LanguageModel>();
  const factoryFor = (name: string) => {
    let f = factories.get(name);
    if (!f) {
      const spec = PROVIDERS[name];
      if (!spec) throw new Error(`unknown provider '${name}'`);
      const apiKey = cfg.apiKeys[name];
      if (!apiKey) throw new Error(`provider '${name}' not configured (set ${spec.envApiKey})`);
      f = spec.create(apiKey);
      factories.set(name, f);
    }
    return f;
  };

  return {
    async generateText(input) {
      const [overrideProvider, overrideModel] = parseModelSpec(input.modelHint);
      const providerName = overrideProvider ?? cfg.provider;
      const spec = PROVIDERS[providerName];
      const modelId = overrideModel ?? cfg.defaultModels[providerName] ?? spec?.defaultModel ?? "unknown";

      // Measure wall-clock latency around the SDK invocation so the
      // recorder can attribute slow calls. The recorder fires on BOTH the
      // success path AND the failure path so cost analysis sees rate-limit /
      // timeout / quota events as their own rows. Keep provider/key resolution
      // inside the try so configuration failures are recorded too.
      const startedAt = Date.now();
      let aiResult: Awaited<ReturnType<typeof aiGenerateText>>;
      try {
        if (!spec) throw new Error(`unknown provider '${providerName}'`);
        const buildModel = factoryFor(providerName);
        aiResult = await aiGenerateText({
          model: buildModel(modelId),
          system: input.system,
          prompt: input.prompt,
          maxRetries: cfg.maxRetries,
          abortSignal: AbortSignal.timeout(cfg.timeoutMs),
          ...(input.responseFormat === "json" && spec.jsonModeOptions ? spec.jsonModeOptions() : {}),
        });
      } catch (error) {
        const latencyMs = Date.now() - startedAt;
        void fireUsageRecorder({
          context: input.context,
          provider: providerName,
          model: modelId,
          latencyMs,
          mode: "fallback",
          aiError: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      const latencyMs = Date.now() - startedAt;
      const usage = aiResult.usage
        ? {
            inputTokens: aiResult.usage.inputTokens,
            outputTokens: aiResult.usage.outputTokens,
            totalTokens:
              (aiResult.usage.inputTokens ?? 0) + (aiResult.usage.outputTokens ?? 0) || undefined,
          }
        : undefined;
      const costUsd = computeCostUsd(getModelPrice(providerName, modelId), usage);

      void fireUsageRecorder({
        context: input.context,
        provider: providerName,
        model: modelId,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        totalTokens: usage?.totalTokens,
        latencyMs,
        costUsd,
        mode: "ai",
      });

      return {
        text: aiResult.text ?? "",
        finishReason: aiResult.finishReason,
        usage,
        provider: providerName,
        model: modelId,
        latencyMs,
        costUsd,
      };
    },

    async generateObject<T>(input: LlmGenerateObjectInput<T>): Promise<LlmGenerateObjectResult<T>> {
      // Same provider/model resolution + recorder fire as `generateText` —
      // the schema-aware path differs only in the SDK call itself.
      const [overrideProvider, overrideModel] = parseModelSpec(input.modelHint);
      const providerName = overrideProvider ?? cfg.provider;
      const spec = PROVIDERS[providerName];
      const modelId =
        overrideModel ?? cfg.defaultModels[providerName] ?? spec?.defaultModel ?? "unknown";

      const startedAt = Date.now();
      let aiResult: Awaited<ReturnType<typeof aiGenerateText>>;
      try {
        if (!spec) throw new Error(`unknown provider '${providerName}'`);
        const buildModel = factoryFor(providerName);
        aiResult = await aiGenerateText({
          model: buildModel(modelId),
          system: input.system,
          prompt: input.prompt,
          maxRetries: cfg.maxRetries,
          abortSignal: AbortSignal.timeout(cfg.timeoutMs),
          // `Output.object({ schema })` plumbs the JSON Schema through the
          // provider's structured-output capability and validates the
          // response. Schema rejection throws here — caller's try/catch
          // degrades to fallback per AGENTS.md.
          experimental_output: Output.object({
            schema: input.schema,
            name: input.schemaName,
            description: input.schemaDescription,
          }),
        });
      } catch (error) {
        const latencyMs = Date.now() - startedAt;
        void fireUsageRecorder({
          context: input.context,
          provider: providerName,
          model: modelId,
          latencyMs,
          mode: "fallback",
          aiError: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      const latencyMs = Date.now() - startedAt;
      const usage = aiResult.usage
        ? {
            inputTokens: aiResult.usage.inputTokens,
            outputTokens: aiResult.usage.outputTokens,
            totalTokens:
              (aiResult.usage.inputTokens ?? 0) + (aiResult.usage.outputTokens ?? 0) || undefined,
          }
        : undefined;
      const costUsd = computeCostUsd(getModelPrice(providerName, modelId), usage);

      // The AI SDK exposes the typed payload at `experimental_output` (and
      // also at `output` once the API stabilises). Read both so minor-version
      // bumps don't break the abstraction; throw before the success recorder
      // fires if neither is present.
      const obj =
        (aiResult as { experimental_output?: T }).experimental_output ??
        (aiResult as { output?: T }).output;
      if (obj === undefined) {
        const error = new Error("generateObject: SDK did not return a parsed output (schema rejected)");
        void fireUsageRecorder({
          context: input.context,
          provider: providerName,
          model: modelId,
          inputTokens: usage?.inputTokens,
          outputTokens: usage?.outputTokens,
          totalTokens: usage?.totalTokens,
          latencyMs,
          costUsd,
          mode: "fallback",
          aiError: error.message,
        });
        throw error;
      }

      void fireUsageRecorder({
        context: input.context,
        provider: providerName,
        model: modelId,
        inputTokens: usage?.inputTokens,
        outputTokens: usage?.outputTokens,
        totalTokens: usage?.totalTokens,
        latencyMs,
        costUsd,
        mode: "ai",
      });

      return {
        object: obj as T,
        finishReason: aiResult.finishReason,
        usage,
        provider: providerName,
        model: modelId,
        latencyMs,
        costUsd,
      };
    },
  };
}

/**
 * Fire-and-forget the registered usage recorder. Telemetry must NEVER break
 * an LLM call — failures are caught and dropped. Skips when no recorder is
 * registered or when the call has no `orgId` (multi-tenant scope).
 */
async function fireUsageRecorder(input: {
  context: LlmGenerateTextInput["context"];
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  latencyMs: number;
  costUsd?: number | null;
  mode: "ai" | "fallback";
  aiError?: string;
}): Promise<void> {
  const fn = getUsageRecorder();
  if (!fn) return;
  const orgId = input.context?.orgId;
  if (!orgId) return; // No multi-tenant scope ⇒ skip; covers tests and adhoc paths.
  const record: UsageRecord = {
    orgId,
    userId: input.context?.userId,
    runId: input.context?.runId,
    nodeId: input.context?.nodeId,
    provider: input.provider,
    model: input.model,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    totalTokens: input.totalTokens,
    latencyMs: input.latencyMs,
    costUsd: input.costUsd,
    mode: input.mode,
    aiError: input.aiError,
  };
  try {
    await fn(record);
  } catch {
    // Telemetry failure must NEVER break an LLM call. Drop silently.
  }
}

let cachedClient: LlmClient | null | undefined;

/**
 * Resolve and memoise the singleton LLM client from `process.env`. Returns
 * `null` when no provider key is configured — every AI surface still
 * degrades to its deterministic path.
 */
export function getLlmClient(): LlmClient | null {
  if (cachedClient !== undefined) return cachedClient;
  const cfg = resolveLlmConfig(process.env);
  cachedClient = cfg ? createLlmClient(cfg) : null;
  return cachedClient;
}

// ─── Test-only escapes (underscore-prefixed; never call from production) ─

/** Reset the memoised client. Tests that mutate env between cases call this. */
export function _resetLlmClientForTests(): void {
  cachedClient = undefined;
}

/**
 * Inject a provider entry at runtime (tests only). Returns the previously
 * registered spec for that name so the caller can restore it if needed.
 * Pair with `_unregisterProviderForTests` to clean up between cases.
 */
export function _registerProviderForTests(name: string, spec: ProviderSpec): ProviderSpec | undefined {
  const prev = PROVIDERS[name];
  PROVIDERS[name] = spec;
  return prev;
}

/** Remove a provider entry registered via `_registerProviderForTests`. */
export function _unregisterProviderForTests(name: string): void {
  delete PROVIDERS[name];
}
