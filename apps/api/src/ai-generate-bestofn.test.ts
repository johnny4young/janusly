/**
 * Unit tests for Best-of-N candidate generation + selection.
 *
 * Uses a stubbed `LlmClient` but the REAL `parseGeneratedWorkflow`,
 * `sanitizeAiWorkflow`, and `checkWorkflowReadiness` — so the validity gate
 * and the deterministic readiness scorer are exercised end-to-end at $0 (no
 * provider call).
 */
import { describe, expect, it, vi } from "vitest";

import type { Workflow } from "@janusly/shared";

import {
  budgetAwareCandidateCount,
  generateWorkflowCandidates,
  MAX_GENERATION_CANDIDATES,
  selectBestCandidate,
  type GeneratedCandidate,
} from "./ai-generate-bestofn";

const ctx = { orgId: "org-1", userId: "user-1" };

// A minimal generation-subset workflow as JSON text (parses via the AI schema).
function workflowJson(id: string): string {
  return JSON.stringify({
    id,
    name: id,
    nodes: [{ id: "n1", type: "noop", config: {} }],
    edges: [],
  });
}

// Stub LlmClient whose generateText returns queued texts in order.
function stubLlm(texts: string[]) {
  const queue = [...texts];
  return {
    generateText: vi.fn(async () => ({
      text: queue.shift() ?? "",
      model: "claude-haiku-4-5-20251001",
      provider: "anthropic",
      latencyMs: 1,
      usage: {},
    })),
    generateObject: vi.fn(),
  } as never;
}

function candidate(workflow: Workflow): GeneratedCandidate {
  return { workflow, model: "claude-haiku-4-5-20251001", provider: "anthropic" };
}

describe("generateWorkflowCandidates", () => {
  it("fires n samples in parallel and returns the parsed ones", async () => {
    const llm = stubLlm([workflowJson("a"), "not json at all", workflowJson("c")]);
    const out = await generateWorkflowCandidates(llm, "sys", "make a flow", undefined, ctx, 3);
    expect((llm as never as { generateText: { mock: { calls: unknown[] } } }).generateText.mock.calls.length).toBe(3);
    expect(out).toHaveLength(2); // the garbage reply is dropped
    expect(out.map((c) => c.workflow.id)).toEqual(["a", "c"]);
    expect(out[0]!.model).toBe("claude-haiku-4-5-20251001");
    expect(out[0]!.provider).toBe("anthropic");
  });

  it("clamps the candidate count to the max", async () => {
    const llm = stubLlm(Array.from({ length: 10 }, (_, i) => workflowJson(`w${i}`)));
    await generateWorkflowCandidates(llm, "sys", "p", undefined, ctx, 10);
    expect((llm as never as { generateText: { mock: { calls: unknown[] } } }).generateText.mock.calls.length).toBe(MAX_GENERATION_CANDIDATES);
  });

  it("clamps a non-positive count up to 1", async () => {
    const llm = stubLlm([workflowJson("a")]);
    await generateWorkflowCandidates(llm, "sys", "p", undefined, ctx, 0);
    expect((llm as never as { generateText: { mock: { calls: unknown[] } } }).generateText.mock.calls.length).toBe(1);
  });

  it("drops a rejected SDK call without throwing", async () => {
    const llm = {
      generateText: vi
        .fn()
        .mockResolvedValueOnce({ text: workflowJson("ok"), model: "m", provider: "p", latencyMs: 1, usage: {} })
        .mockRejectedValueOnce(new Error("rate limited")),
      generateObject: vi.fn(),
    } as never;
    const out = await generateWorkflowCandidates(llm, "sys", "p", undefined, ctx, 2);
    expect(out).toHaveLength(1);
    expect(out[0]!.workflow.id).toBe("ok");
  });

  it("drops candidates that omit operator-supplied machine references", async () => {
    const reference = "{{secret.BILLING_API_TOKEN}}";
    const preserved = JSON.stringify({
      id: "preserved",
      name: "preserved",
      nodes: [{
        id: "charge",
        type: "http",
        config: {
          url: "https://billing.example.com/charges",
          method: "POST",
          headers: { Authorization: reference },
        },
      }],
      edges: [],
    });
    const llm = stubLlm([workflowJson("missing"), preserved]);
    const out = await generateWorkflowCandidates(
      llm,
      "sys",
      `POST with Authorization ${reference}`,
      undefined,
      ctx,
      2,
    );
    expect(out.map((candidate) => candidate.workflow.id)).toEqual(["preserved"]);
  });
});

