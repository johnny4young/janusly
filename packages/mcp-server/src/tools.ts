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
 *   `workflows.versions`, `workflows.health`, `recipes.list`, `tools.list`,
 *   `runs.get`, `runs.list`, `dlq.list`, `dlq.clusters`,
 *   `recovery.metrics`, `reports.run_explain`, `ai.patch_workflow`),
 *   pre-flight checks (`workflows.validate` and `workflows.readiness` —
 *   POST but no side effects), and a gated write surface (`workflows.save`).
 *   Write tools are advertised ONLY when `JANUSLY_MCP_WRITES_ENABLED=true`.
 *   When the env is off the tool is absent from `tools()` and a direct call is
 *   rejected with a clear error. The API enforces a second gate
 *   (per-tenant `mcp.writeConsent`) so flipping the env without tenant
 *   opt-in still rejects at the wire. `ai.patch_workflow` is read-only
 *   from system-state POV (writes an audit row + incurs LLM cost, but
 *   never saves a workflow version); applying a suggested patch requires
 *   a follow-up `workflows.save` and therefore the same two-flag consent.
 * - Don't add more write tools without an explicit product/security review
 *   matching the required posture: explicit consent (both env + tenant),
 *   RBAC enforced upstream, audit row written by the API with
 *   `metadata.source: "mcp"`, per-tool rate limit, and safe exposure to a
 *   remote MCP client.
 * - The MCP server itself still has zero DB access and writes no audit
 *   rows of its own. All audit + scope enforcement lives on the API side.
 * - Errors thrown here are caught by the SDK's request-handler machinery
 *   and surfaced to the model as `{ isError: true, content: [...] }`.
 */

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CallApi } from "./api-client";

const DLQ_STATUSES = ["open", "replayed", "resolved"] as const;

/** True when the process-wide opt-in flag is on. */
export function mcpWritesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.JANUSLY_MCP_WRITES_ENABLED === "true";
}

/** Closed list of advertised write tools when env is on. Each entry is gated upstream by per-tenant `mcp.writeConsent`. */
const WRITE_TOOLS: Tool[] = [
  {
    name: "workflows.save",
    description:
      "Save a workflow as a new version. Pass `dryRun: true` to route the request to `/validate` instead — same shape check, no persistence. Gated by `JANUSLY_MCP_WRITES_ENABLED` (process) and `mcp.writeConsent` (tenant); a tenant that hasn't consented gets a 403 with `code: 'mcp_tenant_disabled'`. Per-org rate-limited at 60/min on the API side.",
    inputSchema: {
      type: "object",
      required: ["workflow"],
      properties: {
        workflow: {
          type: "object",
          description:
            "Full workflow DAG: { dslVersion, nodes, edges, optional id/name/inputs/outputs/metadata }. Same shape `POST /workflows/save` accepts.",
        },
        dryRun: {
          type: "boolean",
          description:
            "When true, route to /validate instead of /workflows/save. Returns `{ mode: 'dry-run', valid, issues }` without writing a new version.",
        },
      },
    },
  },
];

/**
 * Tool catalog the MCP server advertises. The read-only surface is always
 * present; write tools are appended only when `JANUSLY_MCP_WRITES_ENABLED=true`.
 *
 * `tools` (default export) is computed once at module load — matches how
 * the existing tests + boot path consume it. `listTools(env)` is a pure
 * variant for tests that want to vary the env per-case without re-loading
 * the module.
 */
