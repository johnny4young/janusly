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

describe("applyConfigPatchToWorkflow — bounded array-of-pairs (`headers`, `input`)", () => {
  // The LLM only emits the keys it wants to change; the merge layer folds
  // each item against the failing node's existing record so other keys
  // are preserved. Exercises the patch shape added for the recovery
  // smoke matrix's HTTP `headers` and tool `input` cases.
  const httpWithHeaders = WorkflowSchema.parse({
    dslVersion: "1.0",
    nodes: [
      {
        id: "fetch",
        type: "http",
        config: {
          url: "https://api.example/private",
          method: "GET",
          headers: { Authorization: "Bearer literal-token", "X-Trace-Id": "abc" },
        },
      },
    ],
    edges: [],
  }) satisfies Workflow;

  const toolWithInput = WorkflowSchema.parse({
    dslVersion: "1.0",
    nodes: [
      {
        id: "transform",
        type: "tool",
        config: {
          tool: "text.replace",
          input: { value: "{{context.fetch.output.body}}", search: "old", all: true },
        },
      },
    ],
    edges: [],
  }) satisfies Workflow;

  it("folds a `headers` array patch against the existing record (set + replace + remove via null)", () => {
    const merged = applyConfigPatchToWorkflow(httpWithHeaders, "fetch", {
      headers: [
        { name: "Authorization", value: "Bearer {{secret.GITHUB_TOKEN}}" },
        { name: "X-Trace-Id", value: null },
        { name: "X-Request-Id", value: "fresh-uuid" },
      ],
    });

    const fetchConfig = merged.nodes[0]!.config as { headers?: Record<string, string> };
    expect(fetchConfig.headers).toEqual({
      Authorization: "Bearer {{secret.GITHUB_TOKEN}}",
      "X-Request-Id": "fresh-uuid",
    });
  });

  it("treats an empty `headers` array as a no-op (existing headers preserved)", () => {
    expect(() => applyConfigPatchToWorkflow(httpWithHeaders, "fetch", {
      headers: [],
    })).toThrow(/did not include any config changes/);
  });

  it("treats `headers: null` as a no-op (existing headers preserved)", () => {
    // null gets stripped by stripNullPatchValues — the rest of the patch must carry the actual change.
    const merged = applyConfigPatchToWorkflow(httpWithHeaders, "fetch", {
      headers: null,
      retry: { maxAttempts: 3 },
    });

    const fetchConfig = merged.nodes[0]!.config as { headers?: Record<string, string>; retry?: { maxAttempts: number } };
    expect(fetchConfig.headers).toEqual({ Authorization: "Bearer literal-token", "X-Trace-Id": "abc" });
    expect(fetchConfig.retry?.maxAttempts).toBe(3);
  });

  it("a `headers`-only patch (no other resilience fields) still produces a non-empty merge", () => {
    // Guards the no-op-rejection path: the array fold should produce a
    // non-empty `patchedConfig.headers` record that survives the
    // `Object.keys(...).length === 0` check.
    const merged = applyConfigPatchToWorkflow(httpWithHeaders, "fetch", {
      headers: [{ name: "Authorization", value: "Bearer {{secret.NAME}}" }],
    });
    const fetchConfig = merged.nodes[0]!.config as { headers?: Record<string, string> };
    expect(fetchConfig.headers?.Authorization).toBe("Bearer {{secret.NAME}}");
  });

  it("coerces a non-object `existing.headers` (undefined) to {} before folding", () => {
    const httpNoHeaders = WorkflowSchema.parse({
      dslVersion: "1.0",
      nodes: [{ id: "fetch", type: "http", config: { url: "https://x" } }],
      edges: [],
    }) satisfies Workflow;

    const merged = applyConfigPatchToWorkflow(httpNoHeaders, "fetch", {
      headers: [{ name: "Authorization", value: "Bearer {{secret.NAME}}" }],
    });
    const fetchConfig = merged.nodes[0]!.config as { headers?: Record<string, string> };
    expect(fetchConfig.headers).toEqual({ Authorization: "Bearer {{secret.NAME}}" });
  });

  it("drops non-string existing HTTP header values while folding a header patch", () => {
    const httpWithBadHeader = WorkflowSchema.parse({
      dslVersion: "1.0",
      nodes: [{
        id: "fetch",
        type: "http",
        config: {
          url: "https://x",
          headers: { Authorization: "Bearer literal", "X-Retry": 3 },
        },
      }],
      edges: [],
    }) satisfies Workflow;

    const merged = applyConfigPatchToWorkflow(httpWithBadHeader, "fetch", {
      headers: [{ name: "Authorization", value: "Bearer {{secret.NAME}}" }],
    });
    const fetchConfig = merged.nodes[0]!.config as { headers?: Record<string, unknown> };
    expect(fetchConfig.headers).toEqual({ Authorization: "Bearer {{secret.NAME}}" });
  });

  it("folds a tool `input` array patch against the existing record", () => {
    const merged = applyConfigPatchToWorkflow(toolWithInput, "transform", {
      input: [
        { name: "pattern", value: "\\bfoo\\b" },
        { name: "search", value: "foo" },
        { name: "replacement", value: "bar" },
      ],
    });

    const transformConfig = merged.nodes[0]!.config as { input?: Record<string, unknown> };
    expect(transformConfig.input).toEqual({
      value: "{{context.fetch.output.body}}",
      all: true,
      pattern: "\\bfoo\\b",
      search: "foo",
      replacement: "bar",
    });
  });

  it("rejects pair-array patches that do not change the existing record", () => {
    expect(() => applyConfigPatchToWorkflow(httpWithHeaders, "fetch", {
      headers: [
        { name: "Authorization", value: "Bearer literal-token" },
        { name: "Missing", value: null },
      ],
    })).toThrow(/did not include any config changes/);
  });

  it("a malformed pair item (missing `name`) is treated as no-op (filtered by isNonEmptyPairArray)", () => {
    expect(() => applyConfigPatchToWorkflow(httpWithHeaders, "fetch", {
      headers: [{ value: "x" } as unknown as { name: string; value: string }],
    })).toThrow(/did not include any config changes/);
  });

  it("does NOT fold `input` for non-tool node types (subworkflow's input is a forwarded object, not a pair record)", () => {
    // The generic envelope emits patches for subworkflow / transform /
    // condition / etc. nodes whose `config.input` (or `headers`, if
    // present) has structurally-different semantics than http/tool. The
    // merge layer must pass those through verbatim without coercing.
    const subworkflow = WorkflowSchema.parse({
      dslVersion: "1.0",
      nodes: [
        {
          id: "child",
          type: "subworkflow",
          config: { workflowId: "shared-flow", input: { prior: "value" } },
        },
      ],
      edges: [],
    }) satisfies Workflow;

    const merged = applyConfigPatchToWorkflow(subworkflow, "child", {
      // Even though the field is named `input`, the merge layer must NOT
      // treat it as the array-of-pairs shape — subworkflow input is a
      // forwarded object. Pass through verbatim.
      input: { fresh: "{{context.x.output}}" },
    });

    const childConfig = merged.nodes[0]!.config as { input?: unknown };
    // The patched-config `input` replaces the existing one (shallow merge).
    expect(childConfig.input).toEqual({ fresh: "{{context.x.output}}" });
  });
});
