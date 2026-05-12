import { describe, expect, it, vi } from "vitest";
import type { Workflow } from "@janusly/shared";
import type { LlmClient, LlmGenerateObjectResult } from "./llm-client";
import { promoteNoopPlaceholders } from "./promote-noop";

function makeLlm(...returns: Array<LlmGenerateObjectResult<unknown> | Error>): LlmClient {
  const queue = [...returns];
  return {
    generateText: vi.fn(),
    generateObject: vi.fn(async () => {
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next as LlmGenerateObjectResult<never>;
    }),
  } as unknown as LlmClient;
}

function durationResult(duration: string): LlmGenerateObjectResult<{ duration: string }> {
  return {
    object: { duration },
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    latencyMs: 12,
  };
}

const baseContext = { orgId: "org-1", userId: "user-1" };

function workflow(nodes: Workflow["nodes"], edges: Workflow["edges"] = []): Workflow {
  return {
    dslVersion: "1.0",
    nodes,
    edges,
  } as Workflow;
}

describe("promoteNoopPlaceholders — happy path", () => {
  it("flips a wait-prefixed noop into a typed wait_until node", async () => {
    const llm = makeLlm(durationResult("P3D"));
    const input = workflow([
      { id: "start", type: "noop", config: {} },
      { id: "wait_3_days", type: "noop", config: {} },
      { id: "finish", type: "noop", config: {} },
    ]);

    const result = await promoteNoopPlaceholders({
      llm,
      workflow: input,
      originalPrompt: "wait 3 days then notify the team",
      context: baseContext,
    });

    expect(result.promotionAttempts).toBe(1);
    expect(result.promotionsSucceeded).toBe(1);

    const promoted = result.workflow.nodes.find((n) => n.id === "wait_3_days");
    expect(promoted?.type).toBe("wait_until");
    expect((promoted?.config as { duration: string }).duration).toBe("P3D");

    // Sibling nodes untouched.
    expect(result.workflow.nodes.find((n) => n.id === "start")?.type).toBe("noop");
    expect(result.workflow.nodes.find((n) => n.id === "finish")?.type).toBe("noop");
  });

  it("recognises every documented wait-intent id prefix (case-insensitive)", async () => {
    const llm = makeLlm(
      durationResult("P3D"),
      durationResult("PT12H"),
      durationResult("PT30M"),
      durationResult("PT15S"),
    );
    const input = workflow([
      { id: "Wait_three_days", type: "noop", config: {} },
      { id: "sleep_12h", type: "noop", config: {} },
      { id: "pause-30-min", type: "noop", config: {} },
      { id: "delay_15s", type: "noop", config: {} },
    ]);

    const result = await promoteNoopPlaceholders({
      llm,
      workflow: input,
      originalPrompt: "wait 3 days, sleep 12 hours, pause 30 minutes, delay 15 seconds",
      context: baseContext,
    });

    expect(result.promotionAttempts).toBe(4);
    expect(result.promotionsSucceeded).toBe(4);
    expect(result.workflow.nodes.every((n) => n.type === "wait_until")).toBe(true);
  });

  it("preserves edges and workflow-level fields verbatim", async () => {
    const llm = makeLlm(durationResult("PT12H"));
    const input = workflow(
      [
        { id: "wait_12h", type: "noop", config: {} },
        { id: "after", type: "noop", config: {} },
      ],
      [{ from: "wait_12h", to: "after" }],
    );
    (input as unknown as { name: string }).name = "Original name";

    const result = await promoteNoopPlaceholders({
      llm,
      workflow: input,
      originalPrompt: "wait 12 hours",
      context: baseContext,
    });

    expect(result.workflow.edges).toEqual([{ from: "wait_12h", to: "after" }]);
    expect((result.workflow as unknown as { name: string }).name).toBe("Original name");
  });
});

describe("promoteNoopPlaceholders — non-wait passthrough", () => {
  it("no-ops when no node has a wait-prefixed id", async () => {
    const llm = makeLlm(); // Empty queue — any LLM call would throw a no-result error.
    const input = workflow([
      { id: "start", type: "noop", config: {} },
      { id: "fetch", type: "http", config: { url: "https://example.com" } },
      { id: "finalize", type: "noop", config: {} },
    ]);

    const result = await promoteNoopPlaceholders({
      llm,
      workflow: input,
      originalPrompt: "fetch the API",
      context: baseContext,
    });

    expect(result.promotionAttempts).toBe(0);
    expect(result.promotionsSucceeded).toBe(0);
    expect(result.workflow.nodes).toEqual(input.nodes);
    expect(vi.mocked(llm.generateObject)).not.toHaveBeenCalled();
  });

  it("ignores non-noop nodes even when their id starts with a wait prefix", async () => {
    const llm = makeLlm();
    const input = workflow([
      { id: "wait_for_callback", type: "http", config: { url: "https://example.com/webhook" } },
    ]);

    const result = await promoteNoopPlaceholders({
      llm,
      workflow: input,
      originalPrompt: "call a webhook that waits for callback",
      context: baseContext,
    });

    expect(result.promotionAttempts).toBe(0);
    expect(vi.mocked(llm.generateObject)).not.toHaveBeenCalled();
  });

  it("does NOT match noop ids that merely contain `wait` mid-id (e.g. `analyze_wait_time`)", async () => {
    const llm = makeLlm();
    const input = workflow([
      { id: "analyze_wait_time", type: "noop", config: {} },
    ]);

    const result = await promoteNoopPlaceholders({
      llm,
      workflow: input,
      originalPrompt: "analyze the average wait time at the checkout",
      context: baseContext,
    });

    expect(result.promotionAttempts).toBe(0);
    expect(vi.mocked(llm.generateObject)).not.toHaveBeenCalled();
  });

  it("does NOT match longer words that only start with a wait prefix", async () => {
    const llm = makeLlm();
    const input = workflow([
      { id: "waiting_room_review", type: "noop", config: {} },
      { id: "sleepy_customer_followup", type: "noop", config: {} },
    ]);

    const result = await promoteNoopPlaceholders({
      llm,
      workflow: input,
      originalPrompt: "review waiting room sentiment and sleepy customer followups",
      context: baseContext,
    });

    expect(result.promotionAttempts).toBe(0);
    expect(result.promotionsSucceeded).toBe(0);
    expect(vi.mocked(llm.generateObject)).not.toHaveBeenCalled();
  });
});

