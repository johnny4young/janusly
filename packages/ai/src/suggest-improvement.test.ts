import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { LlmClient, LlmGenerateObjectInput, LlmGenerateObjectResult } from "./llm-client";
import { suggestWorkflowImprovement, type SuggestEnvelopeSchemaResult } from "./suggest-improvement";

// Loose runtime envelope shape for the helper — the route owns the
// strict version. Same boundary trick as `patch-workflow.test.ts` to
// dodge TS2589 from inlining the deeper provider-strict schema.
const envelopeSchema = z.object({
  suggestions: z.array(z.object({
    patchedWorkflowJson: z.string().min(1),
    rationale: z.string().min(1),
    approachLabel: z.enum([
      "add_retry",
      "raise_timeout",
      "swap_secret_ref",
      "add_approval",
      "add_observability",
      "simplify",
      "other",
    ]),
    confidence: z.number().int().min(0).max(100),
  })).min(1).max(3),
}) as unknown as LlmGenerateObjectInput<SuggestEnvelopeSchemaResult>["schema"];

const baseWorkflow = {
  id: "wf-improve-me",
  name: "Test workflow",
  nodes: [
    { id: "fetch", type: "http", config: { url: "https://example.com/api" } },
    { id: "post", type: "http", config: { url: "https://example.com/write", method: "POST" } },
  ],
  edges: [{ from: "fetch", to: "post" }],
};

function makeLlm(result: LlmGenerateObjectResult<unknown>): LlmClient {
  return {
    generateText: vi.fn(),
    generateObject: vi.fn(async () => result as LlmGenerateObjectResult<never>),
  } as unknown as LlmClient;
}

describe("suggestWorkflowImprovement — fallback when no LLM", () => {
  it("returns mode: fallback with original workflow when llm is null", async () => {
    const result = await suggestWorkflowImprovement({
      llm: null,
      envelopeSchema,
      workflow: baseWorkflow,
    });

    expect(result.mode).toBe("fallback");
    expect(result.aiError).toBeUndefined();
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]!.confidence).toBe(0);
    expect(result.suggestions[0]!.approachLabel).toBe("other");
    expect(JSON.parse(result.suggestions[0]!.patchedWorkflowJson)).toEqual(baseWorkflow);
    expect(result.suggestions[0]!.rationale).toContain("AI is unavailable");
  });
});

describe("suggestWorkflowImprovement — AI mode happy path", () => {
  it("returns the structured suggestion array on success", async () => {
    const improvedWorkflow = {
      ...baseWorkflow,
      nodes: [
        { ...baseWorkflow.nodes[0], config: { ...baseWorkflow.nodes[0]!.config, retry: { maxAttempts: 3 } } },
        baseWorkflow.nodes[1],
      ],
    };
    const approvalWorkflow = {
      ...baseWorkflow,
      nodes: [
        baseWorkflow.nodes[0],
        { id: "approve-write", type: "approval", config: { message: "Approve external write?" } },
        baseWorkflow.nodes[1],
      ],
      edges: [
        { from: "fetch", to: "approve-write" },
        { from: "approve-write", to: "post" },
      ],
    };
    const llm = makeLlm({
      object: {
        suggestions: [
          {
            patchedWorkflowJson: JSON.stringify(improvedWorkflow),
            rationale: "Add retry to fetch — handles transient 5xx and ECONNRESET.",
            approachLabel: "add_retry",
            confidence: 80,
          },
          {
            patchedWorkflowJson: JSON.stringify(approvalWorkflow),
            rationale: "Insert an approval before the write step so the operator confirms external mutations.",
            approachLabel: "add_approval",
            confidence: 70,
          },
        ],
      },
      model: "claude-haiku-4-5-20251001",
      provider: "anthropic",
      providerSimulated: false,
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      latencyMs: 200,
    });

    const result = await suggestWorkflowImprovement({
      llm,
      envelopeSchema,
      workflow: baseWorkflow,
    });

    expect(result.mode).toBe("ai");
    expect(result.model).toBe("claude-haiku-4-5-20251001");
    expect(result.provider).toBe("anthropic");
    expect(result.suggestions).toHaveLength(2);
    expect(result.suggestions[0]!.approachLabel).toBe("add_retry");
    expect(result.suggestions[0]!.confidence).toBe(80);
    expect(JSON.parse(result.suggestions[0]!.patchedWorkflowJson)).toEqual(improvedWorkflow);
    expect(result.suggestions[1]!.approachLabel).toBe("add_approval");
    expect(result.suggestions[1]!.confidence).toBe(70);
    expect(JSON.parse(result.suggestions[1]!.patchedWorkflowJson)).toEqual(approvalWorkflow);
  });

  it("forwards focus into the prompt body when provided", async () => {
    const llm = makeLlm({
      object: { suggestions: [{
        patchedWorkflowJson: JSON.stringify(baseWorkflow),
        rationale: "ok",
        approachLabel: "simplify",
        confidence: 50,
      }] },
      model: "m",
      provider: "anthropic",
      providerSimulated: false,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      latencyMs: 1,
    });

    await suggestWorkflowImprovement({
      llm,
      envelopeSchema,
      workflow: baseWorkflow,
      focus: "tighten secret references",
    });

    // The prompt body is JSON; assert focus appears verbatim.
    const generateObjectMock = llm.generateObject as unknown as ReturnType<typeof vi.fn>;
    const callArgs = generateObjectMock.mock.calls[0]![0] as { prompt: string };
    expect(callArgs.prompt).toContain("tighten secret references");
  });

  it("trims focus longer than 200 chars before sending", async () => {
    const longFocus = "x".repeat(300);
    const llm = makeLlm({
      object: { suggestions: [{
        patchedWorkflowJson: JSON.stringify(baseWorkflow),
        rationale: "ok",
        approachLabel: "simplify",
        confidence: 50,
      }] },
      model: "m",
      provider: "anthropic",
      providerSimulated: false,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      latencyMs: 1,
    });

    await suggestWorkflowImprovement({
      llm,
      envelopeSchema,
      workflow: baseWorkflow,
      focus: longFocus,
    });

    const generateObjectMock = llm.generateObject as unknown as ReturnType<typeof vi.fn>;
    const callArgs = generateObjectMock.mock.calls[0]![0] as { prompt: string };
    // Find the focus token in the JSON-encoded prompt.
    const parsed = JSON.parse(callArgs.prompt) as { focus?: string };
    expect(parsed.focus?.length).toBeLessThanOrEqual(200);
  });
});

