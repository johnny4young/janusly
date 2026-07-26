/**
 * Zero-dep LLM model price table + pure cost-estimation helper.
 *
 * Lives in `@janusly/shared` so the web bundle can compute "(~$0.05)"
 * preview labels next to AI Studio CTAs without round-tripping through
 * the API. The server-side cost recorder in `packages/ai/src/pricing.ts`
 * re-exports the table from here to keep a single source of truth.
 *
 * Prices are USD per 1,000,000 tokens — the scale every vendor's pricing
 * page publishes at. Snapshot is current as of 2026-04; refresh via PR
 * when a vendor's pricing changes. Unknown models return `null` so
 * callers degrade to "(?)" rather than a misleading $0.
 *
 * Used by:
 * - `packages/ai/src/pricing.ts` — re-exports + thin wrapper for cost recorder.
 * - `apps/web/src/components/AiCopilotPanel.tsx` — preview labels.
 *
 * Invariants:
 * - Zero runtime deps (no node-only globals).
 * - No I/O. Synchronous pure functions.
 */

export type ModelPrice = {
  /** USD per 1M input tokens. */
  inputUsdPer1M: number;
  /** USD per 1M output tokens. */
  outputUsdPer1M: number;
};

/** Snapshot of vendor pricing pages (2026-04). Keep keys lowercase. */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = Object.freeze({
  // OpenAI
  "gpt-4o-mini": { inputUsdPer1M: 0.15, outputUsdPer1M: 0.6 },
  "gpt-4o": { inputUsdPer1M: 2.5, outputUsdPer1M: 10.0 },
  "gpt-4.1": { inputUsdPer1M: 2.0, outputUsdPer1M: 8.0 },
  "gpt-4.1-mini": { inputUsdPer1M: 0.4, outputUsdPer1M: 1.6 },
  // Anthropic
  "claude-haiku-4-5-20251001": { inputUsdPer1M: 1.0, outputUsdPer1M: 5.0 },
  "claude-haiku-4-5": { inputUsdPer1M: 1.0, outputUsdPer1M: 5.0 },
  "claude-sonnet-4-5": { inputUsdPer1M: 3.0, outputUsdPer1M: 15.0 },
  "claude-opus-4": { inputUsdPer1M: 15.0, outputUsdPer1M: 75.0 },
});

/** Look up the static price entry for a model id. Returns `null` when
 *  unknown — callers handle "no price → no estimate" gracefully. */
export function lookupModelPrice(modelId: string): ModelPrice | null {
  return MODEL_PRICES[modelId] ?? null;
}

/**
 * Estimate the USD cost of one LLM call given a model id + approximate
 * input/output token counts. Returns `null` for unknown models. v1 is a
 * pure linear formula; measured history may later provide median-based
 * adjustments using `usage_events`.
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
  if (usd < 1) return `~$${usd.toFixed(2)}`;
  return `~$${usd.toFixed(2)}`;
}