describe("promoteNoopPlaceholders — per-noop failure isolation", () => {
  it("keeps one noop unpromoted when its Pass-2 LLM call throws, promotes others", async () => {
    const llm = makeLlm(
      new Error("upstream timeout"),
      durationResult("PT30M"),
    );
    const input = workflow([
      { id: "wait_unknown", type: "noop", config: {} },
      { id: "wait_30m", type: "noop", config: {} },
    ]);

    const result = await promoteNoopPlaceholders({
      llm,
      workflow: input,
      originalPrompt: "wait a while, then after 30 minutes proceed",
      context: baseContext,
    });

    expect(result.promotionAttempts).toBe(2);
    expect(result.promotionsSucceeded).toBe(1);

    const a = result.workflow.nodes.find((n) => n.id === "wait_unknown")!;
    const b = result.workflow.nodes.find((n) => n.id === "wait_30m")!;
    expect(a.type).toBe("noop"); // Unpromoted; original config preserved.
    expect(a.config).toEqual({});
    expect(b.type).toBe("wait_until");
    expect((b.config as { duration: string }).duration).toBe("PT30M");
  });

  it("treats an empty operator prompt as a non-attempt — no LLM call, noop stays unchanged", async () => {
    const llm = makeLlm();
    const input = workflow([
      { id: "wait_empty", type: "noop", config: {} },
    ]);

    const result = await promoteNoopPlaceholders({
      llm,
      workflow: input,
      originalPrompt: "",
      context: baseContext,
    });

    expect(result.promotionAttempts).toBe(1);
    expect(result.promotionsSucceeded).toBe(0);
    expect(result.workflow.nodes[0]!.type).toBe("noop");
    expect(vi.mocked(llm.generateObject)).not.toHaveBeenCalled();
  });

  it("rejects a whitespace-only duration from the model and keeps the noop unpromoted", async () => {
    const llm = makeLlm(durationResult("   "));
    const input = workflow([
      { id: "wait_x", type: "noop", config: {} },
    ]);

    const result = await promoteNoopPlaceholders({
      llm,
      workflow: input,
      originalPrompt: "wait 3 days",
      context: baseContext,
    });

    expect(result.promotionAttempts).toBe(1);
    expect(result.promotionsSucceeded).toBe(0);
    expect(result.workflow.nodes[0]!.type).toBe("noop");
  });

  it("rejects malformed or non-positive durations from the model and keeps noops unpromoted", async () => {
    const llm = makeLlm(durationResult("3 days"), durationResult("PT0S"));
    const input = workflow([
      { id: "wait_words", type: "noop", config: {} },
      { id: "wait_zero", type: "noop", config: {} },
    ]);

    const result = await promoteNoopPlaceholders({
      llm,
      workflow: input,
      originalPrompt: "wait 3 days and skip zero waits",
      context: baseContext,
    });

    expect(result.promotionAttempts).toBe(2);
    expect(result.promotionsSucceeded).toBe(0);
    expect(result.workflow.nodes.every((n) => n.type === "noop")).toBe(true);
  });
});

describe("promoteNoopPlaceholders — context + Pass-2 prompt plumbing", () => {
  it("forwards context fields to llm.generateObject for telemetry attribution", async () => {
    const llm = makeLlm(durationResult("P1D"));
    const input = workflow([
      { id: "wait_1d", type: "noop", config: {} },
    ]);

    await promoteNoopPlaceholders({
      llm,
      workflow: input,
      originalPrompt: "wait one day before notifying",
      context: { orgId: "org-77", userId: "user-12", workflowId: "wf-x" },
      modelHint: "anthropic/claude-haiku-4-5-20251001",
    });

    const call = vi.mocked(llm.generateObject).mock.calls[0]![0];
    expect(call.context).toEqual({ orgId: "org-77", userId: "user-12", workflowId: "wf-x" });
    expect(call.modelHint).toBe("anthropic/claude-haiku-4-5-20251001");
    // The Pass-2 user prompt threads both the operator's full prompt
    // AND the placeholder id so the LLM can scope its extraction.
    expect(call.prompt).toContain("wait one day before notifying");
    expect(call.prompt).toContain("wait_1d");
  });
});
