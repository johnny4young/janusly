/** MCP tool catalog composition and risk annotations. */

import type { Tool, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { ALWAYS_VISIBLE_TOOLS } from "./visible-tools";
import { WRITE_TOOLS } from "./write-tools";

const TOOL_RESULT_SCHEMA: NonNullable<Tool["outputSchema"]> = {
  type: "object",
  required: ["result"],
  properties: {
    result: {
      description:
        "Normalized Janusly operation data. Stable API transport envelopes are removed before this value is returned.",
    },
  },
  additionalProperties: false,
};

const SIDE_EFFECTING_ALWAYS_VISIBLE_TOOLS = new Set([
  "ai.generate_workflow",
  "ai.patch_workflow",
  "reports.run_explain",
]);
const IDEMPOTENT_WRITE_TOOLS = new Set([
  "runs.redrive",
  "mcp.connections.update",
  "mcp.connections.set_tool",
  "mcp.connections.delete",
]);
const DESTRUCTIVE_TOOLS = new Set([
  "recovery.cases.resolve",
  "runs.cancel",
  "mcp.connections.delete",
]);
const OPEN_WORLD_TOOLS = new Set([
  "ai.generate_workflow",
  "ai.patch_workflow",
  "runs.start",
  "runs.resume",
  "runs.redrive",
  "dlq.replay",
  "recovery.cases.resolve",
  "workflows.resume",
  "mcp.connections.create",
  "mcp.connections.update",
  "mcp.connections.rediscover",
  "mcp.connections.set_tool",
  "mcp.connections.delete",
]);

function toolAnnotations(name: string, readOnly: boolean): ToolAnnotations {
  return {
    readOnlyHint: readOnly,
    destructiveHint: DESTRUCTIVE_TOOLS.has(name),
    idempotentHint: readOnly ? true : IDEMPOTENT_WRITE_TOOLS.has(name),
    openWorldHint: OPEN_WORLD_TOOLS.has(name),
  };
}

function decorateTool(tool: Tool, readOnly: boolean): Tool {
  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      additionalProperties: false,
    },
    outputSchema: TOOL_RESULT_SCHEMA,
    annotations: toolAnnotations(tool.name, readOnly),
  };
}

/** True only for the exact process-wide write opt-in. */
export function mcpWritesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.JANUSLY_MCP_WRITES_ENABLED === "true";
}

/** Pure catalog projection used by boot and tests. */
export function listTools(env: NodeJS.ProcessEnv = process.env): Tool[] {
  const alwaysVisibleTools = ALWAYS_VISIBLE_TOOLS.map((tool) =>
    decorateTool(tool, !SIDE_EFFECTING_ALWAYS_VISIBLE_TOOLS.has(tool.name))
  );
  if (!mcpWritesEnabled(env)) return alwaysVisibleTools;
  return [
    ...alwaysVisibleTools,
    ...WRITE_TOOLS.map((tool) => decorateTool(tool, false)),
  ];
}

/** Static catalog used by the stdio server at module load. */
export const tools: Tool[] = listTools();
