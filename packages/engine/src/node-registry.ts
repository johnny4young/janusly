export type NodeContext = {
  runId: string;
  nodeId: string;
  config: any;
};

export type NodeExecutionResult =
  | { status: "completed" }
  | { status: "waiting"; reason?: string; metadata?: Record<string, unknown> };

export type NodeExecutor = (ctx: NodeContext) => Promise<NodeExecutionResult>;

export const nodeRegistry: Record<string, NodeExecutor> = {
  http: async (ctx) => {
    const { url, method } = ctx.config;
    const res = await fetch(url, { method: method ?? "GET" });

    if (!res.ok) {
      throw new Error(`HTTP failed: ${res.status}`);
    }

    return { status: "completed" };
  },

  condition: async (ctx) => {
    const { expression } = ctx.config;
    if (expression !== "true") {
      throw new Error("Condition failed");
    }

    return { status: "completed" };
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
