/**
 * Agent planner — picks the next tool an `agent` node should run.
 *
 * Two planners share one return shape:
 *   - `planAgentTool` (rules) — pure, deterministic, no I/O.
 *   - `planAgentToolWithLLM` ("openai" planner) — routes through the
 *     provider-neutral `getLlmClient()` from `@janusly/ai`. Falls back to
 *     the rules planner on any error and surfaces `aiError` per the
 *     AGENTS.md fallback contract.
 *
 * Used by `packages/engine/src/node-registry.ts` (`agent` and `multi_agent`
 * executors) and indirectly by `apps/api/src/index.ts` when those nodes run
 * inside a workflow.
 *
 * Invariants:
 * - Every LLM call is wrapped in try/catch; failures degrade to the rules
 *   planner with `aiError` set (don't drop the rules fallback).
 * - The function takes an optional `llm` injection so tests can hand in a
 *   mock `LlmClient`. When unset, it resolves the singleton via
 *   `getLlmClient()` so production callers don't have to thread it through.
 */

import { z } from "zod";

import { loadRootEnv } from "@janusly/db";
import { getLlmClient, type LlmClient } from "@janusly/ai";
import { checkBudget } from "./budget";
import type { AgentNodeConfig } from "./node-configs";
import { listPlannerTools } from "./tool-registry";

loadRootEnv();

export type AgentPlan = {
  tool: string;
  input: Record<string, unknown>;
  reason: string;
};

/** What the agent loop actually receives from a planner call: a plan, plus
 *  the LLM planner's optional terminate signal and fallback attribution. */
export type AgentPlanResult = AgentPlan & {
  done?: boolean;
  finalAnswer?: string;
  mode?: "ai" | "fallback";
  aiError?: string;
};

/** One prior step handed back to the planner as history. Only ever
 *  JSON-stringified into the prompt, so `result` stays `unknown` (tool
 *  outputs are arbitrary) and the loop may attach extra fields. */
export type AgentLoopStep = {
  iteration: number;
  plan: AgentPlan;
  result: unknown;
  reflection?: unknown;
};

/**
 * Shape gate for the LLM planner's JSON reply. The planner output flows
 * straight into tool execution, so a malformed shape (tool as an object,
 * input as an array, …) must degrade to the deterministic rules planner —
 * with `aiError` attribution — instead of walking untyped into
 * `executeTool`. Mirrors the house style of validating every LLM output
 * against a Zod schema before it crosses a boundary.
 */
const LlmPlannerReplySchema = z.object({
  done: z.boolean().optional(),
  finalAnswer: z.string().optional(),
  tool: z.string().optional(),
  input: z.record(z.string(), z.unknown()).optional(),
  reason: z.string().optional(),
});

export function planAgentTool(config: AgentNodeConfig, context: Record<string, unknown>): AgentPlan {
  if (config.tool) {
    return {
      tool: config.tool,
      input: (config.input as Record<string, unknown> | undefined) ?? {},
      reason: "Explicit tool selected by node config",
    };
  }

  const goal = String(config.goal ?? "").toLowerCase();

  if (goal.includes("uppercase") || goal.includes("upper case")) {
    return {
      tool: "text.uppercase",
      input: { value: config.value ?? config.text ?? "" },
      reason: "Goal matched text uppercase transformation",
    };
  }

  if (goal.includes("pick") || goal.includes("extract")) {
    return {
      tool: "json.pick",
      input: { path: config.path ?? "" },
      reason: "Goal matched JSON extraction",
    };
  }

  if (goal.includes("http") || goal.includes("request") || goal.includes("call api")) {
    return {
      tool: "http.request",
      input: {
        url: config.url,
        method: config.method ?? "GET",
        body: config.body,
        headers: config.headers,
      },
      reason: "Goal matched HTTP/API request",
    };
  }

  return {
    tool: "text.uppercase",
    input: { value: JSON.stringify({ goal: config.goal, context }) },
    reason: "Fallback planner selected text.uppercase",
  };
}

