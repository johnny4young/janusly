/** Agent-loop, multi-agent, and deterministic reflection executors. */

import { getOrgConfigSnapshot } from "@janusly/data";
import {
  AGENT_REASONING_AGENT_MAX_CHARS,
  AGENT_REASONING_REASON_MAX_CHARS,
  AGENT_REASONING_SCOPE_MAX_CHARS,
  AGENT_REASONING_TOOL_MAX_CHARS,
  scrubOperatorGuidanceSecrets,
  type AgentReasoningEventPayload,
} from "@janusly/shared";

import {
  planAgentTool,
  planAgentToolWithLLM,
  type AgentPlanResult,
} from "../agent-planner";
import { recallAgentEpisodes, recordAgentEpisode } from "../agent-memory";
import { hasFailureSignal } from "../failure-signal";
import {
  enforceLateBoundTemplatePolicy,
  mergeLateBoundRedactions,
} from "../late-bound-template";
import { getRunMemory, summarizeMemory } from "../memory";
import type { AgentNodeConfig } from "../node-configs";
import { appendEvent } from "../persistence";
import { renderTemplateWithRedactions, mapInput } from "../template";
import {
  dryRunToolSkipPayload,
  executeToolForRun,
  withHttpToolDefaults,
} from "../tool-execution";
import { withTimeout } from "../core/timeout";
import { recordValidationWriteSkip } from "../validation-evidence";
import { createTenantLlmClient } from "./ai-shared";
import type { NodeContext, NodeExecutorMap } from "./types";

/** One recorded agent-loop step: the plan, the tool result, and the reflection (when enabled). */
type AgentLoopStepRecord = {
  iteration: number;
  plan: AgentPlanResult;
  result: unknown;
  reflection: AgentReflection | null;
};

/** Reflection verdict emitted after a tool call when `config.reflection` is on. */
type AgentReflection = {
  agent: string | undefined;
  iteration: number;
  decision: "retry" | "accept";
  reason: string;
};

type ResolvedAgentConfig = AgentNodeConfig & {
  name: string;
  goal: string;
};

/**
 * Produce one bounded field written to `agent.reasoning`.
 * This is an operational summary, never hidden chain-of-thought: inputs,
 * workflow context, recalled episodes, tool output, and provider errors stay
 * out of the event entirely.
 */
