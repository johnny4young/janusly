/**
 * Tests for the `parallel_fork` and `join` node executors. The runtime-level
 * fan-in semantics that make `join` wait for all branches are covered by
 * `core/runtime.test.ts`; these tests pin the per-executor validation and
 * output assembly.
 */
import { describe, expect, it } from "vitest";
import {
  joinExecutor,
  parallelForkExecutor,
  resolveJoinSources,
  resolveParallelForkBranches,
} from "./parallel-fork";

const baseCtx = {
  runId: "run-1",
  nodeId: "fork",
  orgId: "org-1",
  workflowId: "wf-1",
  context: {},
  redactedValues: [] as string[],
};

describe("resolveParallelForkBranches", () => {
  it("returns the validated branches array on the happy path", () => {
    const branches = resolveParallelForkBranches({
      branches: [
        { label: "a", description: "fetch from clearbit" },
        { label: "b" },
        { label: "c", description: "fetch from crm" },
      ],
    });
    expect(branches).toEqual([
      { label: "a", description: "fetch from clearbit" },
      { label: "b" },
      { label: "c", description: "fetch from crm" },
    ]);
  });

  it("rejects non-object config", () => {
    expect(() => resolveParallelForkBranches(null)).toThrow(/must be an object/);
    expect(() => resolveParallelForkBranches("oops")).toThrow(/must be an object/);
  });

  it("rejects when branches is missing or not an array", () => {
    expect(() => resolveParallelForkBranches({})).toThrow(/must be an array/);
    expect(() => resolveParallelForkBranches({ branches: "not-an-array" })).toThrow(/must be an array/);
  });

  it("rejects fewer than 2 branches", () => {
    expect(() => resolveParallelForkBranches({ branches: [] })).toThrow(/at least 2 branches/);
    expect(() => resolveParallelForkBranches({ branches: [{ label: "only" }] })).toThrow(/at least 2 branches/);
  });

  it("rejects more than 10 branches", () => {
    const branches = Array.from({ length: 11 }, (_, index) => ({ label: `b${index}` }));
    expect(() => resolveParallelForkBranches({ branches })).toThrow(/at most 10 branches/);
  });

  it("rejects duplicate labels", () => {
    expect(() => resolveParallelForkBranches({
      branches: [{ label: "dup" }, { label: "dup" }, { label: "x" }],
    })).toThrow(/duplicate label "dup"/);
  });

  it("rejects empty / non-string labels", () => {
    expect(() => resolveParallelForkBranches({
      branches: [{ label: "ok" }, { label: "" }],
    })).toThrow(/must be a non-empty string/);
    expect(() => resolveParallelForkBranches({
      branches: [{ label: "ok" }, { label: 42 as unknown as string }],
    })).toThrow(/must be a non-empty string/);
  });

  it("rejects labels longer than 64 chars", () => {
    const longLabel = "x".repeat(65);
    expect(() => resolveParallelForkBranches({
      branches: [{ label: "a" }, { label: longLabel }],
    })).toThrow(/≤ 64 chars/);
  });

  it("rejects descriptions that aren't strings or are too long", () => {
    expect(() => resolveParallelForkBranches({
      branches: [{ label: "a" }, { label: "b", description: 42 }],
    })).toThrow(/description must be a string/);
    expect(() => resolveParallelForkBranches({
      branches: [{ label: "a" }, { label: "b", description: "x".repeat(281) }],
    })).toThrow(/description must be ≤ 280/);
  });

  it("rejects branch entries that aren't objects", () => {
    expect(() => resolveParallelForkBranches({
      branches: ["a", "b"],
    })).toThrow(/must be an object/);
  });
});

describe("parallelForkExecutor", () => {
  it("echoes the validated branches as output (passthrough)", async () => {
    const result = await parallelForkExecutor({
      ...baseCtx,
      config: { branches: [{ label: "a" }, { label: "b" }, { label: "c" }] },
    });
    expect(result).toEqual({
      status: "completed",
      output: { branches: [{ label: "a" }, { label: "b" }, { label: "c" }] },
    });
  });

  it("propagates a validation error via the runtime's normal failure path (throws)", async () => {
    await expect(parallelForkExecutor({
      ...baseCtx,
      config: { branches: [{ label: "only" }] },
    })).rejects.toThrow(/at least 2 branches/);
  });
});

