/**
 * Tests for the experiment scorers.
 *
 * Coverage targets:
 * - `string_equality` — forgiving exact match (trim / case / whitespace).
 * - `json_schema` — output validated against an expected JSON Schema;
 *   unparseable output → 0; non-schema `expected` → equality fallback.
 * - `llm_judge` — deterministic fallback when client is null OR the call
 *   throws OR the reply is unparseable; reads back a clamped 0..1 score on
 *   success; NEVER throws.
 * - `scoreOutput` dispatch + the closed `ScorerKind` set.
 */

import { describe, expect, it, vi } from "vitest";

import {
  SCORER_KINDS,
  isScorerKind,
  parseJudgeScore,
  scoreJsonSchema,
  scoreLlmJudge,
  scoreOutput,
  scoreStringEquality,
} from "./experiment-scorer";
import type { LlmClient } from "./llm-client";

describe("string_equality scorer", () => {
  it("scores 1 on a forgiving exact match (case / whitespace / trim)", () => {
    expect(scoreStringEquality("Add Retry", "  add   retry ").score).toBe(1);
  });
  it("scores 0 on a mismatch", () => {
    expect(scoreStringEquality("add_retry", "raise_timeout").score).toBe(0);
  });
  it("never reports a deterministic scorer as LLM-judged", () => {
    expect(scoreStringEquality("a", "a").judgedByLlm).toBe(false);
  });
});

describe("json_schema scorer", () => {
  const schema = JSON.stringify({
    type: "object",
    properties: { approach: { type: "string" }, confidence: { type: "number" } },
    required: ["approach"],
  });

  it("scores 1 when the output JSON satisfies the required shape", () => {
    expect(scoreJsonSchema(JSON.stringify({ approach: "add_retry", confidence: 0.9 }), schema).score).toBe(1);
  });
  it("scores 1 even with extra keys (passthrough — required shape is what matters)", () => {
    expect(scoreJsonSchema(JSON.stringify({ approach: "x", extra: true }), schema).score).toBe(1);
  });
  it("scores 0 when a required key is missing", () => {
    expect(scoreJsonSchema(JSON.stringify({ confidence: 0.5 }), schema).score).toBe(0);
  });
  it("scores 0 when the output is not valid JSON", () => {
    expect(scoreJsonSchema("not json at all", schema).score).toBe(0);
  });
  it("falls back to string equality when `expected` is not a schema", () => {
    const r = scoreJsonSchema("add_retry", "add_retry");
    expect(r.score).toBe(1);
    expect(r.fallbackReason).toBe("expected_not_schema");
  });
  it("validates array item types", () => {
    const arraySchema = JSON.stringify({ type: "array", items: { type: "integer" } });
    expect(scoreJsonSchema(JSON.stringify([1, 2, 3]), arraySchema).score).toBe(1);
    expect(scoreJsonSchema(JSON.stringify([1, "two"]), arraySchema).score).toBe(0);
  });
});

describe("parseJudgeScore", () => {
  it("reads the first number and clamps to [0,1]", () => {
    expect(parseJudgeScore("0.75")).toBe(0.75);
    expect(parseJudgeScore("the score is 1.0")).toBe(1);
    expect(parseJudgeScore("3")).toBe(1); // clamp high
    expect(parseJudgeScore("-2")).toBe(0); // clamp low
  });
  it("returns null when no number is present", () => {
    expect(parseJudgeScore("excellent")).toBeNull();
  });
});

describe("llm_judge scorer", () => {
  it("uses the deterministic token-overlap fallback when client is null", async () => {
    const r = await scoreLlmJudge("add retry to the node", "add retry", null);
    expect(r.judgedByLlm).toBe(false);
    expect(r.fallbackReason).toBe("no_client");
    expect(r.score).toBeGreaterThan(0); // overlapping tokens
  });

  it("reads back a model-produced score on success", async () => {
    const client = {
      generateText: vi.fn().mockResolvedValue({ text: "0.9", provider: "anthropic", model: "m", latencyMs: 5, costUsd: 0 }),
      generateObject: vi.fn(),
    } as unknown as LlmClient;
    const r = await scoreLlmJudge("out", "exp", client, { orgId: "org-1" });
    expect(r.judgedByLlm).toBe(true);
    expect(r.score).toBe(0.9);
  });

  it("falls back deterministically (NEVER throws) when the judge call throws", async () => {
    const client = {
      generateText: vi.fn().mockRejectedValue(new Error("quota exceeded")),
      generateObject: vi.fn(),
    } as unknown as LlmClient;
    const r = await scoreLlmJudge("add retry", "add retry", client, { orgId: "org-1" });
    expect(r.judgedByLlm).toBe(false);
    expect(r.fallbackReason).toBe("quota exceeded");
    expect(r.score).toBe(1); // identical → full token overlap
  });

  it("falls back when the reply has no number", async () => {
    const client = {
      generateText: vi.fn().mockResolvedValue({ text: "great", provider: "p", model: "m", latencyMs: 1, costUsd: 0 }),
      generateObject: vi.fn(),
    } as unknown as LlmClient;
    const r = await scoreLlmJudge("a", "b", client, { orgId: "org-1" });
    expect(r.judgedByLlm).toBe(false);
    expect(r.fallbackReason).toBe("unparseable_reply");
  });
});

describe("scoreOutput dispatch", () => {
  it("dispatches to the configured scorer", async () => {
    expect((await scoreOutput({ scorerKind: "string_equality", output: "x", expected: "x", client: null })).score).toBe(1);
    expect((await scoreOutput({ scorerKind: "json_schema", output: "{}", expected: '{"type":"object"}', client: null })).score).toBe(1);
  });

  it("isScorerKind narrows the closed set", () => {
    for (const k of SCORER_KINDS) expect(isScorerKind(k)).toBe(true);
    expect(isScorerKind("bogus")).toBe(false);
    expect(isScorerKind(42)).toBe(false);
  });
});
