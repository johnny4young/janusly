import { describe, expect, it, vi } from "vitest";
import type { LlmClient, LlmGenerateTextResult } from "@janusly/ai";
import type { Workflow } from "@janusly/shared";

import {
  FREE_JSON_MAX_ATTEMPTS,
  extractJsonObject,
  generateWorkflowFreeJson,
  missingPromptTemplateReferences,
  parseGeneratedWorkflow,
  promptTemplateReferences,
} from "./ai-generate-freejson";

const VALID_WORKFLOW: Workflow = {
  dslVersion: "1.0",
  id: "wf-test",
  name: "Test flow",
  nodes: [{ id: "n1", type: "http", config: { url: "https://example.com" } }],
  edges: [],
};
const VALID_JSON = JSON.stringify(VALID_WORKFLOW);

function textResult(text: string): LlmGenerateTextResult {
  return {
    text,
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    providerSimulated: false,
    latencyMs: 5,
    usage: {},
  };
}

// Mock LlmClient whose generateText returns queued replies in order.
function makeLlm(...texts: string[]): LlmClient {
  const queue = [...texts];
  return {
    generateText: vi.fn(async () => textResult(queue.shift() ?? "")),
    generateObject: vi.fn(),
  } as unknown as LlmClient;
}

describe("extractJsonObject", () => {
  it("returns clean JSON unchanged", () => {
    expect(extractJsonObject(VALID_JSON)).toBe(VALID_JSON);
  });
  it("strips markdown fences", () => {
    const fenced = "```json\n" + VALID_JSON + "\n```";
    expect(JSON.parse(extractJsonObject(fenced))).toEqual(VALID_WORKFLOW);
  });
  it("slices to the outermost object when wrapped in prose", () => {
    const wrapped = `Here is your workflow:\n${VALID_JSON}\nHope that helps!`;
    expect(JSON.parse(extractJsonObject(wrapped))).toEqual(VALID_WORKFLOW);
  });
});

describe("parseGeneratedWorkflow", () => {
  it("parses a valid workflow", () => {
    const wf = parseGeneratedWorkflow(VALID_JSON);
    expect(wf).not.toBeNull();
    expect(wf?.nodes[0]?.type).toBe("http");
  });
  it("parses a fenced valid workflow", () => {
    expect(parseGeneratedWorkflow("```json\n" + VALID_JSON + "\n```")).not.toBeNull();
  });
  it("parses direct free-JSON parallel_fork and join nodes", () => {
    const parallelJson = JSON.stringify({
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
    });
    const wf = parseGeneratedWorkflow(parallelJson);
    expect(wf?.nodes.map((node) => node.type)).toContain("parallel_fork");
    expect(wf?.nodes.map((node) => node.type)).toContain("join");
  });
  it("preserves HTTP headers and bounded JSON bodies", () => {
    const wf = parseGeneratedWorkflow(JSON.stringify({
      nodes: [{
        id: "charge",
        type: "http",
        config: {
          url: "https://billing.example.com/charges",
          method: "POST",
          headers: {
            Authorization: "{{secret.BILLING_API_TOKEN}}",
            "Content-Type": "application/json",
          },
          body: {
            customerId: "{{context.input.customerId}}",
            amount: "{{context.input.amount}}",
          },
        },
      }],
      edges: [],
    }));
    expect(wf?.nodes[0]?.config).toMatchObject({
      headers: { Authorization: "{{secret.BILLING_API_TOKEN}}" },
      body: {
        customerId: "{{context.input.customerId}}",
        amount: "{{context.input.amount}}",
      },
    });
  });
  it("returns null on malformed JSON", () => {
    expect(parseGeneratedWorkflow("{ not valid json ]")).toBeNull();
  });
  it("returns null when the shape is outside the generation subset", () => {
    // `type: "totally_unknown"` is not in the 13-branch free-JSON union.
    expect(parseGeneratedWorkflow('{"nodes":[{"id":"n1","type":"totally_unknown","config":{}}],"edges":[]}')).toBeNull();
  });
  it("returns null on empty text", () => {
    expect(parseGeneratedWorkflow("")).toBeNull();
  });
});

