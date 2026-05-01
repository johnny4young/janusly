import { describe, expect, it } from "vitest";
import { computeCostUsd, getModelPrice, type ModelPrice } from "./pricing";

describe("getModelPrice — built-in defaults", () => {
  it("returns the OpenAI gpt-4o-mini default", () => {
    expect(getModelPrice("openai", "gpt-4o-mini", {} as NodeJS.ProcessEnv)).toEqual({
      inputUsdPer1M: 0.15,
      outputUsdPer1M: 0.6,
    });
  });

  it("returns the Anthropic claude-haiku-4-5 default", () => {
    expect(
      getModelPrice("anthropic", "claude-haiku-4-5", {} as NodeJS.ProcessEnv),
    ).toEqual({
      inputUsdPer1M: 1.0,
      outputUsdPer1M: 5.0,
    });
  });

  it("returns null for an unknown model", () => {
    expect(
      getModelPrice("openai", "bogus-model-9000", {} as NodeJS.ProcessEnv),
    ).toBeNull();
  });
});

describe("getModelPrice — env overrides", () => {
  it("respects JANUSLY_LLM_PRICE_<MODEL> override", () => {
    const price = getModelPrice("openai", "gpt-4o-mini", {
      JANUSLY_LLM_PRICE_GPT_4O_MINI: "9.99,99.99",
    } as NodeJS.ProcessEnv);
    expect(price).toEqual({ inputUsdPer1M: 9.99, outputUsdPer1M: 99.99 });
  });

  it("normalises non-alphanumerics in the model id when computing the env key", () => {
    // Model id `claude-haiku-4-5` becomes env key `JANUSLY_LLM_PRICE_CLAUDE_HAIKU_4_5`.
    const price = getModelPrice("anthropic", "claude-haiku-4-5", {
      JANUSLY_LLM_PRICE_CLAUDE_HAIKU_4_5: "2.50,12.50",
    } as NodeJS.ProcessEnv);
    expect(price).toEqual({ inputUsdPer1M: 2.5, outputUsdPer1M: 12.5 });
  });

  it("falls back to the default when override values are not finite numbers", () => {
    const price = getModelPrice("openai", "gpt-4o-mini", {
      JANUSLY_LLM_PRICE_GPT_4O_MINI: "abc,def",
    } as NodeJS.ProcessEnv);
    expect(price).toEqual({ inputUsdPer1M: 0.15, outputUsdPer1M: 0.6 });
  });

  it("env override unlocks pricing for an otherwise-unknown model", () => {
    const price = getModelPrice("openai", "future-mystery-model", {
      JANUSLY_LLM_PRICE_FUTURE_MYSTERY_MODEL: "1,2",
    } as NodeJS.ProcessEnv);
    expect(price).toEqual({ inputUsdPer1M: 1, outputUsdPer1M: 2 });
  });
});

describe("computeCostUsd", () => {
  const price: ModelPrice = { inputUsdPer1M: 0.15, outputUsdPer1M: 0.6 };

  it("multiplies the (input,output) tuple by the (input,output) price per 1M tokens", () => {
    // 1000 input tokens at $0.15/M = $0.00015; 500 output at $0.60/M = $0.0003 → $0.00045
    const cost = computeCostUsd(price, { inputTokens: 1000, outputTokens: 500 });
    expect(cost).toBeCloseTo(0.00045, 8);
  });

  it("returns null when no price is supplied", () => {
    expect(computeCostUsd(null, { inputTokens: 100, outputTokens: 50 })).toBeNull();
  });

  it("returns null when no usage is supplied", () => {
    expect(computeCostUsd(price, undefined)).toBeNull();
  });

  it("treats missing token counts as zero contributions", () => {
    expect(computeCostUsd(price, { inputTokens: 1000 })).toBeCloseTo(0.00015, 8);
    expect(computeCostUsd(price, { outputTokens: 500 })).toBeCloseTo(0.0003, 8);
    expect(computeCostUsd(price, {})).toBe(0);
  });
});