function sanitizeAgentReasoningText(value: string, maxChars: number): string {
  return scrubOperatorGuidanceSecrets(value)
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

async function runAgentLoop(
  ctx: NodeContext<"agent" | "multi_agent">,
  agentConfig: AgentNodeConfig,
  eventPrefix = "agent",
) {
  const planner = agentConfig.planner ?? "rules";
  const maxSteps = agentConfig.maxSteps ?? 3;
  const reflectionEnabled = Boolean(agentConfig.reflection);
  const orgConfig = await getOrgConfigSnapshot(ctx.orgId);
  const llm = planner === "openai" ? createTenantLlmClient(orgConfig) : undefined;

  const memory = await getRunMemory(ctx.runId);
  const summarizedMemory = summarizeMemory(memory);

  // Cross-run episodic recall feeds the LLM planner only (the deterministic
  // rules planner ignores memory) — skip the embedding call otherwise. Empty
  // when memory is off / the episodic kind is disallowed, so the prompt is then
  // byte-for-byte today's.
  const episodicRecall = planner === "openai" && llm
    ? await recallAgentEpisodes({
        orgId: ctx.orgId,
        workflowId: ctx.workflowId ?? undefined,
        runId: ctx.runId,
        goal: agentConfig.goal ?? "",
      })
    : { block: "", count: 0, fingerprints: [] };

  await appendEvent(ctx.runId, ctx.nodeId, `${eventPrefix}.started`, {
    name: agentConfig.name,
    role: agentConfig.role,
    persona: agentConfig.persona,
    planner,
    maxSteps,
    reflection: reflectionEnabled,
    goal: agentConfig.goal,
    memory: summarizedMemory,
  });

  const steps: AgentLoopStepRecord[] = [];
  let lastResult: unknown = null;
  let lastReflection: AgentReflection | null = null;
  let memoryInfluenceEmitted = false;

  for (let i = 0; i < maxSteps; i++) {
    await appendEvent(ctx.runId, ctx.nodeId, `${eventPrefix}.step.started`, { agent: agentConfig.name, iteration: i });

    const planningContext = { context: ctx.context, memory: summarizedMemory, steps, lastReflection };
    const plan: AgentPlanResult = planner === "openai"
      ? await planAgentToolWithLLM(agentConfig, planningContext, steps, llm, {
          orgId: ctx.orgId,
          runId: ctx.runId,
          nodeId: ctx.nodeId,
          workflowId: ctx.workflowId ?? undefined,
        }, episodicRecall.block, { dryRun: ctx.dryRun })
      : planAgentTool(agentConfig, planningContext);

    if (!memoryInfluenceEmitted && episodicRecall.count > 0 && plan.mode === "ai") {
      await appendEvent(ctx.runId, ctx.nodeId, "agent.memory.recalled", {
        count: episodicRecall.count,
        fingerprints: episodicRecall.fingerprints,
      });
      memoryInfluenceEmitted = true;
    }

    const plannedEventId = await appendEvent(ctx.runId, ctx.nodeId, `${eventPrefix}.step.planned`, { agent: agentConfig.name, iteration: i, plan });
    const reasoningEvent: AgentReasoningEventPayload = {
      agent: sanitizeAgentReasoningText(
        agentConfig.name ?? "agent",
        AGENT_REASONING_AGENT_MAX_CHARS,
      ) || "agent",
      iteration: i,
      planner,
      mode: planner === "rules" ? "rules" : (plan.mode ?? "fallback"),
      scope: sanitizeAgentReasoningText(eventPrefix, AGENT_REASONING_SCOPE_MAX_CHARS) || "agent",
      replacesEventId: plannedEventId,
      decision: plan.done ? "finish" : "use_tool",
      tool: plan.done
        ? null
        : sanitizeAgentReasoningText(plan.tool, AGENT_REASONING_TOOL_MAX_CHARS) || "unknown",
      reason: sanitizeAgentReasoningText(plan.reason, AGENT_REASONING_REASON_MAX_CHARS)
        || "Planner did not provide an operational rationale.",
    };
    await appendEvent(ctx.runId, ctx.nodeId, "agent.reasoning", reasoningEvent);

    if (plan.done) {
      await appendEvent(ctx.runId, ctx.nodeId, `${eventPrefix}.completed`, {
        agent: agentConfig.name,
        iteration: i,
        finalAnswer: plan.finalAnswer,
        steps,
        reflection: lastReflection,
      });

      // Record the episode for cross-run recall. Skipped in dry-run/validation
      // so sandbox runs don't pollute durable memory; never throws.
      if (!ctx.dryRun) {
        await recordAgentEpisode({
          orgId: ctx.orgId,
          workflowId: ctx.workflowId ?? undefined,
          runId: ctx.runId,
          goal: agentConfig.goal ?? "",
          outcome: String(plan.finalAnswer ?? "Done"),
          success: true,
          stepCount: steps.length,
        });
      }

      return { memory: summarizedMemory, steps, finalAnswer: plan.finalAnswer, reflection: lastReflection };
    }

    const toolInput = withHttpToolDefaults(plan.tool, plan.input, orgConfig);
    const dryRunSkip = ctx.dryRun ? dryRunToolSkipPayload(plan.tool, toolInput) : null;
    if (dryRunSkip) {
      const result = { tool: plan.tool, dryRun: true, skipped: true };
      await recordValidationWriteSkip(ctx.runId, ctx.nodeId, "tool.dry_run.skipped", {
        ...dryRunSkip,
        agent: agentConfig.name,
        iteration: i,
      });
      await appendEvent(ctx.runId, ctx.nodeId, `${eventPrefix}.tool.completed`, {
        agent: agentConfig.name,
        iteration: i,
        tool: plan.tool,
        result,
      });
      steps.push({ iteration: i, plan, result, reflection: lastReflection });
      lastResult = result;
      continue;
    }

    await appendEvent(ctx.runId, ctx.nodeId, `${eventPrefix}.tool.started`, {
      agent: agentConfig.name,
      iteration: i,
      tool: plan.tool,
      input: plan.input,
    });

    const result = await withTimeout(
      executeToolForRun({
        tool: plan.tool,
        toolInput,
        context: ctx.context,
        orgConfig,
        orgId: ctx.orgId,
        runId: ctx.runId,
        nodeId: ctx.nodeId,
        workflowId: ctx.workflowId ?? undefined,
      }),
      agentConfig.timeoutMs,
      { label: `${agentConfig.name ?? "agent"}.${plan.tool}` }
    );

    await appendEvent(ctx.runId, ctx.nodeId, `${eventPrefix}.tool.completed`, {
      agent: agentConfig.name,
      iteration: i,
      tool: plan.tool,
      result,
    });

    if (reflectionEnabled) {
      const decision = hasFailureSignal(result) ? "retry" : "accept";
      lastReflection = {
        agent: agentConfig.name,
        iteration: i,
        decision,
        reason: decision === "retry" ? "The result contains an error-like signal." : "The result looks acceptable.",
      };
      await appendEvent(ctx.runId, ctx.nodeId, `${eventPrefix}.reflection`, lastReflection);
    }

    steps.push({ iteration: i, plan, result, reflection: lastReflection });
    lastResult = result;
  }

  await appendEvent(ctx.runId, ctx.nodeId, `${eventPrefix}.completed`, {
    agent: agentConfig.name,
    reason: "maxSteps reached",
    steps,
    finalResult: lastResult,
    reflection: lastReflection,
  });

  // Record the episode (step budget exhausted without an explicit `done`).
  // Skipped in dry-run/validation; never throws.
  if (!ctx.dryRun) {
    await recordAgentEpisode({
      orgId: ctx.orgId,
      workflowId: ctx.workflowId ?? undefined,
      runId: ctx.runId,
      goal: agentConfig.goal ?? "",
      outcome: `Reached step budget (${steps.length}) without completing. Last result: ${safeOutcome(lastResult)}`,
      success: false,
      stepCount: steps.length,
    });
  }

  return { memory: summarizedMemory, steps, finalResult: lastResult, reflection: lastReflection };
}

/** Compact, JSON-safe one-line projection of an agent's last tool result for an
 *  episode summary (bounded; the substrate scrubs + caps the final content). */
function safeOutcome(value: unknown): string {
  if (value == null) return "none";
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return String(value).slice(0, 500);
  }
}