describe("prompt template fidelity", () => {
  it("extracts supported references once and reports omissions", () => {
    const prompt = [
      "{{secret.BILLING_API_TOKEN}}",
      "{{context.fetch.output.id}}",
      "{{secret.BILLING_API_TOKEN}}",
      "{{unsupported.value}}",
    ].join(" ");
    expect(promptTemplateReferences(prompt)).toEqual([
      "{{secret.BILLING_API_TOKEN}}",
      "{{context.fetch.output.id}}",
    ]);
    expect(missingPromptTemplateReferences(prompt, VALID_WORKFLOW)).toEqual([
      "{{secret.BILLING_API_TOKEN}}",
      "{{context.fetch.output.id}}",
    ]);
  });
});

describe("generateWorkflowFreeJson", () => {
  const ctx = { orgId: "org-1", userId: "user-1" };

  it("returns the workflow on the first attempt", async () => {
    const llm = makeLlm(VALID_JSON);
    const res = await generateWorkflowFreeJson(llm, "sys", "make a flow", undefined, ctx);
    expect(res.attempts).toBe(1);
    expect(res.model).toBe("claude-haiku-4-5-20251001");
    expect(res.workflow.nodes[0]?.type).toBe("http");
    expect(llm.generateText).toHaveBeenCalledTimes(1);
  });

  it("retries and succeeds on the second attempt after a bad reply", async () => {
    const llm = makeLlm("not json at all", VALID_JSON);
    const res = await generateWorkflowFreeJson(llm, "sys", "make a flow", undefined, ctx);
    expect(res.attempts).toBe(2);
    expect(llm.generateText).toHaveBeenCalledTimes(2);
    // The retry appends a corrective nudge to the prompt.
    const secondCall = (llm.generateText as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(secondCall.prompt).toContain("Return ONLY the JSON workflow object");
  });

  it("retries a valid draft that dropped an operator-supplied reference", async () => {
    const reference = "{{secret.BILLING_API_TOKEN}}";
    const corrected = JSON.stringify({
      ...VALID_WORKFLOW,
      nodes: [{
        id: "n1",
        type: "http",
        config: {
          url: "https://example.com",
          headers: { Authorization: reference },
        },
      }],
    });
    const llm = makeLlm(VALID_JSON, corrected);
    const result = await generateWorkflowFreeJson(
      llm,
      "sys",
      `POST with Authorization ${reference}`,
      undefined,
      ctx,
    );
    expect(result.attempts).toBe(2);
    expect(result.workflow.nodes[0]?.config).toMatchObject({
      headers: { Authorization: reference },
    });
    const secondCall = (llm.generateText as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(secondCall.prompt).toContain(
      `Preserve these exact references byte-for-byte in the relevant config values: ${reference}`,
    );
  });

  it("throws after exhausting attempts so the caller degrades to fallback", async () => {
    const llm = makeLlm("garbage", "still garbage");
    await expect(generateWorkflowFreeJson(llm, "sys", "make a flow", undefined, ctx)).rejects.toThrow(
      /no valid workflow after 2 attempts/,
    );
    expect(llm.generateText).toHaveBeenCalledTimes(FREE_JSON_MAX_ATTEMPTS);
  });

  it("threads responseFormat json and the model hint to generateText", async () => {
    const llm = makeLlm(VALID_JSON);
    await generateWorkflowFreeJson(llm, "sys", "p", "anthropic/claude-sonnet-4-6", ctx);
    const firstCall = (llm.generateText as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(firstCall.responseFormat).toBe("json");
    expect(firstCall.modelHint).toBe("anthropic/claude-sonnet-4-6");
    expect(firstCall.context).toEqual(ctx);
  });

  it("threads cacheSystemPrompt when requested and defaults it off", async () => {
    const cached = makeLlm(VALID_JSON);
    await generateWorkflowFreeJson(cached, "sys", "p", undefined, ctx, true);
    expect((cached.generateText as ReturnType<typeof vi.fn>).mock.calls[0][0].cacheSystemPrompt).toBe(true);

    const uncached = makeLlm(VALID_JSON);
    await generateWorkflowFreeJson(uncached, "sys", "p", undefined, ctx);
    expect((uncached.generateText as ReturnType<typeof vi.fn>).mock.calls[0][0].cacheSystemPrompt).toBe(false);
  });
});
