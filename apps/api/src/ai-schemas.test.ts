/**
 * Schema-level tests for the AI generation grammar SPLIT: the free-JSON
 * validation union (`AiGenerationWorkflowSchemaFreeJson`, 13 branches) accepts
 * `parallel_fork` / `join` for direct emission, while the constrained union
 * (`AiGenerationWorkflowSchema`, 11 branches — sent to the provider in
 * `generateObject`) keeps them OUT so Anthropic's compiled-grammar cap holds.
 */
import { describe, expect, it } from "vitest";

import { validateWorkflow } from "@janusly/engine/src/workflow-validation";

import { AiGenerationWorkflowSchema, AiGenerationWorkflowSchemaFreeJson } from "./ai-schemas";

const forkJoinWorkflow = {
  nodes: [
    { id: "fork", type: "parallel_fork", config: { branches: [{ label: "crm" }, { label: "billing" }] } },
    { id: "fetch_crm", type: "http", config: { url: "https://api.example.com/crm" } },
    { id: "fetch_billing", type: "http", config: { url: "https://api.example.com/billing" } },
    { id: "merge", type: "join", config: { sources: { crm: "fetch_crm", billing: "fetch_billing" } } },
  ],
  edges: [
    { from: "fork", to: "fetch_crm" },
    { from: "fork", to: "fetch_billing" },
    { from: "fetch_crm", to: "merge" },
    { from: "fetch_billing", to: "merge" },
  ],
};

describe("AiGenerationWorkflowSchemaFreeJson — direct parallel_fork / join", () => {
  it("accepts a valid fork/join workflow", () => {
    expect(AiGenerationWorkflowSchemaFreeJson.safeParse(forkJoinWorkflow).success).toBe(true);
  });

  it("accepted fork/join config clears the engine structural validator", () => {
    const parsed = AiGenerationWorkflowSchemaFreeJson.parse(forkJoinWorkflow);
    const result = validateWorkflow(parsed, { strictToolInputs: false });
    expect(result.issues.filter((issue) => issue.code === "parallel_fork_invalid_branches" || issue.code === "join_invalid_sources")).toEqual([]);
  });

  it("rejects a parallel_fork with fewer than 2 branches", () => {
    const wf = {
      nodes: [{ id: "fork", type: "parallel_fork", config: { branches: [{ label: "only" }] } }],
      edges: [],
    };
    expect(AiGenerationWorkflowSchemaFreeJson.safeParse(wf).success).toBe(false);
  });

  it("rejects duplicate parallel_fork branch labels", () => {
    const wf = {
      nodes: [{ id: "fork", type: "parallel_fork", config: { branches: [{ label: "same" }, { label: "same" }] } }],
      edges: [],
    };
    expect(AiGenerationWorkflowSchemaFreeJson.safeParse(wf).success).toBe(false);
  });

  it("rejects overlong parallel_fork labels and descriptions", () => {
    const longLabel = "x".repeat(65);
    const longDescription = "x".repeat(281);
    const wf = {
      nodes: [
        {
          id: "fork",
          type: "parallel_fork",
          config: {
            branches: [
              { label: longLabel },
              { label: "ok", description: longDescription },
            ],
          },
        },
      ],
      edges: [],
    };
    expect(AiGenerationWorkflowSchemaFreeJson.safeParse(wf).success).toBe(false);
  });

  it("rejects a join with fewer than 2 sources", () => {
    const wf = {
      nodes: [{ id: "merge", type: "join", config: { sources: { crm: "fetch_crm" } } }],
      edges: [],
    };
    expect(AiGenerationWorkflowSchemaFreeJson.safeParse(wf).success).toBe(false);
  });

  it("rejects empty join labels and source node ids", () => {
    const wf = {
      nodes: [{ id: "merge", type: "join", config: { sources: { "": "fetch_crm", billing: "   " } } }],
      edges: [],
    };
    expect(AiGenerationWorkflowSchemaFreeJson.safeParse(wf).success).toBe(false);
  });

  it("rejects duplicate join predecessor node ids", () => {
    const wf = {
      nodes: [{ id: "merge", type: "join", config: { sources: { crm: "fetch", billing: "fetch" } } }],
      edges: [],
    };
    expect(AiGenerationWorkflowSchemaFreeJson.safeParse(wf).success).toBe(false);
  });

  it("still accepts the 11 base shapes (http)", () => {
    const wf = { nodes: [{ id: "h", type: "http", config: { url: "https://x" } }], edges: [] };
    expect(AiGenerationWorkflowSchemaFreeJson.safeParse(wf).success).toBe(true);
  });
});

describe("AiGenerationWorkflowSchema — constrained grammar stays at 11 (Anthropic grammar cap)", () => {
  it("rejects parallel_fork (kept out of the provider-sent schema)", () => {
    const wf = {
      nodes: [{ id: "fork", type: "parallel_fork", config: { branches: [{ label: "a" }, { label: "b" }] } }],
      edges: [],
    };
    expect(AiGenerationWorkflowSchema.safeParse(wf).success).toBe(false);
  });

  it("rejects join (kept out of the provider-sent schema)", () => {
    const wf = {
      nodes: [{ id: "merge", type: "join", config: { sources: { a: "x", b: "y" } } }],
      edges: [],
    };
    expect(AiGenerationWorkflowSchema.safeParse(wf).success).toBe(false);
  });

  it("still accepts the 11 base shapes (http)", () => {
    const wf = { nodes: [{ id: "h", type: "http", config: { url: "https://x" } }], edges: [] };
    expect(AiGenerationWorkflowSchema.safeParse(wf).success).toBe(true);
  });
});
