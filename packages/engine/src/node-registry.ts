export type NodeContext = {
  runId: string;
  nodeId: string;
  config: any;
};

export type NodeExecutor = (ctx: NodeContext) => Promise<void>;

export const nodeRegistry: Record<string, NodeExecutor> = {
  http: async (ctx) => {
    const { url, method } = ctx.config;
    const res = await fetch(url, { method: method ?? "GET" });

    if (!res.ok) {
      throw new Error(`HTTP failed: ${res.status}`);
    }
  },

  condition: async (ctx) => {
    const { expression } = ctx.config;
    if (expression !== "true") {
      throw new Error("Condition failed");
    }
  },

  noop: async () => {
    return;
  },
};