const READ_TOOLS: Tool[] = [
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
  {
    name: "workflows.versions",
    description:
      "List every saved version of a workflow newest-first. Returns id, version number, dagJson, createdBy, and createdAt for each. Useful for showing the operator what versions exist before suggesting a rollback or comparing two snapshots.",
    inputSchema: {
      type: "object",
      required: ["workflowId"],
      properties: {
        workflowId: {
          type: "string",
          description: "Stable workflow id.",
        },
      },
    },
  },
  {
    name: "workflows.health",
    description:
      "Compute the per-workflow health rollup: a 0-100 score plus six per-category sub-scores (reliability, safety, latency, cost, maintainability, AI risk). Reads recent runs + readiness + DLQ counts. No side effects. Returns the same shape `GET /workflows/health` does.",
    inputSchema: {
      type: "object",
      required: ["workflowId"],
      properties: {
        workflowId: {
          type: "string",
          description: "Stable workflow id.",
        },
      },
    },
  },
  {
    name: "workflows.readiness",
    description:
      "Pre-flight a draft workflow against the safety / rollback / approval / secret-shape gates that production-mode `POST /start` enforces. Distinct from `workflows.validate` (which only checks structural validity). Returns `{ status: 'pass' | 'warn' | 'fail', issues: ReadinessIssue[] }`. No side effects.",
    inputSchema: {
      type: "object",
      required: ["workflow"],
      properties: {
        workflow: {
          type: "object",
          description:
            "Full workflow DAG to pre-flight. Same shape `workflows.validate` accepts.",
        },
      },
    },
  },
  {
    name: "runs.list",
    description:
      "List recent workflow runs newest-first. Optionally filter by `workflowId`. The upstream route caps at 100 by default and 200 max — pass `limit` to widen.",
    inputSchema: {
      type: "object",
      properties: {
        workflowId: {
          type: "string",
          description:
            "Optional filter — when present, only runs against this workflow id are returned.",
        },
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
    name: "dlq.list",
    description:
      "List dead-letter queue entries newest-first. Optionally filter by `status` (`open` | `replayed` | `resolved`). Useful for surfacing failures the operator hasn't attended to yet. The upstream route caps at 100 by default and 200 max.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["open", "replayed", "resolved"],
          description: "Optional status filter; omit to list all entries.",
        },
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
    name: "dlq.clusters",
    description:
      "List failure clusters — normalized signatures (e.g. \"Missing secret: GITHUB_TOKEN\", \"HTTP 401 on http node\") with frequency counts and DLQ-row samples, computed across the recent failure window. Use this to spot which failure shape is hitting the org most often before drilling into one DLQ entry. No side effects.",
    inputSchema: {
      type: "object",
      properties: {
        windowDays: {
          type: "number",
          minimum: 1,
          maximum: 90,
          description: "Lookback window in days. Defaults to 30 on the API side when omitted.",
        },
      },
    },
  },
  {
    name: "recovery.metrics",
    description:
      "Org-level recovery rollup — success rate, MTTR, p95 latency, approvals pending, replay rate, and cost — with severity bands per metric. Use this to answer \"how is recovery health right now?\" from chat. No side effects.",
    inputSchema: {
      type: "object",
      properties: {
        windowDays: {
          type: "number",
          minimum: 1,
          maximum: 90,
          description: "Lookback window in days. Defaults to 30 on the API side when omitted.",
        },
      },
    },
  },
  {
    name: "reports.run_explain",
    description:
      "Generate a structured explanation report for a single run (root cause, failed node, recommended next action, run metadata). Returns the JSON envelope shape; the equivalent Markdown rendering is available from the same API by passing format=markdown but this tool forces JSON for structured client consumption. No workflow mutation; the API writes the same report-export audit row as the web download path.",
    inputSchema: {
      type: "object",
      required: ["runId"],
      properties: {
        runId: { type: "string", description: "Stable run id (the same id returned by `runs.list` / `dlq.list`)." },
      },
    },
  },
  {
    name: "ai.patch_workflow",
    description:
      "Ask the AI for up to 3 suggested patches that would fix a specific failed DLQ entry. Returns each candidate as `{ workflow, rationale, approachLabel, confidence }` — the operator reviews and chooses one. NO workflow version is saved by this call; applying a chosen patch requires a separate `workflows.save` request, which is gated by the two-flag write consent (process `JANUSLY_MCP_WRITES_ENABLED` AND tenant `org_configs.mcp.writeConsent`). The API enforces per-org AI rate limit + LLM budget on this call.",
    inputSchema: {
      type: "object",
      required: ["deadLetterId"],
      properties: {
        deadLetterId: { type: "string", description: "Stable dead-letter id (from `dlq.list`)." },
      },
    },
  },
];

/** Pure variant that lets tests vary the env per-case. */
export function listTools(env: NodeJS.ProcessEnv = process.env): Tool[] {
  return mcpWritesEnabled(env) ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS;
}

export const tools: Tool[] = listTools();

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
    case "workflows.versions": {
      if (typeof args.workflowId !== "string" || args.workflowId.length === 0) {
        throw new Error("workflows.versions requires `workflowId` (non-empty string)");
      }
      return callApi(`/workflows/versions?workflowId=${encodeURIComponent(args.workflowId)}`);
    }
    case "workflows.health": {
      if (typeof args.workflowId !== "string" || args.workflowId.length === 0) {
        throw new Error("workflows.health requires `workflowId` (non-empty string)");
      }
      return callApi(`/workflows/health?workflowId=${encodeURIComponent(args.workflowId)}`);
    }
    case "workflows.readiness": {
      if (!isObject(args.workflow)) {
        throw new Error("workflows.readiness requires `workflow` (object)");
      }
      return callApi("/workflows/readiness", {
        method: "POST",
        body: JSON.stringify(args.workflow),
      });
    }
    case "runs.list": {
      const params = new URLSearchParams();
      if (typeof args.workflowId === "string" && args.workflowId.length > 0) {
        params.set("workflowId", args.workflowId);
      }
      if (typeof args.limit === "number" && Number.isFinite(args.limit) && args.limit > 0) {
        params.set("limit", String(args.limit));
      }
      const query = params.toString();
      return callApi(query ? `/runs?${query}` : "/runs");
    }
    case "dlq.list": {
      const params = new URLSearchParams();
      if (typeof args.status === "string" && args.status.length > 0) {
        if (!DLQ_STATUSES.includes(args.status as typeof DLQ_STATUSES[number])) {
          throw new Error("dlq.list status must be one of: open, replayed, resolved");
        }
        params.set("status", args.status);
      }
      if (typeof args.limit === "number" && Number.isFinite(args.limit) && args.limit > 0) {
        params.set("limit", String(args.limit));
      }
      const query = params.toString();
      return callApi(query ? `/dlq?${query}` : "/dlq");
    }
    case "dlq.clusters": {
      const params = new URLSearchParams();
      if (typeof args.windowDays === "number" && Number.isFinite(args.windowDays) && args.windowDays > 0) {
        params.set("windowDays", String(args.windowDays));
      }
      const query = params.toString();
      return callApi(query ? `/dlq/clusters?${query}` : "/dlq/clusters");
    }
    case "recovery.metrics": {
      const params = new URLSearchParams();
      if (typeof args.windowDays === "number" && Number.isFinite(args.windowDays) && args.windowDays > 0) {
        params.set("windowDays", String(args.windowDays));
      }
      const query = params.toString();
      return callApi(query ? `/recovery/metrics?${query}` : "/recovery/metrics");
    }
    case "reports.run_explain": {
      if (typeof args.runId !== "string" || args.runId.length === 0) {
        throw new Error("reports.run_explain requires `runId` (non-empty string)");
      }
      const params = new URLSearchParams({ runId: args.runId, format: "json" });
      return callApi(`/reports/run-explain?${params.toString()}`);
    }
    case "ai.patch_workflow": {
      if (typeof args.deadLetterId !== "string" || args.deadLetterId.length === 0) {
        throw new Error("ai.patch_workflow requires `deadLetterId` (non-empty string)");
      }
      return callApi("/ai/patch-workflow", {
        method: "POST",
        body: JSON.stringify({ deadLetterId: args.deadLetterId }),
      });
    }
    case "workflows.save": {
      if (!mcpWritesEnabled()) {
        throw new Error("workflows.save is disabled (set JANUSLY_MCP_WRITES_ENABLED=true to advertise)");
      }
      if (!isObject(args.workflow)) {
        throw new Error("workflows.save requires `workflow` (object)");
      }
      if (args.dryRun === true) {
        const validation = await callApi("/validate", {
          method: "POST",
          body: JSON.stringify(args.workflow),
        });
        return { mode: "dry-run", validation };
      }
      return callApi("/workflows/save", {
        method: "POST",
        body: JSON.stringify(args.workflow),
      });
    }
    default:
      throw new Error(`Unknown MCP tool: ${name}`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
