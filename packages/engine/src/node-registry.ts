import OpenAI from "openai";
import { loadRootEnv } from "@janusly/db";
import { evaluateExpression } from "./expression";
import { executeTool } from "./tool-registry";
import { planAgentTool, planAgentToolWithLLM } from "./agent-planner";
import { appendEvent } from "./persistence";
import { getRunMemory, summarizeMemory } from "./memory";
import { mapInput } from "./template";
import { fetchHttpTarget } from "./http-policy";
import { hasFailureSignal } from "./failure-signal";

loadRootEnv();

export type NodeContext = {
  runId: string;
  nodeId: string;
  config: any;
  context: Record<string, any>;
};

export type NodeExecutionResult =
  | { status: "completed"; output?: Record<string, unknown> }
  | { status: "waiting"; reason?: string; metadata?: Record<string, unknown> };

export type NodeExecutor = (ctx: NodeContext) => Promise<NodeExecutionResult>;

const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 30_000);
const OPENAI_MAX_RETRIES = Number(process.env.OPENAI_MAX_RETRIES || 2);
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
let aiNodeOpenAI: OpenAI | null = null;

function getAiNodeOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  aiNodeOpenAI ??= new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: OPENAI_TIMEOUT_MS,
    maxRetries: OPENAI_MAX_RETRIES,
  });
  return aiNodeOpenAI;
}

function fallbackAiResponse(prompt: string, context: Record<string, any>) {
  const contextKeys = Object.keys(context).filter(key => !["orgId", "userId", "createdBy"].includes(key));
  return [
    "AI fallback response.",
    `Prompt: ${previewText(prompt)}`,
    contextKeys.length ? `Available context: ${contextKeys.join(", ")}.` : "No prior node context was available.",
    "Configure OPENAI_API_KEY to generate a model-written answer.",
  ].join("\n");
}

