import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { LlmClient, LlmGenerateObjectInput, LlmGenerateObjectResult } from "./llm-client";
import { RUN_EVENT_PROMPT_CAP, suggestWorkflowPatch, type PatchEnvelopeSchemaResult } from "./patch-workflow";

// The runtime Zod object — used by the helper at call time. Mirrors
// the per-failing-node-type envelope shape the route picks (a single
// non-union envelope wrapping a 1-3 `suggestions` array). Cast at the
// boundary so the schema's inferred shape doesn't trip TS2589 ("type
// instantiation excessively deep") when the tests inline the helper.
const envelopeSchema = z.object({
  suggestions: z.array(z.object({
    patchedConfig: z.record(z.string(), z.unknown()),
    rationale: z.string().min(1),
    approachLabel: z.enum(["add_retry", "raise_timeout", "swap_secret_ref", "add_approval", "fix_url", "other"]),
    confidence: z.number().int().min(0).max(100),
  })).min(1).max(3),
}) as unknown as LlmGenerateObjectInput<PatchEnvelopeSchemaResult>["schema"];

const baseInput = {
  workflow: {
    nodes: [{ id: "fetch", type: "http", config: { url: "https://x" } }],
    edges: [],
  },
  failedNodeId: "fetch",
  errorJson: { message: "ECONNRESET" },
  runEvents: [
    { type: "run.started", createdAt: "2026-04-01T10:00:00Z" },
    { type: "node.failed", nodeId: "fetch", createdAt: "2026-04-01T10:00:02Z" },
  ],
};

function makeLlm(result: LlmGenerateObjectResult<unknown>): LlmClient {
  return {
    generateText: vi.fn(),
    generateObject: vi.fn(async () => result as LlmGenerateObjectResult<never>),
  } as unknown as LlmClient;
}

describe("suggestWorkflowPatch — AI mode", () => {
  it("returns the structured suggestions array on success", async () => {
    const llm = makeLlm({
      object: {
        suggestions: [
          {
            patchedConfig: { retry: { maxAttempts: 3 } },
            rationale: "Added retry to handle the transient ECONNRESET.",
            approachLabel: "add_retry",
            confidence: 85,
          },
          {
            patchedConfig: { timeoutMs: 60000 },
            rationale: "Or raise the timeout if upstream is just slow.",
            approachLabel: "raise_timeout",
            confidence: 60,
          },
        ],
      },
      model: "claude-haiku-4-5-20251001",
      provider: "anthropic",
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      latencyMs: 200,
    });

    const result = await suggestWorkflowPatch({
      llm,
      envelopeSchema,
      ...baseInput,
    });

    expect(result.mode).toBe("ai");
    expect(result.model).toBe("claude-haiku-4-5-20251001");
    expect(result.provider).toBe("anthropic");
    expect(result.suggestions).toHaveLength(2);
    expect(result.suggestions[0]!.approachLabel).toBe("add_retry");
    expect(result.suggestions[0]!.confidence).toBe(85);
    expect(result.suggestions[0]!.rationale).toContain("retry");
    const firstPatch = result.suggestions[0]!.patchedConfig as { retry?: { maxAttempts?: number } };
    expect(firstPatch.retry?.maxAttempts).toBe(3);
    expect(result.suggestions[1]!.approachLabel).toBe("raise_timeout");
  });

  it("preserves the model's order of suggestions verbatim (route owns confidence-desc sort)", async () => {
    const llm = makeLlm({
      object: {
        suggestions: [
          { patchedConfig: { retry: { maxAttempts: 3 } }, rationale: "first", approachLabel: "add_retry", confidence: 40 },
          { patchedConfig: { timeoutMs: 60000 }, rationale: "second", approachLabel: "raise_timeout", confidence: 90 },
        ],
      },
      model: "x",
      provider: "anthropic",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      latencyMs: 10,
    });

    const result = await suggestWorkflowPatch({ llm, envelopeSchema, ...baseInput });
    // The helper does NOT sort. The route sorts after merging; helper
    // boundary stays neutral so a future change to the sort key (e.g.
    // calibrated confidence from operator feedback) lives entirely in the route.
    expect(result.suggestions[0]!.confidence).toBe(40);
    expect(result.suggestions[1]!.confidence).toBe(90);
  });
});

