import { describe, expect, it } from "vitest";

import {
  MODEL_PRICES,
  MODEL_PRICING_SNAPSHOT_DATE,
  estimatePromptCostUsd,
  formatEstimateLabel,
  lookupModelPrice,
} from "./llm-pricing";

describe("llm-pricing", () => {
  it("ships a frozen, non-empty MODEL_PRICES table", () => {
    expect(MODEL_PRICING_SNAPSHOT_DATE).toBe("2026-09-03");
    expect(Object.keys(MODEL_PRICES)).toHaveLength(14);
    expect(MODEL_PRICES["claude-haiku-4-5-20251001"]).toBeDefined();
    expect(MODEL_PRICES["claude-sonnet-5"]).toEqual({
      inputUsdPer1M: 3, outputUsdPer1M: 15,
    });
    expect(MODEL_PRICES["claude-fable-5-1"]).toEqual({
      inputUsdPer1M: 10, outputUsdPer1M: 50,
    });
    expect(MODEL_PRICES["claude-opus-4-5-20251101"]).toEqual({
      inputUsdPer1M: 5, outputUsdPer1M: 25,
    });
    expect(MODEL_PRICES["claude-opus-4"]).toBeUndefined();
    expect(MODEL_PRICES["gpt-4o-mini"]).toBeUndefined();
    expect(() => {
      // Frozen — assigning a new key throws in strict mode.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (MODEL_PRICES as any)["fake-model"] = { inputUsdPer1M: 1, outputUsdPer1M: 1 };
    }).toThrow();
  });

  it("lookupModelPrice returns null for unknown ids", () => {
    expect(lookupModelPrice("does-not-exist")).toBeNull();
    expect(lookupModelPrice(" CLAUDE-SONNET-5 ")).toEqual({
      inputUsdPer1M: 3, outputUsdPer1M: 15,
    });
  });

  it("estimatePromptCostUsd computes input × inputRate + output × outputRate", () => {
    // claude-haiku: $1/M input, $5/M output. 1000 in + 500 out = 0.001 + 0.0025 = 0.0035
    const cost = estimatePromptCostUsd("claude-haiku-4-5-20251001", 1000, 500);
    expect(cost).toBeCloseTo(0.0035, 6);
  });

  it("estimatePromptCostUsd returns null for unknown models", () => {
    expect(estimatePromptCostUsd("fake", 1000, 1000)).toBeNull();
  });

  it("estimatePromptCostUsd rejects negative / non-finite token counts", () => {
    expect(estimatePromptCostUsd("claude-haiku-4-5", -1, 100)).toBeNull();
    expect(estimatePromptCostUsd("claude-haiku-4-5", 100, Number.NaN)).toBeNull();
    expect(estimatePromptCostUsd("claude-haiku-4-5", Number.POSITIVE_INFINITY, 100)).toBeNull();
  });

  it("formatEstimateLabel formats cost into a short human label", () => {
    expect(formatEstimateLabel(null)).toBe("~?");
    expect(formatEstimateLabel(0.001)).toBe("<$0.01");
    expect(formatEstimateLabel(0.042)).toBe("~$0.04");
    expect(formatEstimateLabel(1.234)).toBe("~$1.23");
  });
});
