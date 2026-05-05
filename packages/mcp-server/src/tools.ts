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
 * - Tool surface split: read-only (`workflows.list`, `workflows.get`,
 *   `recipes.list`, `tools.list`, `runs.get`), pre-flight validation
 *   (`workflows.validate` — POST but no side effects), and no writes.
 *   `workflows.save` stays unadvertised and rejected until the MCP write
 *   consent/audit policy lands. The MCP server itself still has zero DB
 *   access and writes no audit rows of its own.
 * - Don't add more write tools without an explicit product/security review
 *   matching the required posture: explicit consent, RBAC enforced upstream,
 *   audit row written by the API, and safe exposure to a remote MCP client.
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
  {
    name: "workflows.validate",
    description:
      "Run shape + graph validation on a workflow without saving. Returns `{ valid: boolean, issues: ValidationIssue[] }`. No side effects.",
    inputSchema: {
      type: "object",
      required: ["workflow"],
      properties: {
        workflow: {
          type: "object",
          description:
            "Full workflow DAG: { dslVersion, nodes, edges, optional id/name/inputs/outputs/metadata }. Same shape `POST /validate` accepts.",
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
    case "workflows.validate": {
      if (!isObject(args.workflow)) {
        throw new Error("workflows.validate requires `workflow` (object)");
      }
      return callApi("/validate", {
        method: "POST",
        body: JSON.stringify(args.workflow),
      });
    }
    case "workflows.save": {
      throw new Error("workflows.save is disabled until the MCP write consent policy is implemented");
    }
    default:
      throw new Error(`Unknown MCP tool: ${name}`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
