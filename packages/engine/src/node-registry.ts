import { evaluateExpression } from "./expression";
import { executeTool } from "./tool-registry";

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

    const result = await executeTool(tool, input, ctx.context);

    return {
      status: "completed",
      output: {
        tool,
        result
      }
    };
  },

  ai: async (ctx) => {
    const prompt = ctx.config.prompt ?? "Summarize workflow";

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
