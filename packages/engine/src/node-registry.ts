// ...keep existing imports and nodes above

  loop: async (ctx) => {
    const items = mapInput(ctx.config.items, { context: ctx.context }) || [];
    const results: any[] = [];

    for (const item of items) {
      const mapped = mapInput(ctx.config.mapping, { context: ctx.context, item });
      results.push(mapped);
    }

    return {
      status: "completed",
      output: { items: results },
    };
  },

  agent_reflection: async (ctx) => {
    const input = ctx.config.input;
    const decision = typeof input === "string" && input.includes("error") ? "retry" : "accept";

    await appendEvent(ctx.runId, ctx.nodeId, "agent.reflection", { decision, input });

    return {
      status: "completed",
      output: { decision },
    };
  },
