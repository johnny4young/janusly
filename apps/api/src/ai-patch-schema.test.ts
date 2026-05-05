import { describe, expect, it } from "vitest";
import { WorkflowSchema } from "@janusly/shared";
import {
  AiGenerationWorkflowSchema,
  AiPatchGenerationWorkflowSchema,
} from "./ai-schemas";

describe("AiPatchGenerationWorkflowSchema — accepts resilience fields", () => {
  it("preserves retry / timeoutMs / maxResponseBytes / maxRedirects on http config", () => {
    const parsed = AiPatchGenerationWorkflowSchema.safeParse({
      nodes: [
        {
          id: "fetch",
          type: "http",
          config: {
            url: "https://x.example",
            method: "GET",
            retry: { maxAttempts: 3 },
            timeoutMs: 5000,
            maxResponseBytes: 1_048_576,
            maxRedirects: 3,
          },
        },
      ],
      edges: [],
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const httpNode = parsed.data.nodes[0];
    expect(httpNode.type).toBe("http");
    if (httpNode.type !== "http") return;
    expect(httpNode.config.retry?.maxAttempts).toBe(3);
    expect(httpNode.config.timeoutMs).toBe(5000);
    expect(httpNode.config.maxResponseBytes).toBe(1_048_576);
    expect(httpNode.config.maxRedirects).toBe(3);
  });

  it("preserves retry / timeoutMs on tool config", () => {
    const parsed = AiPatchGenerationWorkflowSchema.safeParse({
      nodes: [
        {
          id: "lookup",
          type: "tool",
          config: {
            tool: "http.request",
            retry: { maxAttempts: 2 },
            timeoutMs: 3000,
          },
        },
      ],
      edges: [],
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const toolNode = parsed.data.nodes[0];
    expect(toolNode.type).toBe("tool");
    if (toolNode.type !== "tool") return;
    expect(toolNode.config.retry?.maxAttempts).toBe(2);
    expect(toolNode.config.timeoutMs).toBe(3000);
  });

  it("preserves retry / timeoutMs on agent config", () => {
    const parsed = AiPatchGenerationWorkflowSchema.safeParse({
      nodes: [
        {
          id: "summarize",
          type: "agent",
          config: {
            goal: "summarize the article",
            retry: { maxAttempts: 2 },
            timeoutMs: 60_000,
          },
        },
      ],
      edges: [],
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const agentNode = parsed.data.nodes[0];
    expect(agentNode.type).toBe("agent");
    if (agentNode.type !== "agent") return;
    expect(agentNode.config.retry?.maxAttempts).toBe(2);
    expect(agentNode.config.timeoutMs).toBe(60_000);
  });

  it("rejects retry.maxAttempts above the cap of 10", () => {
    const parsed = AiPatchGenerationWorkflowSchema.safeParse({
      nodes: [
        {
          id: "fetch",
          type: "http",
          config: { url: "https://x.example", retry: { maxAttempts: 99 } },
        },
      ],
      edges: [],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects retry without an actionable maxAttempts value", () => {
    const emptyRetry = AiPatchGenerationWorkflowSchema.safeParse({
      nodes: [
        {
          id: "fetch",
          type: "http",
          config: { url: "https://x.example", retry: {} },
        },
      ],
      edges: [],
    });
    expect(emptyRetry.success).toBe(false);

    const noRetry = AiPatchGenerationWorkflowSchema.safeParse({
      nodes: [
        {
          id: "fetch",
          type: "http",
          config: { url: "https://x.example", retry: { maxAttempts: 1 } },
        },
      ],
      edges: [],
    });
    expect(noRetry.success).toBe(false);
  });

  it("still accepts a slim http node with just url + method (no resilience fields)", () => {
    const parsed = AiPatchGenerationWorkflowSchema.safeParse({
      nodes: [
        { id: "fetch", type: "http", config: { url: "https://x.example", method: "GET" } },
      ],
      edges: [],
    });
    expect(parsed.success).toBe(true);
  });
});

describe("AiGenerationWorkflowSchema — strips resilience fields (regression pin)", () => {
  it("parses but does not surface retry / timeoutMs / bounds on http config", () => {
    // Same payload the patch schema accepts. The slim generation schema
    // is intentionally narrower — its `http.config` only declares `url`
    // and optional `method`. Zod's default is to strip extra keys, so
    // the parse succeeds but the `parsed.data` strips the resilience
    // fields. This pin proves the generation route stays slim while the
    // patch route can express the same fields.
    const parsed = AiGenerationWorkflowSchema.safeParse({
      nodes: [
        {
          id: "fetch",
          type: "http",
          config: {
            url: "https://x.example",
            method: "GET",
            retry: { maxAttempts: 3 },
            timeoutMs: 5000,
            maxResponseBytes: 1_048_576,
            maxRedirects: 3,
          },
        },
      ],
      edges: [],
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const node = parsed.data.nodes[0];
    expect(node.type).toBe("http");
    if (node.type !== "http") return;
    expect(node.config).toEqual({ url: "https://x.example", method: "GET" });
    // Zod strips unknown keys in default mode; resilience fields don't
    // show up on the parsed output, so the LLM can't surface them via
    // this schema even if it tries.
    expect((node.config as Record<string, unknown>).retry).toBeUndefined();
    expect((node.config as Record<string, unknown>).timeoutMs).toBeUndefined();
    expect((node.config as Record<string, unknown>).maxResponseBytes).toBeUndefined();
    expect((node.config as Record<string, unknown>).maxRedirects).toBeUndefined();
  });
});

describe("AiPatchGenerationWorkflowSchema — round-trip through the engine's strict schema", () => {
  it("a patch-schema workflow with retry / bounds passes WorkflowSchema unchanged", () => {
    const patchParsed = AiPatchGenerationWorkflowSchema.safeParse({
      dslVersion: "1.0",
      nodes: [
        {
          id: "fetch",
          type: "http",
          config: {
            url: "https://x.example",
            retry: { maxAttempts: 3 },
            timeoutMs: 5000,
            maxResponseBytes: 5_242_880,
          },
        },
      ],
      edges: [],
    });
    expect(patchParsed.success).toBe(true);
    if (!patchParsed.success) return;

    // The engine's strict schema treats `node.config` as
    // `Record<string, unknown>` — resilience fields pass through
    // untouched, which is what lets the engine apply them at runtime.
    const enginedParsed = WorkflowSchema.safeParse(patchParsed.data);
    expect(enginedParsed.success).toBe(true);
    if (!enginedParsed.success) return;

    const engineNode = enginedParsed.data.nodes[0];
    expect(engineNode.config.retry).toEqual({ maxAttempts: 3 });
    expect(engineNode.config.timeoutMs).toBe(5000);
    expect(engineNode.config.maxResponseBytes).toBe(5_242_880);
  });
});
