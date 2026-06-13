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

function cronResult(cronExpression: string): LlmGenerateObjectResult<{ cronExpression: string }> {
  return {
    object: { cronExpression },
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    latencyMs: 14,
  };
}

describe("promoteNoopPlaceholders — schedule happy path", () => {
  it("flips a schedule-prefixed noop into a typed schedule node with a 5-field cron", async () => {
    const llm = makeLlm(cronResult("0 9 * * 1-5"));
    const input = workflow([
      { id: "schedule_weekdays_9am", type: "noop", config: {} },
      { id: "fetch", type: "http", config: { url: "https://example.com" } },
    ]);

    const result = await promoteNoopPlaceholders({
      llm,
      workflow: input,
      originalPrompt: "every weekday at 9am, fetch https://example.com/data",
      context: baseContext,
    });

    expect(result.promotionAttempts).toBe(1);
    expect(result.promotionsSucceeded).toBe(1);
    expect(result.promotionsByFamily).toEqual({
      wait_until: { attempts: 0, succeeded: 0 },
      schedule: { attempts: 1, succeeded: 1 },
      mcp_tool: { attempts: 0, succeeded: 0 },
    });

    const promoted = result.workflow.nodes.find((n) => n.id === "schedule_weekdays_9am");
    expect(promoted?.type).toBe("schedule");
    expect((promoted?.config as { cronExpression: string }).cronExpression).toBe("0 9 * * 1-5");
  });

  it("recognises every documented schedule-intent prefix (case-insensitive)", async () => {
    const llm = makeLlm(
      cronResult("0 9 * * 1-5"),
      cronResult("0 0 * * *"),
      cronResult("0 9 * * 1"),
      cronResult("*/15 * * * *"),
    );
    const input = workflow([
      { id: "Schedule_weekdays", type: "noop", config: {} },
      { id: "cron_morning", type: "noop", config: {} },
      { id: "every-monday-9am", type: "noop", config: {} },
      { id: "hourly_poll", type: "noop", config: {} },
    ]);

    const result = await promoteNoopPlaceholders({
      llm,
      workflow: input,
      originalPrompt: "weekdays 9am, daily, every monday at 9am, every hour",
      context: baseContext,
    });

    expect(result.promotionAttempts).toBe(4);
    expect(result.promotionsSucceeded).toBe(4);
    expect(result.promotionsByFamily.schedule).toEqual({ attempts: 4, succeeded: 4 });
    expect(result.workflow.nodes.every((n) => n.type === "schedule")).toBe(true);
  });

  it("rejects @daily-style cron aliases because the engine requires five fields", async () => {
    const llm = makeLlm(cronResult("@daily"));
    const input = workflow([
      { id: "daily_digest", type: "noop", config: {} },
    ]);

    const result = await promoteNoopPlaceholders({
      llm,
      workflow: input,
      originalPrompt: "daily digest run",
      context: baseContext,
    });

    expect(result.promotionAttempts).toBe(1);
    expect(result.promotionsSucceeded).toBe(0);
    expect(result.workflow.nodes[0]!.type).toBe("noop");
    expect(result.promotionsByFamily.schedule).toEqual({ attempts: 1, succeeded: 0 });
  });
});