describe("suggestWorkflowImprovement — AI mode failure paths", () => {
  it("degrades to fallback when generateObject throws", async () => {
    const llm = {
      generateText: vi.fn(),
      generateObject: vi.fn(async () => { throw new Error("upstream rate limit"); }),
    } as unknown as LlmClient;

    const result = await suggestWorkflowImprovement({
      llm,
      envelopeSchema,
      workflow: baseWorkflow,
    });

    expect(result.mode).toBe("fallback");
    expect(result.aiError).toBe("upstream rate limit");
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]!.approachLabel).toBe("other");
    expect(result.suggestions[0]!.confidence).toBe(0);
    expect(JSON.parse(result.suggestions[0]!.patchedWorkflowJson)).toEqual(baseWorkflow);
    expect(result.suggestions[0]!.rationale).toContain("upstream rate limit");
  });

  it("scrubs secret-shaped tokens from the workflow before sending to the LLM", async () => {
    const workflowWithToken = {
      ...baseWorkflow,
      nodes: [
        {
          id: "auth",
          type: "http",
          config: {
            url: "https://example.com/api",
            headers: { Authorization: "Bearer sk-1234567890abcdefghij1234567890abcdef" },
          },
        },
      ],
      edges: [],
    };
    const llm = makeLlm({
      object: { suggestions: [{
        patchedWorkflowJson: JSON.stringify(workflowWithToken),
        rationale: "ok",
        approachLabel: "swap_secret_ref",
        confidence: 80,
      }] },
      model: "m",
      provider: "anthropic",
      providerSimulated: false,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      latencyMs: 1,
    });

    await suggestWorkflowImprovement({
      llm,
      envelopeSchema,
      workflow: workflowWithToken,
    });

    const generateObjectMock = llm.generateObject as unknown as ReturnType<typeof vi.fn>;
    const callArgs = generateObjectMock.mock.calls[0]![0] as { prompt: string };
    expect(callArgs.prompt).toContain("[redacted]");
    expect(callArgs.prompt).not.toContain("sk-1234567890abcdefghij1234567890abcdef");
  });
});

describe("suggestWorkflowImprovement — system prompt pinning", () => {
  it("instructs the model to emit 1-3 distinct high-impact suggestions with stable node ids", async () => {
    const llm = makeLlm({
      object: { suggestions: [{
        patchedWorkflowJson: JSON.stringify(baseWorkflow),
        rationale: "ok",
        approachLabel: "simplify",
        confidence: 50,
      }] },
      model: "m",
      provider: "anthropic",
      providerSimulated: false,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      latencyMs: 1,
    });

    await suggestWorkflowImprovement({
      llm,
      envelopeSchema,
      workflow: baseWorkflow,
    });

    const generateObjectMock = llm.generateObject as unknown as ReturnType<typeof vi.fn>;
    const callArgs = generateObjectMock.mock.calls[0]![0] as { system: string };
    expect(callArgs.system).toContain("Produce 1-3 distinct high-impact improved workflows");
    expect(callArgs.system).toContain("array of 1 to 3 items");
    expect(callArgs.system).toContain("MOST-IMPACTFUL angles");
    expect(callArgs.system).toContain("Keep node ids stable");
    expect(callArgs.system).toContain("0-100 integer self-rating");
    expect(callArgs.system).toContain("DO NOT include any literal secret values");
  });
});

describe("suggestWorkflowImprovement — system-prompt caching", () => {
  const aiResult = {
    object: { suggestions: [{ patchedWorkflowJson: JSON.stringify(baseWorkflow), rationale: "ok", approachLabel: "other", confidence: 10 }] },
    model: "x",
    provider: "y",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    latencyMs: 10,
  };

  it("threads cacheSystemPrompt to generateObject when requested and defaults it off", async () => {
    const cached = vi.fn(async () => aiResult);
    await suggestWorkflowImprovement({
      llm: { generateText: vi.fn(), generateObject: cached } as unknown as LlmClient,
      envelopeSchema,
      workflow: baseWorkflow,
      cacheSystemPrompt: true,
    });
    expect((cached.mock.calls[0] as unknown[])[0] as { cacheSystemPrompt?: boolean }).toMatchObject({ cacheSystemPrompt: true });

    const uncached = vi.fn(async () => aiResult);
    await suggestWorkflowImprovement({
      llm: { generateText: vi.fn(), generateObject: uncached } as unknown as LlmClient,
      envelopeSchema,
      workflow: baseWorkflow,
    });
    expect(((uncached.mock.calls[0] as unknown[])[0] as { cacheSystemPrompt?: boolean }).cacheSystemPrompt).toBeUndefined();
  });
});
