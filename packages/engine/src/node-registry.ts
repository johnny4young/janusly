import { evaluateExpression } from "./expression";
import { executeTool } from "./tool-registry";
import { planAgentTool, planAgentToolWithLLM } from "./agent-planner";
import { appendEvent } from "./persistence";
import { getRunMemory, summarizeMemory } from "./memory";

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
    const { url, method } = ctx.config;
    const res = await fetch(url, { method: method ?? "GET" });

    if (!res.ok) {
      throw new Error(`HTTP failed: ${res.status}`);
    }

    return { status: "completed", output: { statusCode: res.status } };
  },

  condition: async (ctx) => {
    const { expression } = ctx.config;

    const result = evaluateExpression(expression, {
      context: ctx.context,
      inputs: ctx.config
    });

    if (!result) {
      throw new Error("Condition evaluated to false");
    }

    return { status: "completed", output: { result } };
  },

  tool: async (ctx) => {
    const { tool, input } = ctx.config;

    await appendEvent(ctx.runId, ctx.nodeId, "tool.started", { tool, input });
    const result = await executeTool(tool, input, ctx.context);
    await appendEvent(ctx.runId, ctx.nodeId, "tool.completed", { tool, result });

    return {
      status: "completed",
      output: { tool, result }
    };
  },

  agent: async (ctx) => {
    const planner = ctx.config.planner ?? "rules";
    const maxSteps = ctx.config.maxSteps ?? 3;

    const memory = await getRunMemory(ctx.runId);
    const summarizedMemory = summarizeMemory(memory);

    await appendEvent(ctx.runId, ctx.nodeId, "agent.started", {
      planner,
      maxSteps,
      goal: ctx.config.goal,
      memory: summarizedMemory
    });

    const steps = [];
    let lastResult: any = null;

    for (let i = 0; i < maxSteps; i++) {
      await appendEvent(ctx.runId, ctx.nodeId, "agent.step.started", { iteration: i });

      const planningContext = {
        context: ctx.context,
        memory: summarizedMemory,
        steps
      };

      const plan = planner === "openai"
        ? await planAgentToolWithLLM(ctx.config, planningContext, steps)
        : planAgentTool(ctx.config, planningContext);

      await appendEvent(ctx.runId, ctx.nodeId, "agent.step.planned", {
        iteration: i,
        plan
      });

      if ((plan as any).done) {
        await appendEvent(ctx.runId, ctx.nodeId, "agent.completed", {
          iteration: i,
          finalAnswer: (plan as any).finalAnswer,
          steps
        });

        return {
          status: "completed",
          output: {
            memory: summarizedMemory,
            steps,
            finalAnswer: (plan as any).finalAnswer
          }
        };
      }

      await appendEvent(ctx.runId, ctx.nodeId, "agent.tool.started", {
        iteration: i,
        tool: plan.tool,
        input: plan.input
      });

      const result = await executeTool(plan.tool, plan.input, ctx.context);

      await appendEvent(ctx.runId, ctx.nodeId, "agent.tool.completed", {
        iteration: i,
        tool: plan.tool,
        result
      });

      steps.push({ iteration: i, plan, result });
      lastResult = result;
    }

    await appendEvent(ctx.runId, ctx.nodeId, "agent.completed", {
      reason: "maxSteps reached",
      steps,
      finalResult: lastResult
    });

    return {
      status: "completed",
      output: {
        memory: summarizedMemory,
        steps,
        finalResult: lastResult
      }
    };
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
      }
    };
  },

  webhook: async (ctx) => {
    return {
      status: "waiting",
      reason: "Waiting for external webhook resume",
      metadata: {
        resumeToken: `${ctx.runId}:${ctx.nodeId}`,
      },
    };
  },

  approval: async (ctx) => {
    return {
      status: "waiting",
      reason: "Waiting for human approval",
      metadata: {
        resumeToken: `${ctx.runId}:${ctx.nodeId}`,
      },
    };
  },

  noop: async () => {
    return { status: "completed" };
  },
};
