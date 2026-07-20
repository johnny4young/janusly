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
 * - Tool surface split. READ-ONLY (always advertised): describe / inspect
 *   (`workflows.list/get/versions/health`, `recipes.list`, `tools.list`,
 *   `runs.get/list`, `dlq.list/clusters`, `recovery.metrics`,
 *   `reports.run_explain`, `mcp.connections.list/tools`), pre-flight POSTs
 *   with no side effects (`workflows.validate`, `workflows.readiness`), and
 *   the two AI surfaces `ai.generate_workflow` + `ai.patch_workflow` (both
 *   read-only from system-state POV — they write an audit row + incur LLM
 *   cost but NEVER save a workflow version; persisting a suggestion needs a
 *   follow-up `workflows.save`, so the two-flag consent still gates the
 *   actual mutation). GATED WRITE surface (advertised ONLY when
 *   `JANUSLY_MCP_WRITES_ENABLED=true`): author (`workflows.save`,
 *   `workflows.rollback`), operate (`runs.start`, `runs.resume`,
 *   `runs.cancel`, `dlq.replay`), and outbound-connection management
 *   (`mcp.connections.create/rediscover/set_tool/delete`). When the env is
 *   off a write tool is absent from `listTools()` and a direct call is
 *   rejected by `requireWrites`. The API enforces the SECOND gate
 *   (per-tenant `mcp.writeConsent`, via `guardMcpWrite`) so flipping the env
 *   without tenant opt-in still 403s at the wire; the connection-management
 *   writes additionally require admin RBAC upstream.
 * - Don't add more write tools without an explicit product/security review
 *   matching the required posture: explicit consent (both env + tenant via
 *   `guardMcpWrite`), RBAC enforced upstream, audit row auto-tagged
 *   `metadata.source: "mcp"` by `auditAction`, per-tool rate limit, and safe
 *   exposure to a remote MCP client.
 * - The MCP server itself still has zero DB access and writes no audit
 *   rows of its own. All audit + scope enforcement lives on the API side.
 * - Errors thrown here are caught by the SDK's request-handler machinery
 *   and surfaced to the model as `{ isError: true, content: [...] }`.
 */

import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CallApi } from "./api-client";

