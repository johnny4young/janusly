import { describe, expect, it } from "vitest";

import { aggregateRunUsage, RUN_USAGE_ROW_CAP } from "./runUsageRepo";

describe("aggregateRunUsage", () => {
  it("summarizes LLM tokens, cache efficiency, cost, and generic memory activity", () => {
    const result = aggregateRunUsage([
      {
        metric: "llm.completion",
        quantity: 150,
        metadata: {
          inputTokens: 100,
          outputTokens: 50,
          cachedInputTokens: 70,
          cacheCreationInputTokens: 10,
          costUsd: 0.003,
        },
      },
      {
        metric: "llm.completion",
        quantity: 40,
        metadata: { inputTokens: 30, outputTokens: 10, costUsd: null },
      },
      { metric: "memory.recall", quantity: 1, metadata: { kind: "agent_episode", ok: true } },
      { metric: "memory.recall", quantity: 1, metadata: { kind: "workflow_vector", ok: false } },
      { metric: "memory.commit", quantity: 1, metadata: { kind: "agent_episode", ok: true } },
      { metric: "tool.http.request", quantity: 1, metadata: {} },
    ]);

    expect(result).toEqual({
      loadedRows: 6,
      truncated: false,
      rowCap: RUN_USAGE_ROW_CAP,
      llm: {
        calls: 2,
        inputTokens: 130,
        outputTokens: 60,
        totalTokens: 190,
        cachedInputTokens: 70,
        cacheCreationInputTokens: 10,
        knownCostUsd: 0.003,
        unknownCostCalls: 1,
      },
      memory: {
        recalls: 2,
        commits: 1,
        failures: 1,
        kinds: [
          { kind: "agent_episode", recalls: 1, commits: 1, failures: 0 },
          { kind: "workflow_vector", recalls: 1, commits: 0, failures: 1 },
        ],
      },
    });
  });

  it("ignores malformed or negative numeric metadata without inventing usage", () => {
    const result = aggregateRunUsage([
      {
        metric: "llm.completion",
        quantity: -2,
        metadata: {
          inputTokens: "10",
          outputTokens: Number.NaN,
          cachedInputTokens: -1,
          cacheCreationInputTokens: Number.POSITIVE_INFINITY,
          costUsd: -4,
        },
      },
      { metric: "memory.commit", quantity: 1, metadata: null },
    ], { truncated: true, rowCap: 1 });

    expect(result.truncated).toBe(true);
    expect(result.rowCap).toBe(1);
    expect(result.llm).toEqual({
      calls: 1,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 0,
      cacheCreationInputTokens: 0,
      knownCostUsd: 0,
      unknownCostCalls: 1,
    });
    expect(result.memory.kinds).toEqual([
      { kind: "unknown", recalls: 0, commits: 1, failures: 0 },
    ]);
  });

  it("rejects fractional and unsafe token metadata while saturating safe totals", () => {
    const result = aggregateRunUsage([
      {
        metric: "llm.completion",
        quantity: Number.MAX_SAFE_INTEGER,
        metadata: {
          inputTokens: Number.MAX_SAFE_INTEGER,
          outputTokens: 1.5,
          cachedInputTokens: Number.MAX_SAFE_INTEGER + 1,
          cacheCreationInputTokens: 3,
          costUsd: Number.MAX_VALUE,
        },
      },
      {
        metric: "llm.completion",
        quantity: 1,
        metadata: {
          inputTokens: 1,
          outputTokens: 2,
          cachedInputTokens: 4,
          cacheCreationInputTokens: 5,
          costUsd: Number.MAX_VALUE,
        },
      },
    ]);

    expect(result.llm).toMatchObject({
      calls: 2,
      inputTokens: Number.MAX_SAFE_INTEGER,
      outputTokens: 2,
      totalTokens: Number.MAX_SAFE_INTEGER,
      cachedInputTokens: 4,
      cacheCreationInputTokens: 8,
      knownCostUsd: Number.MAX_VALUE,
    });
  });
});
