import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { LlmClient, LlmGenerateObjectInput, LlmGenerateObjectResult } from "./llm-client";
import { RUN_EVENT_PROMPT_CAP, STRUCTURAL_PATCH_SYSTEM_PROMPT, suggestWorkflowPatch, type PatchEnvelopeSchemaResult } from "./patch-workflow";

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

  it("threads cacheSystemPrompt to generateObject when requested and defaults it off", async () => {
    const result = {
      object: { suggestions: [{ patchedConfig: {}, rationale: "noop", approachLabel: "other", confidence: 0 }] },
      model: "x",
      provider: "y",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      latencyMs: 10,
    };
    const cached = vi.fn(async () => result);
    await suggestWorkflowPatch({
      llm: { generateText: vi.fn(), generateObject: cached } as unknown as LlmClient,
      envelopeSchema,
      ...baseInput,
      cacheSystemPrompt: true,
    });
    expect((cached.mock.calls[0] as unknown[])[0] as { cacheSystemPrompt?: boolean }).toMatchObject({ cacheSystemPrompt: true });

    const uncached = vi.fn(async () => result);
    await suggestWorkflowPatch({
      llm: { generateText: vi.fn(), generateObject: uncached } as unknown as LlmClient,
      envelopeSchema,
      ...baseInput,
    });
    expect(((uncached.mock.calls[0] as unknown[])[0] as { cacheSystemPrompt?: boolean }).cacheSystemPrompt).toBeUndefined();
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
    expect(callArg.system).toContain("consideredAlternatives");
    expect(callArg.system).toContain("Do not repeat another emitted suggestion");
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
    // Per-type guidance for the non-resilience envelopes (transform /
    // condition / ai / router / approval / loop) — one assertion per
    // node-type bullet so a future prompt edit that drops a section
    // fails the test loudly.
    expect(callArg.system).toContain("TRANSFORM nodes");
    expect(callArg.system).toContain("CONDITION nodes");
    expect(callArg.system).toContain("AI nodes");
    expect(callArg.system).toContain("ROUTER nodes");
    expect(callArg.system).toContain("APPROVAL nodes");
    expect(callArg.system).toContain("LOOP nodes");
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

  it("threads extraContext.pastFeedbackSummary into the prompt body so the LLM sees prior operator decisions", async () => {
    const generateObject = vi.fn(async () => ({
      object: { suggestions: [{ patchedConfig: {}, rationale: "noop", approachLabel: "other", confidence: 0 }] },
      model: "x",
      provider: "y",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      latencyMs: 10,
    }));
    const llm = { generateText: vi.fn(), generateObject } as unknown as LlmClient;

    const pastFeedbackSummary = "Past operator decisions for this workflow: add_retry accepted 0/2 (\"timeout still fires under load\"); raise_timeout accepted 1/1.";

    await suggestWorkflowPatch({
      llm,
      envelopeSchema,
      ...baseInput,
      extraContext: { pastFeedbackSummary },
    });

    const callArg = (generateObject.mock.calls[0] as unknown[])[0] as { prompt: string; system: string };
    // The summary string lands verbatim inside the prompt body (the
    // helper JSON-stringifies extraContext, so the substring is intact).
    expect(callArg.prompt).toContain('"pastFeedbackSummary"');
    expect(callArg.prompt).toContain("add_retry accepted 0/2");
    expect(callArg.prompt).toContain("timeout still fires under load");
    // System prompt teaches the model how to use the field.
    expect(callArg.system).toContain("extraContext.pastFeedbackSummary");
  });

  it("adds operator-guidance instructions only when the bounded block is present", async () => {
    const result = {
      object: { suggestions: [{ patchedConfig: {}, rationale: "noop", approachLabel: "other", confidence: 0 }] },
      model: "x",
      provider: "y",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      latencyMs: 10,
    };
    const withoutGuidance = vi.fn(async () => result);
    await suggestWorkflowPatch({
      llm: { generateText: vi.fn(), generateObject: withoutGuidance } as unknown as LlmClient,
      envelopeSchema,
      ...baseInput,
      extraContext: { pastFeedbackSummary: "Prefer retries." },
    });
    const baselineSystem = ((withoutGuidance.mock.calls[0] as unknown[])[0] as { system: string }).system;
    expect(baselineSystem).not.toContain("OPERATOR GUIDANCE");

    const withGuidance = vi.fn(async () => result);
    await suggestWorkflowPatch({
      llm: { generateText: vi.fn(), generateObject: withGuidance } as unknown as LlmClient,
      envelopeSchema,
      ...baseInput,
      extraContext: { operatorGuidance: "Organization guidance:\n| Prefer bounded retries." },
    });
    const guidedSystem = ((withGuidance.mock.calls[0] as unknown[])[0] as { system: string }).system;
    expect(guidedSystem).toContain("OPERATOR GUIDANCE");
    expect(guidedSystem).toContain("DATA-framed");
    expect(guidedSystem.startsWith(baselineSystem)).toBe(true);
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

describe("suggestWorkflowPatch — structural system prompt override", () => {
  it("ships STRUCTURAL_PATCH_SYSTEM_PROMPT when systemPromptOverride is set", async () => {
    const generateObject = vi.fn(async () => ({
      object: { suggestions: [{
        action: "insert_approval_upstream",
        approvalNodeId: "approve_x",
        approvalMessage: "Approve?",
        insertBeforeNodeId: "fetch",
        rationale: "Write-side action needs approval.",
        approachLabel: "add_approval",
        confidence: 80,
      }] },
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
      systemPromptOverride: STRUCTURAL_PATCH_SYSTEM_PROMPT,
    });

    const callArg = (generateObject.mock.calls[0] as unknown[])[0] as { system: string };
    expect(callArg.system).toBe(STRUCTURAL_PATCH_SYSTEM_PROMPT);
    // The structural prompt teaches the LLM the specific output shape.
    expect(callArg.system).toContain("STRUCTURAL");
    expect(callArg.system).toContain("insert_approval_upstream");
    expect(callArg.system).toContain("approvalNodeId");
    expect(callArg.system).toContain("approvalMessage");
    expect(callArg.system).toContain("insertBeforeNodeId");
    expect(callArg.system).toContain("approachLabel");
    expect(callArg.system).toContain("add_approval");
  });

  it("falls back to the default config-only SYSTEM_PROMPT when no override is set", async () => {
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
    // Default prompt narrates the config-only contract.
    expect(callArg.system).toContain("up to 3 ALTERNATIVE config patches");
    // And does NOT contain the structural-specific language.
    expect(callArg.system).not.toContain("insert_approval_upstream");
  });
});

// Locale propagation: the route forwards the operator's UI locale
// (`Accept-Language`) to the helper so the LLM writes the operator-
// facing free-form fields (rationale / approvalMessage) in that
// language. Machine-contract fields (`approachLabel`, `confidence`,
// `patchedConfig` keys, template tokens) MUST stay verbatim English.
describe("suggestWorkflowPatch — locale instruction", () => {
  // Cast through `unknown` to dodge TS2589 (excessive depth) the same
  // way the AI-mode describe block above does.
  const envelopeSchema = z.object({
    suggestions: z
      .array(z.object({
        patchedConfig: z.record(z.string(), z.unknown()),
        rationale: z.string(),
        approachLabel: z.enum(["other"]),
        confidence: z.number(),
      }))
      .min(1)
      .max(3),
  }) as unknown as LlmGenerateObjectInput<PatchEnvelopeSchemaResult>["schema"];
  const baseInput = {
    workflow: { id: "wf", name: "Demo", nodes: [], edges: [] },
    failedNodeId: "n1",
    errorJson: { message: "boom" },
    runEvents: [] as Array<{ type: string; nodeId?: string | null; payload?: unknown; createdAt?: string | Date | null }>,
  };

  function makeLlm() {
    const generateObject = vi.fn(async () => ({
      object: { suggestions: [{ patchedConfig: {}, rationale: "x", approachLabel: "other", confidence: 0 }] },
      model: "x",
      provider: "y",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      latencyMs: 10,
    }));
    return { generateObject, llm: { generateText: vi.fn(), generateObject } as unknown as LlmClient };
  }

  it("appends nothing when locale is undefined", async () => {
    const { generateObject, llm } = makeLlm();
    await suggestWorkflowPatch({ llm, envelopeSchema, ...baseInput });
    const callArg = (generateObject.mock.calls[0] as unknown[])[0] as { system: string };
    expect(callArg.system).not.toMatch(/IMPORTANT — RESPONSE LANGUAGE/);
  });

  it("appends nothing when locale is 'en'", async () => {
    const { generateObject, llm } = makeLlm();
    await suggestWorkflowPatch({ llm, envelopeSchema, ...baseInput, locale: "en" });
    const callArg = (generateObject.mock.calls[0] as unknown[])[0] as { system: string };
    expect(callArg.system).not.toMatch(/IMPORTANT — RESPONSE LANGUAGE/);
  });

  it("instructs Spanish output when locale is 'es', without changing the schema-fields-stay-English contract", async () => {
    const { generateObject, llm } = makeLlm();
    await suggestWorkflowPatch({ llm, envelopeSchema, ...baseInput, locale: "es" });
    const callArg = (generateObject.mock.calls[0] as unknown[])[0] as { system: string };
    expect(callArg.system).toMatch(/IMPORTANT — RESPONSE LANGUAGE/);
    expect(callArg.system).toContain("Spanish");
    // Machine-contract fields explicitly stay English.
    expect(callArg.system).toContain("approachLabel");
    expect(callArg.system).toContain("patchedConfig");
    // Template tokens and identifiers are flagged as verbatim.
    expect(callArg.system).toContain("{{secret.NAME}}");
  });
});