const cleanWorkflow = {
  dslVersion: "1.0",
  id: "clean",
  name: "clean",
  nodes: [{ id: "n1", type: "http", config: { method: "GET", url: "https://example.com", retry: { maxAttempts: 3 } } }],
  edges: [],
} as unknown as Workflow;

const rawSecretWorkflow = {
  dslVersion: "1.0",
  id: "leaky",
  name: "leaky",
  // `apiKey` matches the sensitive-key pattern and the literal value is not a
  // template → checkWorkflowReadiness flags a `fail` (raw secret in config).
  nodes: [{ id: "n1", type: "http", config: { method: "GET", url: "https://example.com", apiKey: "sk-live-abc123def456" } }],
  edges: [],
} as unknown as Workflow;

const invalidWorkflow = {
  dslVersion: "1.0",
  id: "broken",
  name: "broken",
  // Edge points at a node that does not exist → validateWorkflow rejects →
  // sanitizeAiWorkflow throws → not a valid candidate.
  nodes: [{ id: "n1", type: "noop", config: {} }],
  edges: [{ from: "n1", to: "ghost" }],
} as unknown as Workflow;

describe("selectBestCandidate", () => {
  it("returns null on an empty list", () => {
    expect(selectBestCandidate([])).toBeNull();
  });

  it("picks the valid candidate with the fewest readiness issues", () => {
    // `leaky` carries a raw-secret fail; `clean` does not → clean wins even
    // when listed second.
    const selection = selectBestCandidate([candidate(rawSecretWorkflow), candidate(cleanWorkflow)]);
    expect(selection).not.toBeNull();
    expect(selection!.winner.workflow.id).toBe("clean");
    expect(selection!.validCount).toBe(2);
  });

  it("counts only sanitize-valid candidates and skips invalid ones", () => {
    const selection = selectBestCandidate([candidate(invalidWorkflow), candidate(cleanWorkflow)]);
    expect(selection!.winner.workflow.id).toBe("clean");
    expect(selection!.validCount).toBe(1);
  });

  it("falls back to the first parsed candidate when none validate (validCount 0)", () => {
    const selection = selectBestCandidate([candidate(invalidWorkflow)]);
    expect(selection!.winner.workflow.id).toBe("broken");
    expect(selection!.validCount).toBe(0);
  });
});

describe("budgetAwareCandidateCount", () => {
  const budget = (over: Partial<{ monthlyUsdLimit: number | null; warningThresholdCrossed: boolean }> = {}) => ({
    monthlyUsdLimit: 100,
    warningThresholdCrossed: false,
    ...over,
  });

  it("keeps the configured N when spend is under the warning threshold", () => {
    expect(budgetAwareCandidateCount(3, budget())).toBe(3);
  });

  it("keeps the configured N when no budget is configured", () => {
    expect(budgetAwareCandidateCount(5, budget({ monthlyUsdLimit: null, warningThresholdCrossed: true }))).toBe(5);
  });

  it("collapses to single-shot once the warning threshold is crossed", () => {
    expect(budgetAwareCandidateCount(5, budget({ warningThresholdCrossed: true }))).toBe(1);
  });

  it("clamps the configured value into the [1,5] bounds first", () => {
    expect(budgetAwareCandidateCount(99, budget())).toBe(MAX_GENERATION_CANDIDATES);
    expect(budgetAwareCandidateCount(0, budget({ warningThresholdCrossed: true }))).toBe(1);
    expect(budgetAwareCandidateCount(Number.NaN, budget())).toBe(1);
  });
});
