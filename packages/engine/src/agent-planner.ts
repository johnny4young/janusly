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

import { loadRootEnv } from "@janusly/db";
import { getLlmClient, type LlmClient } from "@janusly/ai";
import { checkBudget } from "./budget";

loadRootEnv();

export type AgentPlan = {
  tool: string;
  input: Record<string, unknown>;
  reason: string;
};

export type AgentLoopStep = {
  iteration: number;
  plan: AgentPlan;
  result: Record<string, unknown>;
};

const availableTools = [
  {
    name: "http.request",
    description: "Make an HTTP request to an external API.",
    inputShape: { url: "string", method: "GET|POST", headers: "object optional", body: "object optional" }
  },
  {
    name: "text.uppercase",
    description: "Convert text to uppercase.",
    inputShape: { value: "string" }
  },
  {
    name: "json.pick",
    description: "Pick a value from workflow context using a dot path.",
    inputShape: { path: "string" }
  }
];

export function planAgentTool(config: any, context: Record<string, any>): AgentPlan {
  if (config.tool) {
    return {
      tool: config.tool,
      input: config.input ?? {},
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
  config: any,
  context: Record<string, any>,
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
): Promise<AgentPlan & { done?: boolean; finalAnswer?: string; aiError?: string }> {
  const llm = llmOverride !== undefined ? llmOverride : getLlmClient();

  if (!llm) {
    return planAgentTool(config, context);
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
        aiError: "budget_exceeded",
      };
    }
  }

  const goal = config.goal ?? "Choose the best tool for this workflow step.";

  try {
    const result = await llm.generateText({
      system:
        "You are a workflow agent planner. Select exactly one tool from availableTools, or return done=true if the goal is complete. Return only valid JSON.",
      prompt: JSON.stringify({
        goal,
        config,
        context,
        history,
        availableTools,
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

    const parsed = JSON.parse(result.text || "{}");

    if (parsed.done) {
      return {
        tool: "done",
        input: {},
        reason: parsed.reason ?? "Goal completed",
        done: true,
        finalAnswer: parsed.finalAnswer ?? "Done",
      };
    }

    if (!parsed.tool || typeof parsed.tool !== "string") {
      const fallback = planAgentTool(config, context);
      return { ...fallback, aiError: "LLM planner did not return a valid tool" };
    }

    return {
      tool: parsed.tool,
      input: parsed.input ?? {},
      reason: parsed.reason ?? "LLM selected tool",
    };
  } catch (error) {
    const fallback = planAgentTool(config, context);
    return { ...fallback, aiError: error instanceof Error ? error.message : String(error) };
  }
}