export async function planAgentToolWithLLM(
  config: AgentNodeConfig,
  context: Record<string, unknown>,
  history: AgentLoopStep[] = [],
  /**
   * Optional LLM injection — mainly for tests. When omitted, the function
   * resolves the singleton via `getLlmClient()` so production callers don't
   * have to thread it.
   */
  llmOverride?: LlmClient | null,
  /**
   * Per-call telemetry context. Forwarded verbatim to the LLM
   * abstraction so the recorder attributes the row to org/run/node.
   * Omitted in unit tests; production calls from `node-registry.ts:runAgentLoop`
   * fill it from the executor `NodeContext`.
   */
  telemetryContext?: { orgId: string; userId?: string; runId?: string; nodeId?: string; workflowId?: string },
  /**
   * Optional DATA-framed block of recalled prior episodes (cross-run memory),
   * rendered by `agent-memory.ts:recallAgentEpisodes`. Surfaced as a distinct
   * `recalledEpisodes` field in the prompt so its data framing stays legible.
   * Empty / omitted when memory is off — the prompt is then byte-for-byte today's.
   */
  recalledEpisodes?: string,
  /**
   * Runtime planning posture. A validation/sandbox run hides every registered
   * write-side tool from the model before it chooses a plan; execution keeps
   * its own skip gate in case an explicit config or fallback still names one.
   */
  options: { dryRun?: boolean } = {},
): Promise<AgentPlanResult> {
  const llm = llmOverride !== undefined ? llmOverride : getLlmClient();

  if (!llm) {
    return { ...planAgentTool(config, context), mode: "fallback", aiError: "llm_not_configured" };
  }

  // Budget chokepoint. On a block the planner returns a terminate decision
  // with the budget reason so the agent loop stops cleanly instead of
  // re-firing the LLM. Mirrors the AI-fallback contract on the engine
  // ai-node — the run keeps moving.
  if (telemetryContext?.orgId) {
    const budget = await checkBudget({
      orgId: telemetryContext.orgId,
      workflowId: telemetryContext.workflowId ?? null,
    });
    if (!budget.allowed) {
      return {
        tool: "done",
        input: {},
        reason: `Budget exceeded — agent terminated (spent $${budget.monthlyUsdSpent.toFixed(2)} of $${(budget.monthlyUsdLimit ?? 0).toFixed(2)}).`,
        done: true,
        finalAnswer: "Agent terminated: AI cost budget exceeded.",
        mode: "fallback",
        aiError: "budget_exceeded",
      };
    }
  }

  const goal = config.goal ?? "Choose the best tool for this workflow step.";

  // PromptOps seam: when `config.systemPromptRef` is set AND we have an
  // orgId, resolve the registry template and override the hardcoded
  // planner system prompt below. The resolver throws on missing prompt /
  // missing variable / recursion; we catch and fall back to the
  // hardcoded prompt so the agent loop continues to make progress.
  const defaultSystemPrompt =
    "You are a workflow agent planner. Select exactly one tool from availableTools, or return done=true if the goal is complete. Return only valid JSON.";
  let systemPrompt = defaultSystemPrompt;
  const systemPromptRefRaw = config?.systemPromptRef;
  if (
    systemPromptRefRaw &&
    typeof systemPromptRefRaw === "object" &&
    typeof (systemPromptRefRaw as { name?: unknown }).name === "string" &&
    telemetryContext?.orgId
  ) {
    const refIn = systemPromptRefRaw as { name: string; version?: number };
    try {
      // Lazy require so the planner doesn't pay the import cost on every
      // call when no opt-in is set — the resolver pulls in the data
      // package which transitively imports the drizzle client.
      const { resolvePromptRef } = await import("./prompt-resolver");
      const resolved = await resolvePromptRef({
        orgId: telemetryContext.orgId,
        ref: { name: refIn.name, version: refIn.version },
        nodeContext: {
          variables:
            config?.variables && typeof config.variables === "object"
              ? (config.variables as Record<string, unknown>)
              : undefined,
        },
      });
      systemPrompt = resolved.resolvedText;
    } catch {
      // Silent fallback to the hardcoded prompt. The agent loop keeps
      // making progress; the operator can verify via the `prompt.*`
      // audit rows whether their promptRef ever resolved successfully.
    }
  }

  try {
    // Catalog projection can fail if a future registered Zod schema cannot be
    // represented as JSON Schema. Keep it inside the same fallback boundary
    // as the provider call so one bad registration never rejects the run.
    const availableTools = listPlannerTools({ dryRun: options.dryRun });
    const availableToolNames = new Set(availableTools.map((tool) => tool.name));
    const result = await llm.generateText({
      system: systemPrompt,
      prompt: JSON.stringify({
        goal,
        config,
        context,
        history,
        availableTools,
        ...(recalledEpisodes ? { recalledEpisodes } : {}),
        requiredJsonShape: {
          done: "boolean optional",
          finalAnswer: "string optional",
          tool: "one available tool name when not done",
          input: "object with tool input when not done",
          reason: "short reason",
        },
      }),
      responseFormat: "json",
      modelHint: typeof config.model === "string" ? config.model : undefined,
      context: telemetryContext,
    });

    const reply = LlmPlannerReplySchema.safeParse(JSON.parse(result.text || "{}"));
    if (!reply.success) {
      const fallback = planAgentTool(config, context);
      return { ...fallback, mode: "fallback", aiError: "LLM planner returned a malformed plan shape" };
    }
    const parsed = reply.data;

    if (parsed.done) {
      return {
        tool: "done",
        input: {},
        reason: parsed.reason ?? "Goal completed",
        done: true,
        finalAnswer: parsed.finalAnswer ?? "Done",
        mode: "ai",
      };
    }

    if (!parsed.tool || !availableToolNames.has(parsed.tool)) {
      const fallback = planAgentTool(config, context);
      return { ...fallback, mode: "fallback", aiError: "LLM planner did not return an available tool" };
    }

    return {
      tool: parsed.tool,
      input: parsed.input ?? {},
      reason: parsed.reason ?? "LLM selected tool",
      mode: "ai",
    };
  } catch (error) {
    const fallback = planAgentTool(config, context);
    return { ...fallback, mode: "fallback", aiError: error instanceof Error ? error.message : String(error) };
  }
}