describe("suggestWorkflowPatch — fallback paths", () => {
  it("returns a single 0-confidence 'other' suggestion when llm is null", async () => {
    const result = await suggestWorkflowPatch({
      llm: null,
      envelopeSchema,
      ...baseInput,
    });
    expect(result.mode).toBe("fallback");
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]!.approachLabel).toBe("other");
    expect(result.suggestions[0]!.confidence).toBe(0);
    expect(result.suggestions[0]!.patchedConfig).toEqual({});
    expect(result.suggestions[0]!.rationale).toMatch(/AI is unavailable/i);
    expect(result.aiError).toBeUndefined();
  });

  it("returns fallback when LLM throws", async () => {
    const llm = {
      generateText: vi.fn(),
      generateObject: vi.fn(async () => {
        throw new Error("Anthropic 429: rate limited");
      }),
    } as unknown as LlmClient;

    const result = await suggestWorkflowPatch({
      llm,
      envelopeSchema,
      ...baseInput,
    });
    expect(result.mode).toBe("fallback");
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]!.confidence).toBe(0);
    expect(result.aiError).toContain("rate limited");
    expect(result.suggestions[0]!.rationale).toContain("rate limited");
  });

  it("returns fallback when LLM throws a structured-output validation error", async () => {
    // Edge case: provider returned object that doesn't satisfy the
    // schema. The Vercel AI SDK throws `NoObjectGeneratedError` in
    // this case; we exercise the same path here via a thrown error.
    const llm = {
      generateText: vi.fn(),
      generateObject: vi.fn(async () => {
        throw new Error("NoObjectGeneratedError: rationale failed validation");
      }),
    } as unknown as LlmClient;

    const result = await suggestWorkflowPatch({
      llm,
      envelopeSchema,
      ...baseInput,
    });
    expect(result.mode).toBe("fallback");
    expect(result.aiError).toContain("rationale failed validation");
  });
});

