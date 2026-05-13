/**
 * Server-side cost computation for LLM calls.
 *
 * The static `MODEL_PRICES` table + `lookupModelPrice` helper live in
 * `@janusly/shared/src/llm-pricing` so the web bundle can import them
 * for "(~$0.05)" preview labels without round-tripping. This module
 * re-exports those plus adds two server-only pieces:
 *
 * - `getModelPrice(provider, model, env)` — overlays the static table
 *   with `JANUSLY_LLM_PRICE_<UPPER_MODEL>=<input>,<output>` env
 *   overrides. The env override path stays SERVER-ONLY; the web has
 *   no use for it.
 * - `computeCostUsd(price, usage)` — multiplies a measured token usage
 *   tuple by a price. Used by `packages/ai/src/llm-client.ts` to fill
 *   the `costUsd` column on every `usage_events` row.
 *
 * Used by `packages/ai/src/llm-client.ts` to compute `costUsd` per call.
 *
 * Sources (snapshot 2026-04):
 *   - OpenAI:    https://platform.openai.com/docs/pricing
 *   - Anthropic: https://www.anthropic.com/pricing
 */

import {
  MODEL_PRICES,
  lookupModelPrice,
  type ModelPrice,
} from "@janusly/shared/src/llm-pricing";

export { MODEL_PRICES, lookupModelPrice };
export type { ModelPrice };

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
  return lookupModelPrice(model);
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
