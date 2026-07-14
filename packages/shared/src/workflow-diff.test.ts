import { describe, expect, it } from "vitest";
import { classifyTag, computeWorkflowDiff, type DiffableWorkflow } from "./workflow-diff";

function makeWorkflow(partial: Partial<DiffableWorkflow>): DiffableWorkflow {
  return {
    dslVersion: "1.0",
    nodes: [],
    edges: [],
    ...partial,
  };
}

describe("computeWorkflowDiff — empty + identity", () => {
  it("two empty workflows produce a zero-change diff", () => {
    const result = computeWorkflowDiff(makeWorkflow({}), makeWorkflow({}));
    expect(result.summary.totalChanges).toBe(0);
    expect(result.workflow).toEqual([]);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  it("identical workflows produce a zero-change diff", () => {
    const wf = makeWorkflow({
      name: "Same",
      nodes: [{ id: "a", type: "noop", config: {} }],
      edges: [],
    });
    const result = computeWorkflowDiff(wf, wf);
    expect(result.summary.totalChanges).toBe(0);
  });
});

describe("computeWorkflowDiff — node add / remove", () => {
  it("captures a single node added", () => {
    const before = makeWorkflow({ nodes: [{ id: "a", type: "noop", config: {} }] });
    const after = makeWorkflow({
      nodes: [
        { id: "a", type: "noop", config: {} },
        { id: "b", type: "http", config: { url: "https://x" } },
      ],
    });
    const result = computeWorkflowDiff(before, after);
    expect(result.summary.nodesAdded).toBe(1);
    expect(result.nodes[0]).toMatchObject({ kind: "added", node: { id: "b", type: "http" } });
  });

  it("captures a single node removed", () => {
    const before = makeWorkflow({
      nodes: [
        { id: "a", type: "noop", config: {} },
        { id: "b", type: "http", config: { url: "https://x" } },
      ],
    });
    const after = makeWorkflow({ nodes: [{ id: "a", type: "noop", config: {} }] });
    const result = computeWorkflowDiff(before, after);
    expect(result.summary.nodesRemoved).toBe(1);
    expect(result.nodes[0]).toMatchObject({ kind: "removed", node: { id: "b" } });
  });

  it("tags an added approval node", () => {
    const before = makeWorkflow({ nodes: [] });
    const after = makeWorkflow({
      nodes: [{ id: "gate", type: "approval", config: { message: "OK?" } }],
    });
    const result = computeWorkflowDiff(before, after);
    expect(result.nodes[0]).toMatchObject({ kind: "added", tag: "approval" });
  });
});

describe("computeWorkflowDiff — node config changes + tags", () => {
  it.each([
    [undefined, "Review invoice"],
    ["Review invoice", "Approve invoice"],
    ["Review invoice", undefined],
  ])("records a node label change from %s to %s", (beforeLabel, afterLabel) => {
    const before = makeWorkflow({
      nodes: [{ id: "review", type: "noop", ...(beforeLabel ? { label: beforeLabel } : {}), config: {} }],
    });
    const after = makeWorkflow({
      nodes: [{ id: "review", type: "noop", ...(afterLabel ? { label: afterLabel } : {}), config: {} }],
    });
    const result = computeWorkflowDiff(before, after);
    expect(result.summary.nodesChanged).toBe(1);
    const changed = result.nodes[0];
    if (changed.kind !== "changed") throw new Error("expected changed node");
    expect(changed.fields).toEqual([{ path: "label", before: beforeLabel, after: afterLabel, tag: null }]);
  });

  it("records a single config field change with no tag", () => {
    const before = makeWorkflow({
      nodes: [{ id: "fetch", type: "http", config: { url: "https://a" } }],
    });
    const after = makeWorkflow({
      nodes: [{ id: "fetch", type: "http", config: { url: "https://b" } }],
    });
    const result = computeWorkflowDiff(before, after);
    expect(result.summary.nodesChanged).toBe(1);
    const changed = result.nodes[0];
    if (changed.kind !== "changed") throw new Error("expected changed node");
    expect(changed.fields).toHaveLength(1);
    expect(changed.fields[0]).toMatchObject({ path: "config.url", tag: null });
  });

  it("tags retry config changes", () => {
    const before = makeWorkflow({
      nodes: [{ id: "fetch", type: "http", config: { url: "https://a" } }],
    });
    const after = makeWorkflow({
      nodes: [{
        id: "fetch",
        type: "http",
        config: { url: "https://a", retry: { maxAttempts: 3 } },
      }],
    });
    const result = computeWorkflowDiff(before, after);
    const changed = result.nodes[0];
    if (changed.kind !== "changed") throw new Error("expected changed node");
    const retryChange = changed.fields.find((f) => f.path === "config.retry");
    expect(retryChange?.tag).toBe("retry");
  });

  it("tags timeout config changes", () => {
    const before = makeWorkflow({
      nodes: [{ id: "fetch", type: "http", config: { url: "https://a" } }],
    });
    const after = makeWorkflow({
      nodes: [{ id: "fetch", type: "http", config: { url: "https://a", timeoutMs: 30000 } }],
    });
    const result = computeWorkflowDiff(before, after);
    const changed = result.nodes[0];
    if (changed.kind !== "changed") throw new Error("expected changed node");
    const timeoutChange = changed.fields.find((f) => f.path === "config.timeoutMs");
    expect(timeoutChange?.tag).toBe("timeout");
  });

  it("tags bounds config changes", () => {
    const before = makeWorkflow({
      nodes: [{ id: "fetch", type: "http", config: { url: "https://a" } }],
    });
    const after = makeWorkflow({
      nodes: [{ id: "fetch", type: "http", config: { url: "https://a", maxResponseBytes: 1_000_000 } }],
    });
    const result = computeWorkflowDiff(before, after);
    const changed = result.nodes[0];
    if (changed.kind !== "changed") throw new Error("expected changed node");
    const boundsChange = changed.fields.find((f) => f.path === "config.maxResponseBytes");
    expect(boundsChange?.tag).toBe("bounds");
  });

  it("tags secret_ref via key-name match", () => {
    // `apiKey` matches the shared `SENSITIVE_KEY_PATTERN`.
    const before = makeWorkflow({
      nodes: [{ id: "fetch", type: "http", config: { apiKey: "literal" } }],
    });
    const after = makeWorkflow({
      nodes: [{ id: "fetch", type: "http", config: { apiKey: "{{secret.MY_KEY}}" } }],
    });
    const result = computeWorkflowDiff(before, after);
    const changed = result.nodes[0];
    if (changed.kind !== "changed") throw new Error("expected changed node");
    const secretChange = changed.fields.find((f) => f.path === "config.apiKey");
    expect(secretChange?.tag).toBe("secret_ref");
  });

  it("tags secret_ref via template value (path doesn't match the key pattern)", () => {
    const before = makeWorkflow({
      nodes: [{ id: "fetch", type: "http", config: { url: "https://x" } }],
    });
    const after = makeWorkflow({
      nodes: [{ id: "fetch", type: "http", config: { url: "https://x?token={{secret.GH}}" } }],
    });
    const result = computeWorkflowDiff(before, after);
    const changed = result.nodes[0];
    if (changed.kind !== "changed") throw new Error("expected changed node");
    const secretChange = changed.fields.find((f) => f.path === "config.url");
    expect(secretChange?.tag).toBe("secret_ref");
  });

  it("does not tag unsupported credential-template values as secret_ref by value alone", () => {
    const before = makeWorkflow({
      nodes: [{ id: "fetch", type: "http", config: { url: "https://x" } }],
    });
    const after = makeWorkflow({
      nodes: [{ id: "fetch", type: "http", config: { url: "https://x?token={{credential.GH}}" } }],
    });
    const result = computeWorkflowDiff(before, after);
    const changed = result.nodes[0];
    if (changed.kind !== "changed") throw new Error("expected changed node");
    const secretChange = changed.fields.find((f) => f.path === "config.url");
    expect(secretChange?.tag).toBeNull();
  });
});

describe("computeWorkflowDiff — edges", () => {
  it("captures an edge added", () => {
    const before = makeWorkflow({
      nodes: [
        { id: "a", type: "noop", config: {} },
        { id: "b", type: "noop", config: {} },
      ],
      edges: [],
    });
    const after = makeWorkflow({
      nodes: before.nodes,
      edges: [{ from: "a", to: "b" }],
    });
    const result = computeWorkflowDiff(before, after);
    expect(result.summary.edgesAdded).toBe(1);
    expect(result.edges[0]).toMatchObject({ kind: "added", edgeKey: "a->b" });
  });

  it("captures a changed edge condition", () => {
    const before = makeWorkflow({
      nodes: [
        { id: "a", type: "noop", config: {} },
        { id: "b", type: "noop", config: {} },
      ],
      edges: [{ id: "e1", from: "a", to: "b", condition: "context.a.output.ok === true" }],
    });
    const after = makeWorkflow({
      nodes: before.nodes,
      edges: [{ id: "e1", from: "a", to: "b", condition: "context.a.output.ok === false" }],
    });
    const result = computeWorkflowDiff(before, after);
    const changed = result.edges[0];
    if (changed.kind !== "changed") throw new Error("expected changed edge");
    expect(changed.fields[0]).toMatchObject({ path: "condition" });
  });
});

describe("computeWorkflowDiff — workflow-level fields", () => {
  it("captures a name change as a rationale-tagged workflow field", () => {
    const before = makeWorkflow({ name: "A" });
    const after = makeWorkflow({ name: "B" });
    const result = computeWorkflowDiff(before, after);
    expect(result.workflow[0]).toMatchObject({ path: "name", tag: "rationale" });
    expect(result.summary.totalChanges).toBe(1);
  });
});

describe("computeWorkflowDiff — determinism", () => {
  it("produces deep-equal output on reruns", () => {
    const before = makeWorkflow({
      nodes: [
        { id: "b", type: "http", config: { url: "https://b" } },
        { id: "a", type: "noop", config: {} },
      ],
      edges: [{ from: "a", to: "b" }],
    });
    const after = makeWorkflow({
      nodes: [
        { id: "a", type: "noop", config: {} },
        { id: "c", type: "approval", config: {} },
      ],
      edges: [],
    });
    const r1 = computeWorkflowDiff(before, after);
    const r2 = computeWorkflowDiff(before, after);
    expect(r1).toEqual(r2);
  });
});

describe("classifyTag — direct unit checks", () => {
  it("returns null for unmatched paths", () => {
    expect(classifyTag("config.url", "a", "b")).toBe(null);
  });

  it("never confuses a non-secret string for a secret_ref", () => {
    expect(classifyTag("config.url", "https://x", "https://y")).toBe(null);
  });
});