describe("suggestWorkflowPatch — prompt content", () => {
  it("truncates run events to RUN_EVENT_PROMPT_CAP", async () => {
    const generateObject = vi.fn(async () => ({
      object: { suggestions: [{ patchedConfig: {}, rationale: "noop", approachLabel: "other", confidence: 0 }] },
      model: "x",
      provider: "y",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      latencyMs: 10,
    }));
    const llm = { generateText: vi.fn(), generateObject } as unknown as LlmClient;

    const longEvents = Array.from({ length: 50 }, (_, i) => ({
      type: `event-${i}`,
      createdAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
    }));

    await suggestWorkflowPatch({
      llm,
      envelopeSchema,
      ...baseInput,
      runEvents: longEvents,
    });

    const callArg = (generateObject.mock.calls[0] as unknown[])[0] as { prompt: string };
    expect(callArg.prompt).toContain("event-0");
    expect(callArg.prompt).toContain(`event-${RUN_EVENT_PROMPT_CAP - 1}`);
    expect(callArg.prompt).not.toContain(`event-${RUN_EVENT_PROMPT_CAP}`);
  });

  it("includes the failedNodeId + already-redacted errorJson in the prompt", async () => {
    const generateObject = vi.fn(async () => ({
      object: { suggestions: [{ patchedConfig: {}, rationale: "noop", approachLabel: "other", confidence: 0 }] },
      model: "x",
      provider: "y",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      latencyMs: 10,
    }));
    const llm = { generateText: vi.fn(), generateObject } as unknown as LlmClient;

    await suggestWorkflowPatch({
      llm,
      envelopeSchema,
      ...baseInput,
      errorJson: { Authorization: "[redacted]", message: "401 unauthorized" },
    });

    const callArg = (generateObject.mock.calls[0] as unknown[])[0] as { prompt: string };
    expect(callArg.prompt).toContain('"failedNodeId":"fetch"');
    expect(callArg.prompt).toContain('"[redacted]"');
    expect(callArg.prompt).toContain('"401 unauthorized"');
  });

  it("instructs the model to emit 1-3 suggestions with approachLabel + confidence", async () => {
    const generateObject = vi.fn(async () => ({
      object: { suggestions: [{ patchedConfig: {}, rationale: "noop", approachLabel: "other", confidence: 0 }] },
      model: "x",
      provider: "y",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      latencyMs: 10,
    }));
    const llm = { generateText: vi.fn(), generateObject } as unknown as LlmClient;

    await suggestWorkflowPatch({
      llm,
      envelopeSchema,
      ...baseInput,
    });

    const callArg = (generateObject.mock.calls[0] as unknown[])[0] as { system: string };
    expect(callArg.system).toContain("up to 3 ALTERNATIVE config patches");
    expect(callArg.system).toContain("set unchanged fields to `null`");
    expect(callArg.system).toContain("filters `null` before shallow-merging");
    expect(callArg.system).toContain("approachLabel");
    expect(callArg.system).toContain("confidence");
    // Headers + tool input array-of-pairs patch shape: the prompt names
    // both surfaces, the {{secret.NAME}} template guidance, and the
    // `swap_secret_ref` clarification.
    expect(callArg.system).toContain("Headers (HTTP) and tool inputs use an `Array<{ name, value }>` patch form");
    expect(callArg.system).toContain("{{secret.NAME}}");
    expect(callArg.system).toContain('{ name: "search", value: "<text-or-pattern>" }');
    expect(callArg.system).toContain("`approachLabel: \"swap_secret_ref\"` is the right tag");
    // Tool-failure contract: the prompt names the `extraContext.toolInputContract`
    // field and tells the LLM to use the `required` / `optional` field names
    // verbatim instead of guessing from the runtime error message.
    expect(callArg.system).toContain("extraContext.toolInputContract");
    expect(callArg.system).toContain("USE THE `required` AND `optional` FIELD NAMES VERBATIM");
  });

  it("threads extraContext.toolInputContract verbatim into the prompt body", async () => {
    const generateObject = vi.fn(async () => ({
      object: { suggestions: [{ patchedConfig: {}, rationale: "noop", approachLabel: "other", confidence: 0 }] },
      model: "x",
      provider: "y",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      latencyMs: 10,
    }));
    const llm = { generateText: vi.fn(), generateObject } as unknown as LlmClient;

    await suggestWorkflowPatch({
      llm,
      envelopeSchema,
      ...baseInput,
      extraContext: {
        toolInputContract: {
          name: "text.replace",
          description: "Replace literal occurrences of a substring (all by default).",
          required: ["value", "search", "replacement"],
          optional: ["all"],
          inputExample: { value: "hello world", search: "world", replacement: "there" },
        },
      },
    });

    const callArg = (generateObject.mock.calls[0] as unknown[])[0] as { prompt: string };
    expect(callArg.prompt).toContain('"toolInputContract"');
    expect(callArg.prompt).toContain('"name":"text.replace"');
    expect(callArg.prompt).toContain('"value"');
    expect(callArg.prompt).toContain('"search"');
    expect(callArg.prompt).toContain('"replacement"');
  });

  it("scrubs secret-shaped string values before sending the prompt", async () => {
    const generateObject = vi.fn(async () => ({
      object: { suggestions: [{ patchedConfig: {}, rationale: "noop", approachLabel: "other", confidence: 0 }] },
      model: "x",
      provider: "y",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      latencyMs: 10,
    }));
    const llm = { generateText: vi.fn(), generateObject } as unknown as LlmClient;
    const bearer = "Bearer abcdefghijklmnopqrstuvwxyz";
    const openAiKey = "sk-aaaaaaaaaaaaaaaaaaaaaaaa";
    const githubToken = "ghp_bbbbbbbbbbbbbbbbbbbbbbbb";
    const slackToken = "xoxb-cccccccccccccccc";

    await suggestWorkflowPatch({
      llm,
      envelopeSchema,
      ...baseInput,
      workflow: {
        nodes: [{ id: "fetch", type: "http", config: { url: `https://example.test?token=${openAiKey}` } }],
        edges: [],
      },
      errorJson: { message: `upstream echoed ${bearer}` },
      runEvents: [{ type: "node.failed", payload: { body: `${githubToken} ${slackToken}` } }],
    });

    const callArg = (generateObject.mock.calls[0] as unknown[])[0] as { prompt: string };
    expect(callArg.prompt).not.toContain(bearer);
    expect(callArg.prompt).not.toContain(openAiKey);
    expect(callArg.prompt).not.toContain(githubToken);
    expect(callArg.prompt).not.toContain(slackToken);
    expect(callArg.prompt).toContain("[redacted]");
  });
});