async function buildAgentConfig(
  ctx: NodeContext<"multi_agent">,
  agent: AgentNodeConfig,
  index: number,
  sharedContext: any,
  results: any[],
): Promise<ResolvedAgentConfig> {
  const goal = renderTemplateWithRedactions(
    agent.goal ?? ctx.config.goal ?? "Complete the task",
    {
      context: sharedContext,
      previousAgents: results,
    },
  );

  mergeLateBoundRedactions(ctx, goal.redactedValues);
  await enforceLateBoundTemplatePolicy(ctx, goal.unresolvedPaths);
  const resolvedGoal = typeof goal.rendered === "string"
    ? goal.rendered
    : String(goal.rendered ?? "");

  return {
    ...agent,
    name: agent.name ?? `agent_${index + 1}`,
    planner: agent.planner ?? ctx.config.planner ?? "rules",
    maxSteps: agent.maxSteps ?? ctx.config.maxSteps ?? 2,
    timeoutMs: agent.timeoutMs ?? ctx.config.timeoutMs,
    reflection: agent.reflection ?? ctx.config.reflection ?? true,
    goal: resolvedGoal,
  };
}

function aggregateCrewResults(results: any[], strategy = "last") {
  if (strategy === "all") return results;
  if (strategy === "first") return results[0]?.result?.finalAnswer ?? results[0]?.result?.finalResult ?? results[0] ?? null;
  if (strategy === "best-effort") {
    return results.find(item => item.status !== "failed")?.result?.finalAnswer
      ?? results.find(item => item.status !== "failed")?.result?.finalResult
      ?? results.at(-1)?.result
      ?? null;
  }
  return results.at(-1)?.result?.finalAnswer ?? results.at(-1)?.result?.finalResult ?? null;
}


