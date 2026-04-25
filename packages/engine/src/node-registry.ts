// ...existing imports
import { mapInput } from "./template";

// inside tool node
  tool: async (ctx) => {
    const { tool, input } = ctx.config;

    const mappedInput = mapInput(input, { context: ctx.context });

    await appendEvent(ctx.runId, ctx.nodeId, "tool.started", { tool, input: mappedInput });
    const result = await executeTool(tool, mappedInput, ctx.context);
    await appendEvent(ctx.runId, ctx.nodeId, "tool.completed", { tool, result });

    return {
      status: "completed",
      output: { tool, result }
    };
  },

  transform: async (ctx) => {
    const output = mapInput(ctx.config.mapping, { context: ctx.context });

    return {
      status: "completed",
      output
    };
  },
