/**
 * Per-model price map for cost computation. Built-in defaults
 * for today's registered providers; `JANUSLY_LLM_PRICE_<UPPER_MODEL>=<input>,<output>`
 * env overrides win. Prices are USD per 1,000,000 tokens — the scale every
 * model card publishes at.
 *
 * The defaults are a snapshot; LLM pricing moves quarterly. When a model's
 * billing page shifts, set the env override OR submit a PR to update this
 * map. Unknown models return `null` (silently zeroing pricing data is
 * worse than recording its absence).
 *
 * Used by `packages/ai/src/llm-client.ts` to compute `costUsd` per call.
 *
 * Sources (snapshot 2026-04):
 *   - OpenAI:    https://platform.openai.com/docs/pricing
 *   - Anthropic: https://www.anthropic.com/pricing
 */

/** Two prices that fully describe a model's billing surface. */
export type ModelPrice = {
  /** USD per 1M input tokens. */
  inputUsdPer1M: number;
  /** USD per 1M output tokens. */
  outputUsdPer1M: number;
};

/** Snapshot of vendor pricing pages (2026-04). Keep keys lowercase to
 * match the model ids the AI SDK passes through. */
const DEFAULT_PRICES: Record<string, ModelPrice> = {
  // OpenAI
  "gpt-4o-mini": { inputUsdPer1M: 0.15, outputUsdPer1M: 0.6 },
  "gpt-4o": { inputUsdPer1M: 2.5, outputUsdPer1M: 10.0 },
  "gpt-4.1": { inputUsdPer1M: 2.0, outputUsdPer1M: 8.0 },
  "gpt-4.1-mini": { inputUsdPer1M: 0.4, outputUsdPer1M: 1.6 },
  // Anthropic
  "claude-haiku-4-5": { inputUsdPer1M: 1.0, outputUsdPer1M: 5.0 },
  "claude-sonnet-4-5": { inputUsdPer1M: 3.0, outputUsdPer1M: 15.0 },
  "claude-opus-4": { inputUsdPer1M: 15.0, outputUsdPer1M: 75.0 },
};

/**
 * Resolve the price entry for a (provider, model) pair. The provider arg
 * is reserved for future per-vendor-prefix lookups; today only the model id
 * matters because all registered providers ship globally-unique ids.
 *
 * Returns `null` when neither an env override nor a built-in default
 * applies — callers record the cost as `null` rather than a misleading 0.
 */
export function getModelPrice(
  _provider: string,
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): ModelPrice | null {
  const overrideKey = `JANUSLY_LLM_PRICE_${model.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
  const override = env[overrideKey];
  if (override) {
    const [inStr, outStr] = override.split(",").map((s) => s.trim());
    const i = Number(inStr);
    const o = Number(outStr);
    if (Number.isFinite(i) && Number.isFinite(o)) {
      return { inputUsdPer1M: i, outputUsdPer1M: o };
    }
  }
  return DEFAULT_PRICES[model] ?? null;
}

/**
 * Multiply a token-usage tuple by a price. Returns `null` when either input
 * is missing — preserving the "no price → no cost recorded" contract.
 */
export function computeCostUsd(
  price: ModelPrice | null,
  usage: { inputTokens?: number; outputTokens?: number } | undefined,
): number | null {
  if (!price || !usage) return null;
  const inUsd = ((usage.inputTokens ?? 0) * price.inputUsdPer1M) / 1_000_000;
  const outUsd = ((usage.outputTokens ?? 0) * price.outputUsdPer1M) / 1_000_000;
  return inUsd + outUsd;
}
