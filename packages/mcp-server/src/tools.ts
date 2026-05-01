/**
 * MCP tool descriptors + dispatcher.
 *
 * `tools` is the static array MCP clients see when they call `tools/list`
 * (the handshake response). Each entry uses JSON Schema for `inputSchema`
 * because that's the protocol — Claude Desktop / Cursor / any MCP client
 * speaks JSON Schema natively, NOT Zod. The Zod-flavoured registry in
 * `packages/engine/src/tool-registry.ts` is a different thing (it describes
 * tools the workflow runtime can run, not tools an MCP client can call).
 *
 * `dispatchTool(callApi, name, args)` is the runtime side. It maps a tool
 * name to its API path, validates required args, calls the API, and wraps
 * the response in MCP's content-block format.
 *
 * Used by `packages/mcp-server/src/index.ts`'s `setRequestHandler` arms.
 *
 * Invariants:
 * - Read-only tools only. Write surface (start/save/replay) stays behind
 *   `requireRole` in the API and is intentionally NOT exposed to MCP yet.
 * - Errors thrown here are caught by the SDK's request-handler machinery
 *   and surfaced to the model as `{ isError: true, content: [...] }`.
 */

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CallApi } from "./api-client";

/**
 * Static tool catalog the MCP server advertises. Add a new entry here when
 * exposing another read-only API surface to MCP clients; pair it with a new
 * `case` arm in `runOne`.
 */
export const tools: Tool[] = [
  {
    name: "workflows.list",
    description:
      "List the workflows visible to the configured org. Returns at most 100 by default; pass `limit` (max 200) to widen.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          minimum: 1,
          maximum: 200,
          description: "Optional cap; defaults to 100.",
        },
      },
    },
  },
  {
    name: "workflows.get",
    description:
      "Fetch the latest version of one workflow by id. Returns the parsed DAG JSON plus version metadata, or null when the id is unknown.",
    inputSchema: {
      type: "object",
      required: ["workflowId"],
      properties: {
        workflowId: {
          type: "string",
          description: "Stable workflow id (the same id returned by `workflows.list`).",
        },
      },
    },
  },
  {
    name: "recipes.list",
    description:
      "List the built-in workflow templates (recipes) available to the org. Returns each template's id, name, category, description, and full DAG.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "tools.list",
    description:
      "List the runtime tool catalog the agent loop and `tool` node can invoke. Returns name, description, required/optional fields, and an input example per tool.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "runs.get",
    description:
      "Fetch one workflow run by id, including its node states and (paginated) event timeline. Use `eventsCursor` to walk older history; `eventsLimit` defaults to 200, max 500.",
    inputSchema: {
      type: "object",
      required: ["runId"],
      properties: {
        runId: { type: "string" },
        eventsLimit: {
          type: "number",
          minimum: 1,
          maximum: 500,
          description: "Optional cap; defaults to 200.",
        },
        eventsCursor: {
          type: "string",
          description: "Composite `<iso>|<eventId>` cursor returned by a prior call.",
        },
      },
    },
  },
];

/**
 * Dispatch one MCP tool call by name to its underlying API request, returning
 * the response wrapped in the standard MCP `text` content block. Errors
 * (unknown tool, missing required arg, non-2xx API response) throw with a
 * descriptive message; the SDK converts those into `{ isError: true }`.
 */
export async function dispatchTool(
  callApi: CallApi,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const json = await runOne(callApi, name, args);
  return {
    content: [{ type: "text", text: JSON.stringify(json, null, 2) }],
  };
}

async function runOne(
  callApi: CallApi,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "workflows.list": {
      const params = new URLSearchParams();
      if (typeof args.limit === "number" && Number.isFinite(args.limit) && args.limit > 0) {
        params.set("limit", String(args.limit));
      }
      const query = params.toString();
      return callApi(query ? `/workflows?${query}` : "/workflows");
    }
    case "workflows.get": {
      if (typeof args.workflowId !== "string" || args.workflowId.length === 0) {
        throw new Error("workflows.get requires `workflowId` (non-empty string)");
      }
      return callApi(`/workflows/latest?workflowId=${encodeURIComponent(args.workflowId)}`);
    }
    case "recipes.list":
      return callApi("/templates");
    case "tools.list":
      return callApi("/tools");
    case "runs.get": {
      if (typeof args.runId !== "string" || args.runId.length === 0) {
        throw new Error("runs.get requires `runId` (non-empty string)");
      }
      const params = new URLSearchParams({ runId: args.runId });
      if (typeof args.eventsLimit === "number") params.set("eventsLimit", String(args.eventsLimit));
      if (typeof args.eventsCursor === "string") params.set("eventsCursor", args.eventsCursor);
      return callApi(`/run?${params.toString()}`);
    }
    default:
      throw new Error(`Unknown MCP tool: ${name}`);
  }
}
