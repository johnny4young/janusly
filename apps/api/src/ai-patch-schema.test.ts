import { describe, expect, it } from "vitest";
import { WorkflowSchema } from "@janusly/shared";
import {
  AiGenerationWorkflowSchema,
  AiPatchAgentConfigEnvelope,
  AiPatchGenericConfigEnvelope,
  AiPatchHttpConfigEnvelope,
  AiPatchToolConfigEnvelope,
  patchEnvelopeForNodeType,
} from "./ai-schemas";

describe("patch envelopes — per-failing-node-type single-shape schemas", () => {
  it("http envelope accepts a full resilience patch (all fields populated)", () => {
    const parsed = AiPatchHttpConfigEnvelope.safeParse({
      patchedConfig: {
        url: "https://x.example",
        method: "POST",
        retry: { maxAttempts: 3 },
        timeoutMs: 5_000,
        maxResponseBytes: 1_048_576,
        maxRedirects: 3,
      },
      rationale: "Added retry and raised timeout for transient ECONNRESET.",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.patchedConfig.retry?.maxAttempts).toBe(3);
    expect(parsed.data.patchedConfig.timeoutMs).toBe(5_000);
    expect(parsed.data.patchedConfig.maxResponseBytes).toBe(1_048_576);
    expect(parsed.data.patchedConfig.maxRedirects).toBe(3);
  });

  it("http envelope accepts a 'patch retry only' shape with nulls everywhere else", () => {
    // OpenAI strict mode requires every field to be present (just
    // possibly null). The LLM emits the full shape on every call;
    // omitted-as-null is how it expresses 'don't change this field'.
    const parsed = AiPatchHttpConfigEnvelope.safeParse({
      patchedConfig: {
        url: null,
        method: null,
        retry: { maxAttempts: 2 },
        timeoutMs: null,
        maxResponseBytes: null,
        maxRedirects: null,
      },
      rationale: "Single retry on a 5xx burst.",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.patchedConfig.retry?.maxAttempts).toBe(2);
    expect(parsed.data.patchedConfig.url).toBeNull();
    expect(parsed.data.patchedConfig.timeoutMs).toBeNull();
  });

  it("http envelope rejects retry.maxAttempts below 2 (1 means no retry)", () => {
    const parsed = AiPatchHttpConfigEnvelope.safeParse({
      patchedConfig: {
        url: null, method: null, retry: { maxAttempts: 1 },
        timeoutMs: null, maxResponseBytes: null, maxRedirects: null,
      },
      rationale: "x",
    });
    expect(parsed.success).toBe(false);
  });

  it("http envelope rejects retry.maxAttempts above 10", () => {
    const parsed = AiPatchHttpConfigEnvelope.safeParse({
      patchedConfig: {
        url: null, method: null, retry: { maxAttempts: 99 },
        timeoutMs: null, maxResponseBytes: null, maxRedirects: null,
      },
      rationale: "x",
    });
    expect(parsed.success).toBe(false);
  });

  it("http envelope rejects empty rationale", () => {
    const parsed = AiPatchHttpConfigEnvelope.safeParse({
      patchedConfig: {
        url: "https://x", method: null, retry: null,
        timeoutMs: null, maxResponseBytes: null, maxRedirects: null,
      },
      rationale: "",
    });
    expect(parsed.success).toBe(false);
  });

  it("tool envelope accepts retry + timeout patch (all fields populated)", () => {
    const parsed = AiPatchToolConfigEnvelope.safeParse({
      patchedConfig: {
        tool: "http.request",
        retry: { maxAttempts: 2 },
        timeoutMs: 3_000,
      },
      rationale: "Retry the tool once.",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.patchedConfig.tool).toBe("http.request");
    expect(parsed.data.patchedConfig.retry?.maxAttempts).toBe(2);
    expect(parsed.data.patchedConfig.timeoutMs).toBe(3_000);
  });

  it("tool envelope accepts a partial patch with nulls", () => {
    const parsed = AiPatchToolConfigEnvelope.safeParse({
      patchedConfig: { tool: null, retry: { maxAttempts: 3 }, timeoutMs: null },
      rationale: "Retry the existing tool.",
    });
    expect(parsed.success).toBe(true);
  });

  it("agent envelope accepts goal + retry + timeout patch (all fields populated)", () => {
    const parsed = AiPatchAgentConfigEnvelope.safeParse({
      patchedConfig: {
        goal: "summarize the article",
        retry: { maxAttempts: 2 },
        timeoutMs: 60_000,
      },
      rationale: "Tightened the goal and added retry.",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.patchedConfig.goal).toBe("summarize the article");
    expect(parsed.data.patchedConfig.timeoutMs).toBe(60_000);
  });

  it("generic envelope accepts arbitrary record patches", () => {
    const parsed = AiPatchGenericConfigEnvelope.safeParse({
      patchedConfig: { mapping: { a: "{{context.x.output}}" }, anything: 42 },
      rationale: "Tweaked the transform mapping.",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.patchedConfig.mapping).toEqual({ a: "{{context.x.output}}" });
    expect(parsed.data.patchedConfig.anything).toBe(42);
  });

  it("generic envelope rejects non-object patchedConfig", () => {
    const parsed = AiPatchGenericConfigEnvelope.safeParse({
      patchedConfig: "not an object",
      rationale: "x",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("patchEnvelopeForNodeType — dispatch", () => {
  it("returns the http envelope for http nodes", () => {
    const choice = patchEnvelopeForNodeType("http");
    expect(choice.kind).toBe("http");
    expect(choice.schema).toBe(AiPatchHttpConfigEnvelope);
  });

  it("returns the tool envelope for tool nodes", () => {
    const choice = patchEnvelopeForNodeType("tool");
    expect(choice.kind).toBe("tool");
    expect(choice.schema).toBe(AiPatchToolConfigEnvelope);
  });

  it("returns the agent envelope for agent nodes", () => {
    const choice = patchEnvelopeForNodeType("agent");
    expect(choice.kind).toBe("agent");
    expect(choice.schema).toBe(AiPatchAgentConfigEnvelope);
  });

  it("falls back to the generic envelope for everything else", () => {
    for (const type of ["transform", "condition", "router", "ai", "approval", "noop", "loop", "multi_agent", "unknown_type"]) {
      const choice = patchEnvelopeForNodeType(type);
      expect(choice.kind, `for type=${type}`).toBe("generic");
      expect(choice.schema).toBe(AiPatchGenericConfigEnvelope);
    }
  });
});

describe("AiGenerationWorkflowSchema — generation route stays untouched", () => {
  it("still parses a basic AI-generated workflow shape", () => {
    const parsed = AiGenerationWorkflowSchema.safeParse({
      nodes: [{ id: "fetch", type: "http", config: { url: "https://x" } }],
      edges: [],
    });
    expect(parsed.success).toBe(true);
  });
});

describe("merged config integration — produces a valid engine workflow", () => {
  it("composing a patched config with the original workflow passes WorkflowSchema", () => {
    // Mirrors what the route does: shallow-merge patchedConfig onto the
    // failing node's existing config, leaving other nodes untouched.
    const original = {
      dslVersion: "1.0" as const,
      nodes: [
        { id: "fetch", type: "http" as const, config: { url: "https://x", method: "GET" } },
        { id: "noop", type: "noop" as const, config: {} },
      ],
      edges: [{ from: "fetch", to: "noop" }],
    };
    const patchedConfig = { retry: { maxAttempts: 3 }, timeoutMs: 5_000 };
    const merged = {
      ...original,
      nodes: original.nodes.map((node) =>
        node.id === "fetch" ? { ...node, config: { ...node.config, ...patchedConfig } } : node,
      ),
    };
    const parsed = WorkflowSchema.safeParse(merged);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const fetchNode = parsed.data.nodes.find((n) => n.id === "fetch");
    expect(fetchNode?.config).toMatchObject({
      url: "https://x",
      method: "GET",
      retry: { maxAttempts: 3 },
      timeoutMs: 5_000,
    });
  });
});