describe("resolveJoinSources", () => {
  it("returns the validated map on the happy path", () => {
    const sources = resolveJoinSources({
      sources: { a: "http_a", b: "http_b", c: "http_c" },
    });
    expect(sources).toEqual({ a: "http_a", b: "http_b", c: "http_c" });
  });

  it("rejects non-object config or missing/non-object sources", () => {
    expect(() => resolveJoinSources(null)).toThrow(/must be an object/);
    expect(() => resolveJoinSources({})).toThrow(/must be an object mapping/);
    expect(() => resolveJoinSources({ sources: "x" })).toThrow(/must be an object mapping/);
    expect(() => resolveJoinSources({ sources: ["a", "b"] })).toThrow(/must be an object mapping/);
  });

  it("rejects fewer than 2 entries", () => {
    expect(() => resolveJoinSources({ sources: {} })).toThrow(/at least 2 branches/);
    expect(() => resolveJoinSources({ sources: { a: "n" } })).toThrow(/at least 2 branches/);
  });

  it("rejects more than 10 entries", () => {
    const sources: Record<string, string> = {};
    for (let i = 0; i < 11; i += 1) sources[`b${i}`] = `n${i}`;
    expect(() => resolveJoinSources({ sources })).toThrow(/at most 10 branches/);
  });

  it("rejects empty branch labels and labels too long", () => {
    expect(() => resolveJoinSources({ sources: { "": "n", b: "m" } })).toThrow(/empty branch label/);
    const longKey = "x".repeat(65);
    expect(() => resolveJoinSources({ sources: { a: "n", [longKey]: "m" } })).toThrow(/must be ≤ 64 chars/);
  });

  it("rejects empty / non-string predecessor ids", () => {
    expect(() => resolveJoinSources({
      sources: { a: "n", b: "" },
    })).toThrow(/must be a non-empty predecessor node id/);
    expect(() => resolveJoinSources({
      sources: { a: "n", b: 42 as unknown as string },
    })).toThrow(/must be a non-empty predecessor node id/);
  });

  it("rejects duplicate predecessor ids across branches (copy-paste guard)", () => {
    expect(() => resolveJoinSources({
      sources: { a: "http_a", b: "http_a", c: "http_c" },
    })).toThrow(/references predecessor "http_a" more than once/);
  });
});

describe("joinExecutor", () => {
  it("assembles outputs by branch label from ctx.context", async () => {
    const result = await joinExecutor({
      ...baseCtx,
      nodeId: "join",
      config: { sources: { a: "http_a", b: "http_b", c: "http_c" } },
      context: {
        http_a: { status: "succeeded", output: { body: "alpha" } },
        http_b: { status: "succeeded", output: { body: "beta" } },
        http_c: { status: "succeeded", output: { body: "gamma" } },
      },
    });
    expect(result).toEqual({
      status: "completed",
      output: {
        branches: {
          a: { body: "alpha" },
          b: { body: "beta" },
          c: { body: "gamma" },
        },
      },
    });
  });

  it("preserves mixed output shapes per branch (string, number, nested object)", async () => {
    const result = await joinExecutor({
      ...baseCtx,
      nodeId: "join",
      config: { sources: { text: "n_text", count: "n_count", nested: "n_nested" } },
      context: {
        n_text: { status: "succeeded", output: "raw string" },
        n_count: { status: "succeeded", output: 42 },
        n_nested: { status: "succeeded", output: { deeply: { nested: { value: true } } } },
      },
    });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.output).toEqual({
      branches: {
        text: "raw string",
        count: 42,
        nested: { deeply: { nested: { value: true } } },
      },
    });
  });

  it("returns undefined for a predecessor missing from context (defensive)", async () => {
    const result = await joinExecutor({
      ...baseCtx,
      nodeId: "join",
      config: { sources: { a: "exists", b: "missing" } },
      context: {
        exists: { status: "succeeded", output: { body: "x" } },
      },
    });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.output).toEqual({
      branches: {
        a: { body: "x" },
        b: undefined,
      },
    });
  });

  it("returns undefined when a predecessor has no output field", async () => {
    const result = await joinExecutor({
      ...baseCtx,
      nodeId: "join",
      config: { sources: { a: "n_a", b: "n_b" } },
      context: {
        n_a: { status: "succeeded", output: { body: "ok" } },
        n_b: { status: "skipped" },
      },
    });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.output).toEqual({
      branches: {
        a: { body: "ok" },
        b: undefined,
      },
    });
  });

  it("propagates a validation error (throws) when sources is invalid", async () => {
    await expect(joinExecutor({
      ...baseCtx,
      nodeId: "join",
      config: { sources: {} },
    })).rejects.toThrow(/at least 2 branches/);
  });
});
