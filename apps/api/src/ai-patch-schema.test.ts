import { describe, expect, it } from "vitest";
import { WorkflowSchema } from "@janusly/shared";
import {
  AiGenerationWorkflowSchema,
  AiPatchAgentConfigEnvelope,
  AiPatchGenericConfigEnvelope,
  AiPatchHttpConfigEnvelope,
  AiPatchToolConfigEnvelope,
  PATCH_MAX_SUGGESTIONS,
  patchEnvelopeForNodeType,
} from "./ai-schemas";

const httpItem = (overrides: {
  patchedConfig?: Record<string, unknown>;
  rationale?: string;
  approachLabel?: string;
  confidence?: number;
} = {}) => ({
  patchedConfig: {
    url: null,
    method: null,
    retry: null,
    timeoutMs: null,
    maxResponseBytes: null,
    maxRedirects: null,
    ...(overrides.patchedConfig ?? {}),
  },
  rationale: overrides.rationale ?? "x",
  approachLabel: overrides.approachLabel ?? "other",
  confidence: overrides.confidence ?? 50,
});

describe("patch envelopes — multi-suggestion array form", () => {
  it("http envelope accepts an array with one fully-populated suggestion", () => {
    const parsed = AiPatchHttpConfigEnvelope.safeParse({
      suggestions: [
        {
          patchedConfig: {
            url: "https://x.example",
            method: "POST",
            retry: { maxAttempts: 3 },
            timeoutMs: 5_000,
            maxResponseBytes: 1_048_576,
            maxRedirects: 3,
          },
          rationale: "Added retry and raised timeout for transient ECONNRESET.",
          approachLabel: "add_retry",
          confidence: 85,
        },
      ],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.suggestions).toHaveLength(1);
    expect(parsed.data.suggestions[0]!.patchedConfig.retry?.maxAttempts).toBe(3);
    expect(parsed.data.suggestions[0]!.approachLabel).toBe("add_retry");
    expect(parsed.data.suggestions[0]!.confidence).toBe(85);
  });

  it("http envelope accepts up to 3 alternative suggestions", () => {
    const parsed = AiPatchHttpConfigEnvelope.safeParse({
      suggestions: [
        httpItem({ patchedConfig: { retry: { maxAttempts: 3 } }, approachLabel: "add_retry", confidence: 85, rationale: "first" }),
        httpItem({ patchedConfig: { timeoutMs: 60_000 }, approachLabel: "raise_timeout", confidence: 65, rationale: "second" }),
        httpItem({ patchedConfig: { url: "https://x.example/fixed" }, approachLabel: "fix_url", confidence: 40, rationale: "third" }),
      ],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.suggestions).toHaveLength(3);
    expect(parsed.data.suggestions.map((s) => s.approachLabel)).toEqual(["add_retry", "raise_timeout", "fix_url"]);
  });

  it("http envelope rejects more than PATCH_MAX_SUGGESTIONS items", () => {
    const parsed = AiPatchHttpConfigEnvelope.safeParse({
      suggestions: Array.from({ length: PATCH_MAX_SUGGESTIONS + 1 }, () => httpItem()),
    });
    expect(parsed.success).toBe(false);
  });

  it("http envelope rejects an empty suggestions array", () => {
    const parsed = AiPatchHttpConfigEnvelope.safeParse({ suggestions: [] });
    expect(parsed.success).toBe(false);
  });

  it("http envelope rejects an item with a missing approachLabel", () => {
    const item = httpItem();
    delete (item as Record<string, unknown>).approachLabel;
    const parsed = AiPatchHttpConfigEnvelope.safeParse({ suggestions: [item] });
    expect(parsed.success).toBe(false);
  });

  it("http envelope rejects an item with a missing confidence", () => {
    const item = httpItem();
    delete (item as Record<string, unknown>).confidence;
    const parsed = AiPatchHttpConfigEnvelope.safeParse({ suggestions: [item] });
    expect(parsed.success).toBe(false);
  });

  it("http envelope rejects confidence outside [0, 100]", () => {
    expect(AiPatchHttpConfigEnvelope.safeParse({
      suggestions: [httpItem({ confidence: -1 })],
    }).success).toBe(false);
    expect(AiPatchHttpConfigEnvelope.safeParse({
      suggestions: [httpItem({ confidence: 101 })],
    }).success).toBe(false);
  });

  it("http envelope rejects a non-enum approachLabel", () => {
    const parsed = AiPatchHttpConfigEnvelope.safeParse({
      suggestions: [httpItem({ approachLabel: "fake_label" })],
    });
    expect(parsed.success).toBe(false);
  });

  it("http envelope rejects retry.maxAttempts below 2 (1 means no retry)", () => {
    const parsed = AiPatchHttpConfigEnvelope.safeParse({
      suggestions: [{
        patchedConfig: { url: null, method: null, retry: { maxAttempts: 1 }, timeoutMs: null, maxResponseBytes: null, maxRedirects: null },
        rationale: "x",
        approachLabel: "add_retry",
        confidence: 50,
      }],
    });
    expect(parsed.success).toBe(false);
  });

  it("http envelope rejects retry.maxAttempts above 10", () => {
    const parsed = AiPatchHttpConfigEnvelope.safeParse({
      suggestions: [{
        patchedConfig: { url: null, method: null, retry: { maxAttempts: 99 }, timeoutMs: null, maxResponseBytes: null, maxRedirects: null },
        rationale: "x",
        approachLabel: "add_retry",
        confidence: 50,
      }],
    });
    expect(parsed.success).toBe(false);
  });

  it("http envelope rejects empty rationale", () => {
    const parsed = AiPatchHttpConfigEnvelope.safeParse({
      suggestions: [httpItem({ rationale: "" })],
    });
    expect(parsed.success).toBe(false);
  });

  it("tool envelope accepts retry + timeout suggestions", () => {
    const parsed = AiPatchToolConfigEnvelope.safeParse({
      suggestions: [{
        patchedConfig: { tool: "http.request", retry: { maxAttempts: 2 }, timeoutMs: 3_000 },
        rationale: "Retry the tool once.",
        approachLabel: "add_retry",
        confidence: 70,
      }],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.suggestions[0]!.patchedConfig.tool).toBe("http.request");
  });

  it("tool envelope accepts a partial patch with nulls", () => {
    const parsed = AiPatchToolConfigEnvelope.safeParse({
      suggestions: [{
        patchedConfig: { tool: null, retry: { maxAttempts: 3 }, timeoutMs: null },
        rationale: "Retry the existing tool.",
        approachLabel: "add_retry",
        confidence: 60,
      }],
    });
    expect(parsed.success).toBe(true);
  });

  it("agent envelope accepts goal + retry + timeout patch", () => {
    const parsed = AiPatchAgentConfigEnvelope.safeParse({
      suggestions: [{
        patchedConfig: { goal: "summarize the article", retry: { maxAttempts: 2 }, timeoutMs: 60_000 },
        rationale: "Tightened the goal and added retry.",
        approachLabel: "other",
        confidence: 55,
      }],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.suggestions[0]!.patchedConfig.goal).toBe("summarize the article");
  });

  it("generic envelope accepts arbitrary record patches", () => {
    const parsed = AiPatchGenericConfigEnvelope.safeParse({
      suggestions: [{
        patchedConfig: { mapping: { a: "{{context.x.output}}" }, anything: 42 },
        rationale: "Tweaked the transform mapping.",
        approachLabel: "other",
        confidence: 50,
      }],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.suggestions[0]!.patchedConfig.mapping).toEqual({ a: "{{context.x.output}}" });
    expect(parsed.data.suggestions[0]!.patchedConfig.anything).toBe(42);
  });

  it("generic envelope rejects non-object patchedConfig", () => {
    const parsed = AiPatchGenericConfigEnvelope.safeParse({
      suggestions: [{ patchedConfig: "not an object", rationale: "x", approachLabel: "other", confidence: 0 }],
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
    // Mirrors what the route does: shallow-merge each suggestion's
    // patchedConfig onto the failing node's existing config, leaving
    // other nodes untouched.
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