describe("promoteNoopPlaceholders — schedule rejection paths", () => {
  it("keeps the noop unpromoted when the LLM emits a non-cron string (regex rejects)", async () => {
    // The LLM ignored the system prompt's reject-with-invalid guidance
    // and emitted natural language. The route-side regex pre-filter
    // catches this before downstream code sees a malformed cron.
    const llm = makeLlm(cronResult("monday morning"));
    const input = workflow([
      { id: "schedule_review", type: "noop", config: {} },
    ]);

    const result = await promoteNoopPlaceholders({
      llm,
      workflow: input,
      originalPrompt: "operator wants to schedule a review meeting later",
      context: baseContext,
    });

    expect(result.promotionAttempts).toBe(1);
    expect(result.promotionsSucceeded).toBe(0);
    expect(result.workflow.nodes[0]!.type).toBe("noop");
    expect(result.promotionsByFamily.schedule).toEqual({ attempts: 1, succeeded: 0 });
  });

  it("keeps the noop unpromoted when cron fields are outside engine bounds", async () => {
    const llm = makeLlm(cronResult("99 99 * * *"));
    const input = workflow([
      { id: "schedule_bad_bounds", type: "noop", config: {} },
    ]);

    const result = await promoteNoopPlaceholders({
      llm,
      workflow: input,
      originalPrompt: "run this every day",
      context: baseContext,
    });

    expect(result.promotionAttempts).toBe(1);
    expect(result.promotionsSucceeded).toBe(0);
    expect(result.workflow.nodes[0]!.type).toBe("noop");
  });

  it("keeps the noop unpromoted when LLM emits an empty cron string", async () => {
    const llm = makeLlm(cronResult(""));
    const input = workflow([
      { id: "schedule_unclear", type: "noop", config: {} },
    ]);

    const result = await promoteNoopPlaceholders({
      llm,
      workflow: input,
      originalPrompt: "vague schedule",
      context: baseContext,
    });

    expect(result.promotionsSucceeded).toBe(0);
    expect(result.workflow.nodes[0]!.type).toBe("noop");
  });

  it("does NOT match mid-string `schedule` (e.g. `analyze_schedule_data`)", async () => {
    const llm = makeLlm();
    const input = workflow([
      { id: "analyze_schedule_data", type: "noop", config: {} },
    ]);

    const result = await promoteNoopPlaceholders({
      llm,
      workflow: input,
      originalPrompt: "analyze the team's schedule data",
      context: baseContext,
    });

    expect(result.promotionAttempts).toBe(0);
    expect(vi.mocked(llm.generateObject)).not.toHaveBeenCalled();
  });
});

describe("promoteNoopPlaceholders — multi-family co-existence", () => {
  it("promotes one wait + one schedule noop independently and tracks per-family counts", async () => {
    const llm = makeLlm(
      // Order matches node-discovery order in the loop.
      durationResult("P3D"),
      cronResult("0 9 * * 1-5"),
    );
    const input = workflow([
      { id: "wait_3_days", type: "noop", config: {} },
      { id: "schedule_weekdays_9am", type: "noop", config: {} },
    ]);

    const result = await promoteNoopPlaceholders({
      llm,
      workflow: input,
      originalPrompt: "wait 3 days, then every weekday at 9am fetch data",
      context: baseContext,
    });

    expect(result.promotionAttempts).toBe(2);
    expect(result.promotionsSucceeded).toBe(2);
    expect(result.promotionsByFamily).toEqual({
      wait_until: { attempts: 1, succeeded: 1 },
      schedule: { attempts: 1, succeeded: 1 },
      mcp_tool: { attempts: 0, succeeded: 0 },
    });

    const wait = result.workflow.nodes.find((n) => n.id === "wait_3_days");
    const schedule = result.workflow.nodes.find((n) => n.id === "schedule_weekdays_9am");
    expect(wait?.type).toBe("wait_until");
    expect(schedule?.type).toBe("schedule");
  });

  it("isolates per-family failure: one schedule fails, sibling wait still promotes", async () => {
    const llm = makeLlm(
      new Error("provider timeout on the schedule promote"),
      durationResult("PT12H"),
    );
    const input = workflow([
      { id: "schedule_flaky", type: "noop", config: {} },
      { id: "sleep_12h", type: "noop", config: {} },
    ]);

    const result = await promoteNoopPlaceholders({
      llm,
      workflow: input,
      originalPrompt: "schedule something flaky, sleep 12 hours",
      context: baseContext,
    });

    expect(result.promotionAttempts).toBe(2);
    expect(result.promotionsSucceeded).toBe(1);
    expect(result.promotionsByFamily).toEqual({
      wait_until: { attempts: 1, succeeded: 1 },
      schedule: { attempts: 1, succeeded: 0 },
      mcp_tool: { attempts: 0, succeeded: 0 },
    });

    const flakySchedule = result.workflow.nodes.find((n) => n.id === "schedule_flaky");
    const sleep = result.workflow.nodes.find((n) => n.id === "sleep_12h");
    expect(flakySchedule?.type).toBe("noop"); // Unpromoted.
    expect(sleep?.type).toBe("wait_until");
  });

  it("populates promotionsByFamily zeros when no node matches any family", async () => {
    const llm = makeLlm();
    const input = workflow([
      { id: "start", type: "noop", config: {} },
      { id: "fetch", type: "http", config: { url: "https://example.com" } },
    ]);

    const result = await promoteNoopPlaceholders({
      llm,
      workflow: input,
      originalPrompt: "fetch the api",
      context: baseContext,
    });

    expect(result.promotionsByFamily).toEqual({
      wait_until: { attempts: 0, succeeded: 0 },
      schedule: { attempts: 0, succeeded: 0 },
      mcp_tool: { attempts: 0, succeeded: 0 },
    });
  });
});