function previewText(value: string, maxLength = 700) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs?: number, label = "operation") {
  if (!timeoutMs) return promise;

  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

async function runAgentLoop(ctx: NodeContext, agentConfig: any, eventPrefix = "agent") {
  const planner = agentConfig.planner ?? "rules";
  const maxSteps = agentConfig.maxSteps ?? 3;
  const reflectionEnabled = Boolean(agentConfig.reflection);

  const memory = await getRunMemory(ctx.runId);
  const summarizedMemory = summarizeMemory(memory);

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

  const steps: any[] = [];
  let lastResult: any = null;
  let lastReflection: any = null;

  for (let i = 0; i < maxSteps; i++) {
    await appendEvent(ctx.runId, ctx.nodeId, `${eventPrefix}.step.started`, { agent: agentConfig.name, iteration: i });

    const planningContext = { context: ctx.context, memory: summarizedMemory, steps, lastReflection };
    const plan = planner === "openai"
      ? await planAgentToolWithLLM(agentConfig, planningContext, steps)
      : planAgentTool(agentConfig, planningContext);

    await appendEvent(ctx.runId, ctx.nodeId, `${eventPrefix}.step.planned`, { agent: agentConfig.name, iteration: i, plan });

    if ((plan as any).done) {
      await appendEvent(ctx.runId, ctx.nodeId, `${eventPrefix}.completed`, {
        agent: agentConfig.name,
        iteration: i,
        finalAnswer: (plan as any).finalAnswer,
        steps,
        reflection: lastReflection,
      });

      return { memory: summarizedMemory, steps, finalAnswer: (plan as any).finalAnswer, reflection: lastReflection };
    }

    await appendEvent(ctx.runId, ctx.nodeId, `${eventPrefix}.tool.started`, {
      agent: agentConfig.name,
      iteration: i,
      tool: plan.tool,
      input: plan.input,
    });

    const result = await withTimeout(
      executeTool(plan.tool, plan.input, ctx.context),
      agentConfig.timeoutMs,
      `${agentConfig.name ?? "agent"}.${plan.tool}`
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

  return { memory: summarizedMemory, steps, finalResult: lastResult, reflection: lastReflection };
}

function buildAgentConfig(ctx: NodeContext, agent: any, index: number, sharedContext: any, results: any[]) {
  return {
    ...agent,
    name: agent.name ?? `agent_${index + 1}`,
    planner: agent.planner ?? ctx.config.planner ?? "rules",
    maxSteps: agent.maxSteps ?? ctx.config.maxSteps ?? 2,
    timeoutMs: agent.timeoutMs ?? ctx.config.timeoutMs,
    reflection: agent.reflection ?? ctx.config.reflection ?? true,
    goal: mapInput(agent.goal ?? ctx.config.goal ?? "Complete the task", {
      context: sharedContext,
      previousAgents: results,
    }),
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

export const nodeRegistry: Record<string, NodeExecutor> = {
  http: async (ctx) => {
    const { url, method, headers, body } = ctx.config;
    const res = await fetchHttpTarget(url, {
      method: method ?? "GET",
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();

    if (!res.ok) throw new Error(`HTTP failed: ${res.status}`);
    return { status: "completed", output: { statusCode: res.status, ok: res.ok, body: text } };
  },

  condition: async (ctx) => {
    const { expression } = ctx.config;
    const result = evaluateExpression(expression, { context: ctx.context, inputs: ctx.config });
    return { status: "completed", output: { result } };
  },

  transform: async (ctx) => {
    const output = mapInput(ctx.config.mapping, { context: ctx.context, inputs: ctx.config });
    return { status: "completed", output };
  },

  loop: async (ctx) => {
    const rawItems = mapInput(ctx.config.items, { context: ctx.context, inputs: ctx.config });
    const items = Array.isArray(rawItems) ? rawItems : typeof rawItems === "string" ? rawItems.split(",").map(item => item.trim()).filter(Boolean) : [];
    const results = items.map((item, index) => mapInput(ctx.config.mapping ?? { item: "{{item}}", index: "{{index}}" }, { context: ctx.context, inputs: ctx.config, item, index }));
    await appendEvent(ctx.runId, ctx.nodeId, "loop.completed", { count: results.length, items: results });
    return { status: "completed", output: { count: results.length, items: results } };
  },

  tool: async (ctx) => {
    const { tool, input } = ctx.config;
    const mappedInput = mapInput(input, { context: ctx.context, inputs: ctx.config });
    await appendEvent(ctx.runId, ctx.nodeId, "tool.started", { tool, input: mappedInput });
    const result = await executeTool(tool, mappedInput, ctx.context);
    await appendEvent(ctx.runId, ctx.nodeId, "tool.completed", { tool, result });
    return { status: "completed", output: { tool, result } };
  },

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
        agents.map(async (agent: any, index: number) => {
          const agentConfig = buildAgentConfig(ctx, agent, index, sharedContext, results);

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
        const agentConfig = buildAgentConfig(ctx, agent, index, sharedContext, results);

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

  ai: async (ctx) => {
    const prompt = String(ctx.config.prompt ?? "Summarize workflow");
    await appendEvent(ctx.runId, ctx.nodeId, "ai.prompt", { prompt: previewText(prompt), contextKeys: Object.keys(ctx.context) });
    const client = getAiNodeOpenAIClient();
    const model = ctx.config.model ?? OPENAI_MODEL;

    if (!client) {
      return {
        status: "completed",
        output: {
          mode: "fallback",
          prompt: previewText(prompt),
          response: fallbackAiResponse(String(prompt), ctx.context),
          contextKeys: Object.keys(ctx.context),
        },
      };
    }

    try {
      const response = await client.responses.create({
        model,
        input: [
          {
            role: "system",
            content: "You are Janusly, an AI operator for business workflows. Answer clearly for an operator, and keep the response concise.",
          },
          {
            role: "user",
            content: JSON.stringify({
              prompt,
              context: ctx.context,
            }),
          },
        ],
      });

      return {
        status: "completed",
        output: {
          mode: "ai",
          model,
          prompt: previewText(prompt),
          response: response.output_text,
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "AI request failed";
      await appendEvent(ctx.runId, ctx.nodeId, "ai.fallback", { error: message, model });
      return {
        status: "completed",
        output: {
          mode: "fallback",
          model,
          prompt: previewText(prompt),
          aiError: message,
          response: fallbackAiResponse(String(prompt), ctx.context),
        },
      };
    }
  },

  webhook: async (ctx) => ({ status: "waiting", reason: "Waiting for external webhook resume", metadata: { resumeToken: `${ctx.runId}:${ctx.nodeId}` } }),
  approval: async (ctx) => ({ status: "waiting", reason: "Waiting for human approval", metadata: { resumeToken: `${ctx.runId}:${ctx.nodeId}` } }),
  noop: async () => ({ status: "completed" }),
};
