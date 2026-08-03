/**
 * Tests for the experiment runner.
 *
 * Coverage guarantees:
 * - Deterministic fixture eval: a stubbed client where the candidate
 *   returns the gold answer and control returns garbage → candidate wins,
 *   recommendation = promote_candidate.
 * - Unknown-model / model-failure fallback: a `generateText` that throws is
 *   caught per side; the side scores 0 via the empty output, an `aiError`
 *   is recorded, and the run NEVER throws.
 * - Cost-null handling: a side whose calls report `costUsd: null` is
 *   excluded from the cost sum and its `costKnownCount` is 0.
 * - `onCall` fires once per side per example (the usage-recording seam).
 * - A null client completes the run with both sides empty (no crash).
 */

import { describe, expect, it, vi } from "vitest";

import { runExperiment, MIN_SCORE_DELTA } from "./experiment-runner";
import type { LlmClient } from "./llm-client";

const ctx = { orgId: "org-1", userId: "user-1" } as const;

/** Build a stub client that returns a per-arm canned response keyed by system prompt. */
function stubClient(map: (system: string | undefined) => { text: string; costUsd?: number | null }): LlmClient {
  return {
    generateText: vi.fn(async (input: { system?: string; modelHint?: string }) => {
      const res = map(input.system);
      return { text: res.text, provider: "anthropic", model: input.modelHint ?? "stub-model", latencyMs: 10, costUsd: res.costUsd ?? 0.0001 };
    }),
    generateObject: vi.fn(),
  } as unknown as LlmClient;
}

const examples = [
  { input: "the http node timed out", expected: "raise_timeout" },
  { input: "401 from the api", expected: "swap_secret_ref" },
];

describe("runExperiment — deterministic fixture", () => {
  it("recommends the candidate when it scores the gold answers and control does not", async () => {
    // Control echoes garbage; candidate echoes the example's expected label.
    const client: LlmClient = {
      generateText: vi.fn(async (input: { system?: string; prompt: string }) => {
        const isCandidate = input.system === "candidate";
        // Map each input prompt to its expected gold for the candidate arm.
        const gold = input.prompt.includes("timed out") ? "raise_timeout" : "swap_secret_ref";
        return {
          text: isCandidate ? gold : "i am not sure",
          provider: "anthropic",
          model: "m",
          latencyMs: 12,
          costUsd: 0.0002,
        };
      }),
      generateObject: vi.fn(),
    } as unknown as LlmClient;

    const summary = await runExperiment({
      client,
      scorerKind: "string_equality",
      controlArm: { systemPrompt: "control" },
      candidateArm: { systemPrompt: "candidate" },
      examples,
      context: ctx,
    });

    expect(summary.exampleCount).toBe(2);
    expect(summary.candidate.meanScore).toBe(1);
    expect(summary.control.meanScore).toBe(0);
    expect(summary.scoreDelta).toBeGreaterThanOrEqual(MIN_SCORE_DELTA);
    expect(summary.recommendation).toBe("promote_candidate");
    expect(summary.recommendationReason).toContain("Promotion is a suggestion");
  });

  it("keeps control when scores tie (within noise)", async () => {
    const client = stubClient(() => ({ text: "raise_timeout" }));
    const summary = await runExperiment({
      client,
      scorerKind: "string_equality",
      controlArm: { systemPrompt: "control" },
      candidateArm: { systemPrompt: "candidate" },
      // Both arms produce the same output; first example matches, second doesn't — equal for both sides.
      examples,
      context: ctx,
    });
    expect(summary.scoreDelta).toBe(0);
    expect(summary.recommendation).toBe("keep_control");
  });
});

describe("runExperiment — model failure fallback", () => {
  it("catches a per-side throw, records aiError, scores 0, and never throws", async () => {
    const client: LlmClient = {
      generateText: vi.fn(async (input: { system?: string }) => {
        if (input.system === "candidate") throw new Error("model not found: bogus-model");
        return { text: "raise_timeout", provider: "anthropic", model: "m", latencyMs: 5, costUsd: 0.0001 };
      }),
      generateObject: vi.fn(),
    } as unknown as LlmClient;

    const summary = await runExperiment({
      client,
      scorerKind: "string_equality",
      controlArm: { systemPrompt: "control" },
      candidateArm: { systemPrompt: "candidate", modelHint: "bogus-model" },
      examples: [examples[0]!],
      context: ctx,
    });

    // Candidate threw on every call → 1 error, empty output → score 0.
    expect(summary.candidate.errorCount).toBe(1);
    expect(summary.candidate.meanScore).toBe(0);
    // Control answered the first example correctly.
    expect(summary.control.meanScore).toBe(1);
    expect(summary.recommendation).toBe("keep_control");
  });

  it("completes with a null client (no provider key) without crashing", async () => {
    const summary = await runExperiment({
      client: null,
      scorerKind: "string_equality",
      controlArm: { modelHint: "a" },
      candidateArm: { modelHint: "b" },
      examples,
      context: ctx,
    });
    expect(summary.exampleCount).toBe(2);
    expect(summary.control.errorCount).toBe(2);
    expect(summary.candidate.errorCount).toBe(2);
    expect(summary.recommendation).toBe("keep_control"); // both empty → tie
  });
});

describe("runExperiment — cost-null handling", () => {
  it("excludes null-cost calls from the cost sum + costKnownCount", async () => {
    // Candidate reports unknown cost (null); control reports a real price.
    const client: LlmClient = {
      generateText: vi.fn(async (input: { system?: string }) => ({
        text: "raise_timeout",
        provider: "anthropic",
        model: "m",
        latencyMs: 5,
        costUsd: input.system === "candidate" ? null : 0.01,
      })),
      generateObject: vi.fn(),
    } as unknown as LlmClient;

    const summary = await runExperiment({
      client,
      scorerKind: "string_equality",
      controlArm: { systemPrompt: "control" },
      candidateArm: { systemPrompt: "candidate" },
      examples,
      context: ctx,
    });

    expect(summary.candidate.totalCostUsd).toBe(0);
    expect(summary.candidate.costKnownCount).toBe(0);
    expect(summary.control.costKnownCount).toBe(2);
    expect(summary.control.totalCostUsd).toBeCloseTo(0.02, 6);
  });
});

describe("runExperiment — usage seam", () => {
  it("fires onCall once per side per example", async () => {
    const client = stubClient(() => ({ text: "x" }));
    const onCall = vi.fn();
    await runExperiment({
      client,
      scorerKind: "string_equality",
      controlArm: { systemPrompt: "control" },
      candidateArm: { systemPrompt: "candidate" },
      examples,
      context: ctx,
      onCall,
    });
    // 2 examples × 2 sides.
    expect(onCall).toHaveBeenCalledTimes(4);
    const sides = onCall.mock.calls.map((c) => (c[0] as { side: string }).side);
    expect(sides.filter((s) => s === "control")).toHaveLength(2);
    expect(sides.filter((s) => s === "candidate")).toHaveLength(2);
  });
});
