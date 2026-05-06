import { describe, expect, it } from "vitest";
import { WorkflowSchema, type Workflow } from "@janusly/shared";
import { applyConfigPatchToWorkflow, stripNullPatchValues } from "./patch-workflow-merge";

const workflow = WorkflowSchema.parse({
  dslVersion: "1.0",
  nodes: [
    { id: "fetch", type: "http", config: { url: "https://x", method: "GET" } },
    { id: "noop", type: "noop", config: {} },
  ],
  edges: [{ from: "fetch", to: "noop" }],
}) satisfies Workflow;

describe("stripNullPatchValues", () => {
  it("removes nullable-envelope sentinels before merge", () => {
    expect(stripNullPatchValues({
      url: null,
      method: null,
      retry: { maxAttempts: 3 },
      timeoutMs: 60_000,
    })).toEqual({
      retry: { maxAttempts: 3 },
      timeoutMs: 60_000,
    });
  });
});

describe("applyConfigPatchToWorkflow", () => {
  it("merges a non-null config patch into only the failing node", () => {
    const merged = applyConfigPatchToWorkflow(workflow, "fetch", {
      url: null,
      method: null,
      retry: { maxAttempts: 3 },
      timeoutMs: 60_000,
    });

    expect(merged.nodes.find((node) => node.id === "fetch")?.config).toEqual({
      url: "https://x",
      method: "GET",
      retry: { maxAttempts: 3 },
      timeoutMs: 60_000,
    });
    expect(merged.nodes.find((node) => node.id === "noop")?.config).toEqual({});
  });

  it("rejects patches that do not target an existing node", () => {
    expect(() => applyConfigPatchToWorkflow(workflow, "missing", { retry: { maxAttempts: 3 } }))
      .toThrow(/does not contain failing node id/);
  });

  it("rejects empty patches after nullable fields are stripped", () => {
    expect(() => applyConfigPatchToWorkflow(workflow, "fetch", {
      url: null,
      method: null,
      retry: null,
      timeoutMs: null,
      maxResponseBytes: null,
      maxRedirects: null,
    })).toThrow(/did not include any config changes/);
  });
});