const DLQ_STATUSES = ["open", "replayed", "resolved"] as const;
const MCP_ALIAS_PATTERN = /^[a-z0-9_-]{1,32}$/;

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
            "Full workflow DAG: { dslVersion, nodes, edges, optional id/name/inputs/outputs/metadata }. Same shape `POST /v1/workflows/save` accepts.",
        },
        dryRun: {
          type: "boolean",
          description:
            "When true, route to `/v1/validate` instead of `/v1/workflows/save`. Returns `{ mode: 'dry-run', valid, issues }` without writing a new version.",
        },
      },
    },
  },
  {
    name: "runs.start",
    description:
      "Start a run of a workflow. Pass the FULL workflow DAG in `workflow` (fetch a saved one with `workflows.get` first) plus optional typed `input`. Returns `{ runId }`; monitor with `runs.get`. Include the saved workflow's `id` in the DAG to run it as saved rather than ad-hoc. Gated by the two-flag write consent + per-org rate limit.",
    inputSchema: {
      type: "object",
      required: ["workflow"],
      properties: {
        workflow: { type: "object", description: "Full workflow DAG to run (same shape `POST /start` accepts)." },
        input: { type: "object", description: "Optional run input payload; validated against the workflow's declared `inputs` when present." },
      },
    },
  },
  {
    name: "runs.resume",
    description:
      "Resume a run paused at an `approval`, `webhook`, or `human_form` node. `human_form` requires a signed `resumeToken` and validates `input` against the node's schema. Returns `{ resumed: true }`. Two-flag write consent + rate limit apply.",
    inputSchema: {
      type: "object",
      required: ["runId", "nodeId"],
      properties: {
        runId: { type: "string" },
        nodeId: { type: "string", description: "The waiting node's id." },
        input: { type: "object", description: "Structured input captured as the resumed node's output (webhook / human_form)." },
        resumeToken: { type: "string", description: "HMAC resume token — required for `human_form` nodes." },
      },
    },
  },
  {
    name: "runs.cancel",
    description:
      "Cancel an in-flight run. A run already in a terminal state returns 409. Returns `{ runId, status: 'cancelled' }`. Two-flag write consent + rate limit apply.",
    inputSchema: {
      type: "object",
      required: ["runId"],
      properties: {
        runId: { type: "string" },
        reason: { type: "string", description: "Optional cancellation reason recorded on the run timeline + audit." },
      },
    },
  },
  {
    name: "dlq.replay",
    description:
      "Replay a dead-letter entry — re-enqueue the failed node so the run advances past the failure (after the cause is fixed, e.g. a patched workflow saved). Identify the entry by `deadLetterId` (from `dlq.list`) OR by `runId` + `nodeId`. Two-flag write consent + rate limit apply.",
    inputSchema: {
      type: "object",
      properties: {
        deadLetterId: { type: "string", description: "Stable dead-letter id (from `dlq.list`)." },
        runId: { type: "string", description: "Alternative to `deadLetterId`: the failed run id (requires `nodeId`)." },
        nodeId: { type: "string", description: "The failed node id (used with `runId`)." },
      },
    },
  },
  {
    name: "workflows.rollback",
    description:
      "Roll a workflow back to a prior saved version by appending that version's DAG as a new latest version (non-destructive). Get version ids from `workflows.versions`. Returns the new version metadata. Two-flag write consent + rate limit apply.",
    inputSchema: {
      type: "object",
      required: ["workflowId", "sourceVersionId"],
      properties: {
        workflowId: { type: "string" },
        sourceVersionId: { type: "string", description: "The version id to roll back to (from `workflows.versions`)." },
      },
    },
  },
  {
    name: "mcp.connections.create",
    description:
      "Register a new outbound MCP connection for the org so its tools become available to `mcp_tool` workflow steps. Discovery runs once at create; every discovered tool lands `enabled:false` / `writeSide:true` until opted in via `mcp.connections.set_tool`. Requires admin RBAC upstream IN ADDITION to the two-flag write consent.",
    inputSchema: {
      type: "object",
      required: ["alias", "transport"],
      properties: {
        alias: { type: "string", pattern: "^[a-z0-9_-]{1,32}$", description: "Unique per-org alias." },
        transport: { type: "string", enum: ["stdio", "sse", "http"], description: "MCP transport." },
        command: { type: "string", description: "stdio only: the allowlisted command to spawn." },
        args: { type: "array", items: { type: "string" }, description: "stdio only: command arguments." },
        url: { type: "string", description: "sse/http only: the server endpoint URL (SSRF-validated)." },
        envRefs: {
          type: "object",
          description:
            "Credential-name references resolved to secrets at call time — NEVER the secret values. Shape: { HEADER_OR_ENV: { kind: 'env', name: '<credential-name>' } }.",
        },
      },
    },
  },
  {
    name: "mcp.connections.rediscover",
    description:
      "Re-run tool discovery for one connection (picks up new/renamed upstream tools). Existing `enabled` / `writeSide` opt-ins survive. Requires admin RBAC + two-flag write consent.",
    inputSchema: {
      type: "object",
      required: ["alias"],
      properties: { alias: { type: "string", pattern: "^[a-z0-9_-]{1,32}$", description: "Connection alias." } },
    },
  },
  {
    name: "mcp.connections.set_tool",
    description:
      "Toggle one cached tool descriptor: `enabled` (opt the tool into workflows), `writeSide` (mark it a mutation for the dry-run + write-consent gates), `exposeToAi` (surface its description to the workflow generator), or `rateLimitPerMin`. Requires admin RBAC + two-flag write consent.",
    inputSchema: {
      type: "object",
      required: ["alias", "toolName"],
      properties: {
        alias: { type: "string", pattern: "^[a-z0-9_-]{1,32}$" },
        toolName: { type: "string", minLength: 1, maxLength: 512 },
        enabled: { type: "boolean" },
        writeSide: { type: "boolean" },
        exposeToAi: { type: "boolean" },
        rateLimitPerMin: {
          type: "number",
          minimum: 1,
          maximum: 10000,
          description: "Per-tool override; omit to use the org default.",
        },
      },
    },
  },
  {
    name: "mcp.connections.delete",
    description:
      "Delete an outbound MCP connection and its cached tool descriptors. Workflows referencing its tools fail on next run until re-registered. Requires admin RBAC + two-flag write consent.",
    inputSchema: {
      type: "object",
      required: ["alias"],
      properties: { alias: { type: "string", pattern: "^[a-z0-9_-]{1,32}$", description: "Connection alias." } },
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
      "Compute the per-workflow health rollup: a 0-100 score plus six per-category sub-scores (reliability, safety, latency, cost, maintainability, AI risk). Reads recent runs + readiness + DLQ counts. No side effects. Returns the same shape `GET /v1/workflows/health` does.",
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
  {
    name: "ai.generate_workflow",
    description:
      "Generate a complete workflow DAG from a natural-language goal. Returns `{ workflow, mode, aiError? }` — `mode: 'ai'` on success, `mode: 'fallback'` (with `aiError`) when the LLM is unavailable so you always get a runnable draft. NO version is saved: validate it (`workflows.validate` / `workflows.readiness`), then persist with `workflows.save` (two-flag write consent). The API enforces per-org AI rate limit + LLM budget on this call.",
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: {
          type: "string",
          description:
            "Plain-language description of what the workflow should do (e.g. \"When a Stripe webhook arrives, look up the customer in Postgres and email them a receipt PDF\").",
        },
      },
    },
  },
  {
    name: "mcp.connections.list",
    description:
      "List the org's registered outbound MCP connections (the external MCP servers Janusly can call as `mcp_tool` workflow steps): alias, transport, status, exposeToAi flag, and per-tool counts. No side effects.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mcp.connections.tools",
    description:
      "List the cached tool descriptors for one MCP connection: name, description, `enabled`, `writeSide`, `exposeToAi`, and any per-tool rate limit. Use it before `mcp.connections.set_tool` to see what to toggle. No side effects.",
    inputSchema: {
      type: "object",
      required: ["alias"],
      properties: {
        alias: { type: "string", pattern: "^[a-z0-9_-]{1,32}$", description: "Connection alias (from `mcp.connections.list`)." },
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

/** True when `value` is a positive, finite number — the shape every optional `limit` / `windowDays` arg must satisfy before it becomes a query param. */
function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function requireMcpAlias(value: unknown, toolName: string): string {
  if (typeof value === "string" && MCP_ALIAS_PATTERN.test(value)) return value;
  throw new Error(`${toolName} requires \`alias\` matching /^[a-z0-9_-]{1,32}$/`);
}

function requireMcpToolName(value: unknown): string {
  if (typeof value === "string" && value.trim().length > 0 && value.length <= 512) return value;
  throw new Error("mcp.connections.set_tool requires `toolName` (1-512 characters)");
}

async function runOne(
  callApi: CallApi,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "workflows.list": {
      const params = new URLSearchParams();
      if (isPositiveNumber(args.limit)) {
        params.set("limit", String(args.limit));
      }
      const query = params.toString();
      return callApi(query ? `/v1/workflows?${query}` : "/v1/workflows");
    }
    case "workflows.get": {
      if (typeof args.workflowId !== "string" || args.workflowId.length === 0) {
        throw new Error("workflows.get requires `workflowId` (non-empty string)");
      }
      return callApi(`/v1/workflows/latest?workflowId=${encodeURIComponent(args.workflowId)}`);
    }
    case "recipes.list":
      return callApi("/v1/templates");
    case "tools.list":
      return callApi("/v1/tools");
    case "runs.get": {
      if (typeof args.runId !== "string" || args.runId.length === 0) {
        throw new Error("runs.get requires `runId` (non-empty string)");
      }
      const params = new URLSearchParams({ runId: args.runId });
      if (typeof args.eventsLimit === "number") params.set("eventsLimit", String(args.eventsLimit));
      if (typeof args.eventsCursor === "string") params.set("eventsCursor", args.eventsCursor);
      return callApi(`/v1/run?${params.toString()}`);
    }
    case "workflows.validate": {
      if (!isObject(args.workflow)) {
        throw new Error("workflows.validate requires `workflow` (object)");
      }
      return callApi("/v1/validate", {
        method: "POST",
        body: JSON.stringify(args.workflow),
      });
    }
    case "workflows.versions": {
      if (typeof args.workflowId !== "string" || args.workflowId.length === 0) {
        throw new Error("workflows.versions requires `workflowId` (non-empty string)");
      }
      return callApi(`/v1/workflows/versions?workflowId=${encodeURIComponent(args.workflowId)}`);
    }
    case "workflows.health": {
      if (typeof args.workflowId !== "string" || args.workflowId.length === 0) {
        throw new Error("workflows.health requires `workflowId` (non-empty string)");
      }
      return callApi(`/v1/workflows/health?workflowId=${encodeURIComponent(args.workflowId)}`);
    }
    case "workflows.readiness": {
      if (!isObject(args.workflow)) {
        throw new Error("workflows.readiness requires `workflow` (object)");
      }
      return callApi("/v1/workflows/readiness", {
        method: "POST",
        body: JSON.stringify(args.workflow),
      });
    }
    case "runs.list": {
      const params = new URLSearchParams();
      if (typeof args.workflowId === "string" && args.workflowId.length > 0) {
        params.set("workflowId", args.workflowId);
      }
      if (isPositiveNumber(args.limit)) {
        params.set("limit", String(args.limit));
      }
      const query = params.toString();
      return callApi(query ? `/v1/runs?${query}` : "/v1/runs");
    }
    case "dlq.list": {
      const params = new URLSearchParams();
      if (typeof args.status === "string" && args.status.length > 0) {
        if (!DLQ_STATUSES.includes(args.status as typeof DLQ_STATUSES[number])) {
          throw new Error("dlq.list status must be one of: open, replayed, resolved");
        }
        params.set("status", args.status);
      }
      if (isPositiveNumber(args.limit)) {
        params.set("limit", String(args.limit));
      }
      const query = params.toString();
      return callApi(query ? `/dlq?${query}` : "/dlq");
    }
    case "dlq.clusters": {
      const params = new URLSearchParams();
      if (isPositiveNumber(args.windowDays)) {
        params.set("windowDays", String(args.windowDays));
      }
      const query = params.toString();
      return callApi(query ? `/dlq/clusters?${query}` : "/dlq/clusters");
    }
    case "recovery.metrics": {
      const params = new URLSearchParams();
      if (isPositiveNumber(args.windowDays)) {
        params.set("windowDays", String(args.windowDays));
      }
      const query = params.toString();
      return callApi(query ? `/v1/recovery/metrics?${query}` : "/v1/recovery/metrics");
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
    case "ai.generate_workflow": {
      if (typeof args.prompt !== "string" || args.prompt.trim().length === 0) {
        throw new Error("ai.generate_workflow requires `prompt` (non-empty string)");
      }
      return callApi("/ai/generate-workflow", {
        method: "POST",
        body: JSON.stringify({ prompt: args.prompt }),
      });
    }
    case "mcp.connections.list":
      return callApi("/v1/mcp/connections");
    case "mcp.connections.tools": {
      const alias = requireMcpAlias(args.alias, name);
      return callApi(`/v1/mcp/connections/${encodeURIComponent(alias)}/tools`);
    }
    case "runs.start": {
      requireWrites(name);
      if (!isObject(args.workflow)) {
        throw new Error("runs.start requires `workflow` (object)");
      }
      const payload: Record<string, unknown> = { workflow: args.workflow };
      if (args.input !== undefined) payload.input = args.input;
      return callApi("/v1/start", { method: "POST", body: JSON.stringify(payload) });
    }
    case "runs.resume": {
      requireWrites(name);
      if (typeof args.runId !== "string" || typeof args.nodeId !== "string") {
        throw new Error("runs.resume requires `runId` and `nodeId` (strings)");
      }
      const payload: Record<string, unknown> = { runId: args.runId, nodeId: args.nodeId };
      if (args.input !== undefined) payload.input = args.input;
      if (typeof args.resumeToken === "string") payload.resumeToken = args.resumeToken;
      return callApi("/v1/resume", { method: "POST", body: JSON.stringify(payload) });
    }
    case "runs.cancel": {
      requireWrites(name);
      if (typeof args.runId !== "string" || args.runId.length === 0) {
        throw new Error("runs.cancel requires `runId` (non-empty string)");
      }
      const payload: Record<string, unknown> = { runId: args.runId };
      if (typeof args.reason === "string") payload.reason = args.reason;
      return callApi("/v1/run/cancel", { method: "POST", body: JSON.stringify(payload) });
    }
    case "dlq.replay": {
      requireWrites(name);
      const payload: Record<string, unknown> = {};
      if (typeof args.deadLetterId === "string" && args.deadLetterId.length > 0) {
        payload.deadLetterId = args.deadLetterId;
      } else if (typeof args.runId === "string" && typeof args.nodeId === "string") {
        payload.runId = args.runId;
        payload.nodeId = args.nodeId;
      } else {
        throw new Error("dlq.replay requires `deadLetterId` OR both `runId` and `nodeId`");
      }
      return callApi("/dlq/replay", { method: "POST", body: JSON.stringify(payload) });
    }
    case "workflows.rollback": {
      requireWrites(name);
      if (typeof args.workflowId !== "string" || typeof args.sourceVersionId !== "string") {
        throw new Error("workflows.rollback requires `workflowId` and `sourceVersionId` (strings)");
      }
      return callApi("/v1/workflows/rollback", {
        method: "POST",
        body: JSON.stringify({ workflowId: args.workflowId, sourceVersionId: args.sourceVersionId }),
      });
    }
    case "mcp.connections.create": {
      requireWrites(name);
      requireMcpAlias(args.alias, name);
      if (typeof args.transport !== "string") {
        throw new Error("mcp.connections.create requires `transport` (string)");
      }
      return callApi("/v1/mcp/connections", { method: "POST", body: JSON.stringify(args) });
    }
    case "mcp.connections.rediscover": {
      requireWrites(name);
      const alias = requireMcpAlias(args.alias, name);
      return callApi(`/v1/mcp/connections/${encodeURIComponent(alias)}/rediscover`, {
        method: "POST",
        body: "{}",
      });
    }
    case "mcp.connections.set_tool": {
      requireWrites(name);
      const alias = requireMcpAlias(args.alias, name);
      const toolName = requireMcpToolName(args.toolName);
      const patch = { ...args };
      delete patch.alias;
      delete patch.toolName;
      return callApi(
        `/v1/mcp/connections/${encodeURIComponent(alias)}/tools/${encodeURIComponent(toolName)}`,
        { method: "POST", body: JSON.stringify(patch) },
      );
    }
    case "mcp.connections.delete": {
      requireWrites(name);
      const alias = requireMcpAlias(args.alias, name);
      return callApi(`/v1/mcp/connections/${encodeURIComponent(alias)}`, { method: "DELETE" });
    }
    case "workflows.save": {
      requireWrites(name);
      if (!isObject(args.workflow)) {
        throw new Error("workflows.save requires `workflow` (object)");
      }
      if (args.dryRun === true) {
        const validation = await callApi("/v1/validate", {
          method: "POST",
          body: JSON.stringify(args.workflow),
        });
        return { mode: "dry-run", validation };
      }
      return callApi("/v1/workflows/save", {
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

/**
 * Guard every write-tool dispatch: refuse when `JANUSLY_MCP_WRITES_ENABLED`
 * is off. Write tools are also absent from `listTools()` when the env is off,
 * so this is defense-in-depth against a client that calls a tool it never saw
 * advertised. The API enforces the SECOND gate (per-tenant `mcp.writeConsent`)
 * regardless — flipping the env without tenant opt-in still 403s at the wire.
 */
function requireWrites(name: string): void {
  if (!mcpWritesEnabled()) {
    throw new Error(`${name} is disabled (set JANUSLY_MCP_WRITES_ENABLED=true to advertise)`);
  }
}
