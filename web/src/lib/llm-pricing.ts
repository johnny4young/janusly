/**
 * Zero-dependency LLM cost-estimation helpers over the generated runtime
 * price catalog.
 *
 * `internal/ai/pricing.go` is the source of truth. `make generate` renders
 * `llm-pricing.generated.ts`, so browser previews and server usage records
 * cannot silently drift.
 *
 * Prices are USD per 1,000,000 tokens. Unknown models return `null` so
 * callers degrade to "(?)" rather than a misleading $0.
 *
 * Used by `web/src/components/AiStudioPanel.tsx` for preview labels.
 *
 * Invariants:
 * - Zero runtime deps (no node-only globals).
 * - No I/O. Synchronous pure functions.
 */

import {
  GENERATED_MODEL_PRICES,
  GENERATED_MODEL_PRICING_SNAPSHOT_DATE,
} from './llm-pricing.generated'

export type ModelPrice = {
  /** USD per 1M input tokens. */
  inputUsdPer1M: number;
  /** USD per 1M output tokens. */
  outputUsdPer1M: number;
};

export const MODEL_PRICING_SNAPSHOT_DATE = GENERATED_MODEL_PRICING_SNAPSHOT_DATE
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = GENERATED_MODEL_PRICES

/** Look up the static price entry for a model id. Returns `null` when
 *  unknown — callers handle "no price → no estimate" gracefully. */
export function lookupModelPrice(modelId: string): ModelPrice | null {
  return MODEL_PRICES[modelId.trim().toLowerCase()] ?? null;
}

/**
 * Estimate the USD cost of one LLM call given a model id + approximate
 * uncached input/output token counts. Returns `null` for unknown models. The
 * preview represents a cache miss without a cacheable system-prompt estimate;
 * measured server usage separately prices cache writes and reads exactly.
 */
export function estimatePromptCostUsd(
  modelId: string,
  estimatedInputTokens: number,
  estimatedOutputTokens: number,
): number | null {
  const price = lookupModelPrice(modelId);
  if (!price) return null;
  if (!Number.isFinite(estimatedInputTokens) || estimatedInputTokens < 0) return null;
  if (!Number.isFinite(estimatedOutputTokens) || estimatedOutputTokens < 0) return null;
  const inUsd = (estimatedInputTokens * price.inputUsdPer1M) / 1_000_000;
  const outUsd = (estimatedOutputTokens * price.outputUsdPer1M) / 1_000_000;
  return inUsd + outUsd;
}

/** Format an estimated cost as a short human label. Returns "(unknown)"
 *  when the cost is null (unknown model). */
export function formatEstimateLabel(usd: number | null): string {
  if (usd === null) return "~?";
  if (usd < 0.005) return "<$0.01";
  return `~$${usd.toFixed(2)}`;
}
