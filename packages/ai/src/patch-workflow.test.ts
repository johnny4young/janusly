import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { LlmClient, LlmGenerateObjectInput, LlmGenerateObjectResult } from "./llm-client";
import { RUN_EVENT_PROMPT_CAP, suggestWorkflowPatch } from "./patch-workflow";

// The runtime Zod object — used by the helper at call time. Cast at the
// boundary so the schema's inferred shape doesn't trip TS2589 ("type
// instantiation excessively deep") when the tests inline the helper.
const envelopeSchema = z.object({
  workflow: z.object({
    nodes: z.array(z.object({ id: z.string(), type: z.string(), config: z.record(z.string(), z.unknown()).optional() })),
    edges: z.array(z.unknown()).optional(),
  }),
  rationale: z.string().min(1),
}) as unknown as LlmGenerateObjectInput<{ workflow: unknown; rationale: string }>["schema"];

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
  it("returns the LLM's structured workflow + rationale on success", async () => {
    const llm = makeLlm({
      object: {
        workflow: {
          nodes: [{ id: "fetch", type: "http", config: { url: "https://x", retry: { maxAttempts: 3 } } }],
          edges: [],
        },
        rationale: "Added retry to handle the transient ECONNRESET.",
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
    expect(result.rationale).toContain("retry");
    expect(result.model).toBe("claude-haiku-4-5-20251001");
    expect(result.provider).toBe("anthropic");
    expect((result.suggestedWorkflow as { nodes: Array<{ config?: { retry?: unknown } }> }).nodes[0].config?.retry).toBeDefined();
  });
});

describe("suggestWorkflowPatch — fallback paths", () => {
  it("returns fallback when llm is null", async () => {
    const result = await suggestWorkflowPatch({
      llm: null,
      envelopeSchema,
      ...baseInput,
    });
    expect(result.mode).toBe("fallback");
    expect(result.suggestedWorkflow).toEqual(baseInput.workflow);
    expect(result.rationale).toMatch(/AI is unavailable/i);
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
    expect(result.suggestedWorkflow).toEqual(baseInput.workflow);
    expect(result.aiError).toContain("rate limited");
    expect(result.rationale).toContain("rate limited");
  });

  it("returns fallback when LLM returns an empty rationale", async () => {
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
      object: { workflow: baseInput.workflow, rationale: "noop" },
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
      object: { workflow: baseInput.workflow, rationale: "noop" },
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

  it("scrubs secret-shaped string values before sending the prompt", async () => {
    const generateObject = vi.fn(async () => ({
      object: { workflow: baseInput.workflow, rationale: "noop" },
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
