import { beforeEach, describe, expect, it } from "vitest";

import { clearWorkflowParseCache, parseWorkflowCached } from "./workflow-parse-cache";

const validWorkflow = () => ({
  id: "wf-cache-test",
  nodes: [{ id: "n1", type: "noop", config: {} }],
  edges: [],
});

describe("parseWorkflowCached", () => {
  beforeEach(() => {
    clearWorkflowParseCache();
  });

  it("parses a valid workflow and returns ok", () => {
    const result = parseWorkflowCached(validWorkflow());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.workflow.id).toBe("wf-cache-test");
  });

  it("returns the SAME parsed object for byte-identical payloads (cache hit)", () => {
    const first = parseWorkflowCached(validWorkflow());
    const second = parseWorkflowCached(validWorkflow());
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.workflow).toBe(first.workflow);
    }
  });

  it("does NOT reuse a cached parse when the payload bytes change (patched replay)", () => {
    const first = parseWorkflowCached(validWorkflow());
    const patched = {
      ...validWorkflow(),
      nodes: [{ id: "n1", type: "noop", config: { retried: true } }],
    };
    const second = parseWorkflowCached(patched);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.workflow).not.toBe(first.workflow);
      expect((second.workflow.nodes[0]?.config as { retried?: boolean }).retried).toBe(true);
    }
  });

  it("rejects an invalid workflow with a message and never caches it", () => {
    const bad = { id: "x", nodes: "not-an-array", edges: [] };
    const first = parseWorkflowCached(bad);
    const second = parseWorkflowCached(bad);
    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    if (!first.ok) expect(first.error.length).toBeGreaterThan(0);
  });

  it("evicts oldest entries past capacity without breaking correctness", () => {
    const first = parseWorkflowCached(validWorkflow());
    // Push 40 distinct workflows through a 32-entry LRU.
    for (let i = 0; i < 40; i += 1) {
      const wf = { ...validWorkflow(), id: `wf-${i}` };
      expect(parseWorkflowCached(wf).ok).toBe(true);
    }
    // The original entry was evicted — re-parse yields a NEW object, still valid.
    const again = parseWorkflowCached(validWorkflow());
    expect(again.ok).toBe(true);
    if (first.ok && again.ok) expect(again.workflow).not.toBe(first.workflow);
  });
});