describe("promoteNoopPlaceholders — mcp_tool (deterministic, no LLM)", () => {
  const exposed = [
    { connectionAlias: "notion", toolName: "pages.update" },
    { connectionAlias: "github", toolName: "issues_create" },
  ];

  it("flips a mcp_<alias>_<tool> noop into a typed mcp_tool node, no LLM call", async () => {
    const llm = makeLlm(); // Empty queue — a stray LLM call would throw a no-result error.
    const input = workflow([
      { id: "mcp_notion_pages_update", type: "noop", config: {} },
      { id: "finish", type: "noop", config: {} },
    ]);

    const result = await promoteNoopPlaceholders({
      llm,
      workflow: input,
      originalPrompt: "update the Notion page when the run finishes",
      context: baseContext,
      availableMcpTools: exposed,
    });

    expect(result.promotionAttempts).toBe(1);
    expect(result.promotionsSucceeded).toBe(1);
    expect(result.promotionsByFamily.mcp_tool).toEqual({ attempts: 1, succeeded: 1 });
    // Deterministic — promotion must never reach the LLM.
    expect(vi.mocked(llm.generateObject)).not.toHaveBeenCalled();

    const promoted = result.workflow.nodes.find((n) => n.id === "mcp_notion_pages_update");
    expect(promoted?.type).toBe("mcp_tool");
    // The dotted descriptor toolName survives verbatim — only the id MATCH
    // is normalized, not the stored config.
    expect(promoted?.config).toEqual({ connectionAlias: "notion", toolName: "pages.update" });
  });

  it("matches an underscore-id descriptor toolName too (github_issues_create)", async () => {
    const llm = makeLlm();
    const input = workflow([
      { id: "mcp_github_issues_create", type: "noop", config: {} },
    ]);

    const result = await promoteNoopPlaceholders({
      llm,
      workflow: input,
      originalPrompt: "open a GitHub issue",
      context: baseContext,
      availableMcpTools: exposed,
    });

    expect(result.promotionsSucceeded).toBe(1);
    const promoted = result.workflow.nodes[0]!;
    expect(promoted.type).toBe("mcp_tool");
    expect(promoted.config).toEqual({ connectionAlias: "github", toolName: "issues_create" });
  });

  it("leaves the noop unpromoted when no exposed tool is supplied (exposeToAi off)", async () => {
    const llm = makeLlm();
    const input = workflow([
      { id: "mcp_notion_pages_update", type: "noop", config: {} },
    ]);

    const result = await promoteNoopPlaceholders({
      llm,
      workflow: input,
      originalPrompt: "update the Notion page",
      context: baseContext,
      // availableMcpTools omitted → defaults to []
    });

    expect(result.promotionAttempts).toBe(1);
    expect(result.promotionsSucceeded).toBe(0);
    expect(result.workflow.nodes[0]!.type).toBe("noop");
    expect(result.workflow.nodes[0]!.config).toEqual({});
  });

  it("leaves the noop unpromoted when the id resolves to no exposed tool", async () => {
    const llm = makeLlm();
    const input = workflow([
      { id: "mcp_slack_post_message", type: "noop", config: {} },
    ]);

    const result = await promoteNoopPlaceholders({
      llm,
      workflow: input,
      originalPrompt: "post to slack",
      context: baseContext,
      availableMcpTools: exposed, // notion + github only — no slack
    });

    expect(result.promotionAttempts).toBe(1);
    expect(result.promotionsSucceeded).toBe(0);
    expect(result.workflow.nodes[0]!.type).toBe("noop");
  });

  it("leaves the noop unpromoted on an ambiguous collision (two tools fold to the same key)", async () => {
    const llm = makeLlm();
    // `(notion, pages.update)` and `(notion_pages, update)` both normalize to
    // `mcp_notion_pages_update` — ambiguous, so neither wins.
    const collidingExposed = [
      { connectionAlias: "notion", toolName: "pages.update" },
      { connectionAlias: "notion_pages", toolName: "update" },
    ];
    const input = workflow([
      { id: "mcp_notion_pages_update", type: "noop", config: {} },
    ]);

    const result = await promoteNoopPlaceholders({
      llm,
      workflow: input,
      originalPrompt: "update a notion page",
      context: baseContext,
      availableMcpTools: collidingExposed,
    });

    expect(result.promotionAttempts).toBe(1);
    expect(result.promotionsSucceeded).toBe(0);
    expect(result.workflow.nodes[0]!.type).toBe("noop");
  });

  it("does NOT promote the prompt-injection escape-hatch mcp_suspicious noop", async () => {
    const llm = makeLlm();
    const input = workflow([
      { id: "mcp_suspicious_pages_update", type: "noop", config: {} },
    ]);

    const result = await promoteNoopPlaceholders({
      llm,
      workflow: input,
      originalPrompt: "update a Notion page",
      context: baseContext,
      // A real `(suspicious, pages.update)` connection would fold to the
      // same key; the escape hatch must still remain manual/noop.
      availableMcpTools: [{ connectionAlias: "suspicious", toolName: "pages.update" }],
    });

    expect(result.promotionAttempts).toBe(1);
    expect(result.promotionsSucceeded).toBe(0);
    expect(result.workflow.nodes[0]!.type).toBe("noop");
  });

  it("does NOT promote the synthetic truncation footer as a real MCP tool", async () => {
    const llm = makeLlm();
    const input = workflow([
      { id: "mcp_truncated_truncated", type: "noop", config: {} },
    ]);

    const result = await promoteNoopPlaceholders({
      llm,
      workflow: input,
      originalPrompt: "use one of the exposed MCP tools",
      context: baseContext,
      availableMcpTools: [{ connectionAlias: "_truncated", toolName: "_truncated" }],
    });

    expect(result.promotionAttempts).toBe(1);
    expect(result.promotionsSucceeded).toBe(0);
    expect(result.workflow.nodes[0]!.type).toBe("noop");
  });

  it("does NOT match a non-noop node whose id starts with mcp_", async () => {
    const llm = makeLlm();
    const input = workflow([
      { id: "mcp_notion_pages_update", type: "http", config: { url: "https://example.com" } },
    ]);

    const result = await promoteNoopPlaceholders({
      llm,
      workflow: input,
      originalPrompt: "call an api",
      context: baseContext,
      availableMcpTools: exposed,
    });

    expect(result.promotionAttempts).toBe(0);
    expect(result.workflow.nodes[0]!.type).toBe("http");
  });

  it("co-exists with wait + schedule families and tracks all three per-family counts", async () => {
    const llm = makeLlm(
      // Discovery order: wait first (LLM), schedule next (LLM); mcp is deterministic.
      durationResult("P3D"),
      cronResult("0 9 * * 1-5"),
    );
    const input = workflow([
      { id: "wait_3_days", type: "noop", config: {} },
      { id: "schedule_weekdays_9am", type: "noop", config: {} },
      { id: "mcp_notion_pages_update", type: "noop", config: {} },
    ]);

    const result = await promoteNoopPlaceholders({
      llm,
      workflow: input,
      originalPrompt: "wait 3 days, then every weekday at 9am update the notion page",
      context: baseContext,
      availableMcpTools: exposed,
    });

    expect(result.promotionAttempts).toBe(3);
    expect(result.promotionsSucceeded).toBe(3);
    expect(result.promotionsByFamily).toEqual({
      wait_until: { attempts: 1, succeeded: 1 },
      schedule: { attempts: 1, succeeded: 1 },
      mcp_tool: { attempts: 1, succeeded: 1 },
    });
    expect(result.workflow.nodes.find((n) => n.id === "mcp_notion_pages_update")?.type).toBe("mcp_tool");
    // The deterministic family added zero extra LLM round-trips.
    expect(vi.mocked(llm.generateObject)).toHaveBeenCalledTimes(2);
  });
});
