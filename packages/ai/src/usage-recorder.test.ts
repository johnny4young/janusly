import { afterEach, describe, expect, it, vi } from "vitest";
import {
  _resetUsageRecorderForTests,
  getUsageRecorder,
  setUsageRecorder,
  type UsageRecord,
} from "./usage-recorder";

const baseRecord: UsageRecord = {
  orgId: "org-1",
  provider: "openai",
  model: "gpt-4o-mini",
  inputTokens: 100,
  outputTokens: 50,
  totalTokens: 150,
  latencyMs: 1234,
  costUsd: 0.000045,
  providerSimulated: false,
  mode: "ai",
};

afterEach(() => {
  _resetUsageRecorderForTests();
});

describe("usage-recorder registry", () => {
  it("starts unset", () => {
    expect(getUsageRecorder()).toBeNull();
  });

  it("set/get round-trips a function", async () => {
    const fn = vi.fn();
    setUsageRecorder(fn);
    const got = getUsageRecorder();
    expect(got).toBe(fn);
    await got!(baseRecord);
    expect(fn).toHaveBeenCalledWith(baseRecord);
  });

  it("setUsageRecorder(null) clears the registration", () => {
    setUsageRecorder(vi.fn());
    setUsageRecorder(null);
    expect(getUsageRecorder()).toBeNull();
  });

  it("_resetUsageRecorderForTests clears between cases", () => {
    setUsageRecorder(vi.fn());
    _resetUsageRecorderForTests();
    expect(getUsageRecorder()).toBeNull();
  });

  it("recorder return values are passed through unchanged (sync)", () => {
    const fn = vi.fn().mockReturnValue(undefined);
    setUsageRecorder(fn);
    const result = getUsageRecorder()!(baseRecord);
    expect(result).toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("recorder return values are passed through unchanged (async)", async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    setUsageRecorder(fn);
    await getUsageRecorder()!(baseRecord);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
