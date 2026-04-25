import { evaluateExpression } from "./expression";
import { executeTool } from "./tool-registry";
import { planAgentTool, planAgentToolWithLLM } from "./agent-planner";
import { appendEvent } from "./persistence";
import { getRunMemory, summarizeMemory } from "./memory";
import { mapInput } from "./template";

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

export const nodeRegistry: Record<string, NodeExecutor> = {
  http: async (ctx) => {
    const { url, method, headers, body } = ctx.config;
    const res = await fetch(url, {
      method: method ?? "GET",
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();

    if (!res.ok) {
      throw new Error(`HTTP failed: ${res.status}`);
    }

    return { status: "completed", output: { statusCode: res.status, ok: res.ok, body: text } };
  },

  condition: async (ctx) => {
    const { expression } = ctx.config;
    const result = evaluateExpression(expression, { context: ctx.context, inputs: ctx.config });

    if (!result) {
      throw new Error("Condition evaluated to false");
    }

    return { status: "completed", output: { result } };
  },

  transform: async (ctx) => {
    const output = mapInput(ctx.config.mapping, { context: ctx.context, inputs: ctx.config });
    return { status: "completed", output };
  },

  loop: async (ctx) => {
    const rawItems = mapInput(ctx.config.items, { context: ctx.context, inputs: ctx.config });
    const items = Array.isArray(rawItems)
      ? rawItems
      : typeof rawItems === "string"
        ? rawItems.split(",").map(item => item.trim()).filter(Boolean)
        : [];

    const results = items.map((item, index) => {
      return mapInput(ctx.config.mapping ?? { item: "{{item}}", index: "{{index}}" }, {
        context: ctx.context,
        inputs: ctx.config,
        item,
        index,
      });
    });

    await appendEvent(ctx.runId, ctx.nodeId, "loop.completed", {
      count: results.length,
      items: results,
    });

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
    const planner = ctx.config.planner ?? "rules";
    const maxSteps = ctx.config.maxSteps ?? 3;
    const reflectionEnabled = Boolean(ctx.config.reflection);

    const memory = await getRunMemory(ctx.runId);
    const summarizedMemory = summarizeMemory(memory);

    await appendEvent(ctx.runId, ctx.nodeId, "agent.started", {
      planner,
      maxSteps,
      reflection: reflectionEnabled,
      goal: ctx.config.goal,
      memory: summarizedMemory,
    });

    const steps: any[] = [];
    let lastResult: any = null;
    let lastReflection: any = null;

    for (let i = 0; i < maxSteps; i++) {
      await appendEvent(ctx.runId, ctx.nodeId, "agent.step.started", { iteration: i });

      const planningContext = { context: ctx.context, memory: summarizedMemory, steps, lastReflection };
      const plan = planner === "openai"
        ? await planAgentToolWithLLM(ctx.config, planningContext, steps)
        : planAgentTool(ctx.config, planningContext);

      await appendEvent(ctx.runId, ctx.nodeId, "agent.step.planned", { iteration: i, plan });

      if ((plan as any).done) {
        await appendEvent(ctx.runId, ctx.nodeId, "agent.completed", {
          iteration: i,
          finalAnswer: (plan as any).finalAnswer,
          steps,
          reflection: lastReflection,
        });

        return {
          status: "completed",
          output: { memory: summarizedMemory, steps, finalAnswer: (plan as any).finalAnswer, reflection: lastReflection },
        };
      }

      await appendEvent(ctx.runId, ctx.nodeId, "agent.tool.started", {
        iteration: i,
        tool: plan.tool,
        input: plan.input,
      });

      const result = await executeTool(plan.tool, plan.input, ctx.context);

      await appendEvent(ctx.runId, ctx.nodeId, "agent.tool.completed", {
        iteration: i,
        tool: plan.tool,
        result,
      });

      if (reflectionEnabled) {
        const decision = JSON.stringify(result).toLowerCase().includes("error") ? "retry" : "accept";
        lastReflection = {
          iteration: i,
          decision,
          reason: decision === "retry" ? "The result contains an error-like signal." : "The result looks acceptable.",
        };
        await appendEvent(ctx.runId, ctx.nodeId, "agent.reflection", lastReflection);
      }

      steps.push({ iteration: i, plan, result, reflection: lastReflection });
      lastResult = result;
    }

    await appendEvent(ctx.runId, ctx.nodeId, "agent.completed", {
      reason: "maxSteps reached",
      steps,
      finalResult: lastResult,
      reflection: lastReflection,
    });

    return { status: "completed", output: { memory: summarizedMemory, steps, finalResult: lastResult, reflection: lastReflection } };
  },

  agent_reflection: async (ctx) => {
    const input = mapInput(ctx.config.input ?? "", { context: ctx.context, inputs: ctx.config });
    const text = typeof input === "string" ? input : JSON.stringify(input);
    const decision = text.toLowerCase().includes("error") || text.toLowerCase().includes("failed") ? "retry" : "accept";
    const reason = decision === "retry" ? "The inspected input contains failure signals." : "The inspected input looks valid.";

    await appendEvent(ctx.runId, ctx.nodeId, "agent.reflection", { decision, reason, input });

    return { status: "completed", output: { decision, reason, input } };
  },

  ai: async (ctx) => {
    const prompt = ctx.config.prompt ?? "Summarize workflow";
    await appendEvent(ctx.runId, ctx.nodeId, "ai.prompt", { prompt });

    return {
      status: "completed",
      output: {
        prompt,
        contextUsed: ctx.context,
        response: `AI saw context: ${JSON.stringify(ctx.context)}`,
      },
    };
  },

  webhook: async (ctx) => ({
    status: "waiting",
    reason: "Waiting for external webhook resume",
    metadata: { resumeToken: `${ctx.runId}:${ctx.nodeId}` },
  }),

  approval: async (ctx) => ({
    status: "waiting",
    reason: "Waiting for human approval",
    metadata: { resumeToken: `${ctx.runId}:${ctx.nodeId}` },
  }),

  noop: async () => ({ status: "completed" }),
};