export const agentNodeExecutors = {
  agent: async (ctx) => {
    const output = await runAgentLoop(ctx, ctx.config, "agent");
    return { status: "completed", output };
  },

  multi_agent: async (ctx) => {
    const agents = Array.isArray(ctx.config.agents) ? ctx.config.agents : [];
    const mode = ctx.config.mode ?? "sequential";
    const aggregation = ctx.config.aggregation ?? "last";
    const continueOnError = Boolean(ctx.config.continueOnError);
    const sharedContext: Record<string, any> = { ...ctx.context };
    const results: any[] = [];

    await appendEvent(ctx.runId, ctx.nodeId, "multi_agent.started", { mode, aggregation, count: agents.length, goal: ctx.config.goal });

    if (mode === "parallel") {
      const parallelResults = await Promise.allSettled(
        agents.map(async (agent, index) => {
          const agentConfig = await buildAgentConfig(ctx, agent, index, sharedContext, results);

          await appendEvent(ctx.runId, ctx.nodeId, "multi_agent.agent.started", {
            index,
            name: agentConfig.name,
            role: agentConfig.role,
            persona: agentConfig.persona,
            goal: agentConfig.goal,
            mode: "parallel",
          });

          const result = await runAgentLoop({ ...ctx, context: sharedContext }, agentConfig, `multi_agent.agent.${index}`);
          return { index, name: agentConfig.name, role: agentConfig.role, status: "completed", result };
        })
      );

      for (const [index, settled] of parallelResults.entries()) {
        const agent = agents[index] ?? {};
        const name = agent.name ?? `agent_${index + 1}`;

        if (settled.status === "fulfilled") {
          results.push(settled.value);
          sharedContext[`agent_${index + 1}`] = { output: settled.value.result };
          sharedContext[settled.value.name] = { output: settled.value.result };
          await appendEvent(ctx.runId, ctx.nodeId, "multi_agent.agent.completed", settled.value);
        } else {
          const failed = { index, name, role: agent.role, status: "failed", error: { message: settled.reason?.message ?? String(settled.reason) } };
          results.push(failed);
          await appendEvent(ctx.runId, ctx.nodeId, "multi_agent.agent.failed", failed);
          if (!continueOnError) throw new Error(`Multi-agent ${name} failed: ${failed.error.message}`);
        }
      }
    } else {
      for (const [index, agent] of agents.entries()) {
        const agentConfig = await buildAgentConfig(ctx, agent, index, sharedContext, results);

        await appendEvent(ctx.runId, ctx.nodeId, "multi_agent.agent.started", {
          index,
          name: agentConfig.name,
          role: agentConfig.role,
          persona: agentConfig.persona,
          goal: agentConfig.goal,
          mode: "sequential",
        });

        try {
          const result = await runAgentLoop({ ...ctx, context: sharedContext }, agentConfig, `multi_agent.agent.${index}`);
          const agentResult = { index, name: agentConfig.name, role: agentConfig.role, status: "completed", result };
          results.push(agentResult);
          sharedContext[`agent_${index + 1}`] = { output: result };
          sharedContext[agentConfig.name] = { output: result };
          await appendEvent(ctx.runId, ctx.nodeId, "multi_agent.agent.completed", agentResult);
        } catch (err: any) {
          const failed = { index, name: agentConfig.name, role: agentConfig.role, status: "failed", error: { message: err.message } };
          results.push(failed);
          await appendEvent(ctx.runId, ctx.nodeId, "multi_agent.agent.failed", failed);
          if (!continueOnError) throw err;
        }
      }
    }

    const finalAnswer = aggregateCrewResults(results, aggregation);
    await appendEvent(ctx.runId, ctx.nodeId, "multi_agent.completed", { mode, aggregation, count: results.length, finalAnswer, agents: results });
    return { status: "completed", output: { mode, aggregation, count: results.length, finalAnswer, agents: results } };
  },

  agent_reflection: async (ctx) => {
    const input = mapInput(ctx.config.input ?? "", { context: ctx.context, inputs: ctx.config });
    const decision = hasFailureSignal(input) ? "retry" : "accept";
    const reason = decision === "retry" ? "The inspected input contains failure signals." : "The inspected input looks valid.";
    await appendEvent(ctx.runId, ctx.nodeId, "agent.reflection", { decision, reason, input });
    return { status: "completed", output: { decision, reason, input } };
  },
} satisfies Pick<NodeExecutorMap, "agent" | "multi_agent" | "agent_reflection">;
