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
 * - Tool surface split. ALWAYS ADVERTISED: workflow/catalog,
 *   run/status/usage, recovery/memory evidence, reports, and outbound MCP
 *   inspection; pre-flight POSTs with no workflow mutation
 *   (`workflows.validate`, `workflows.readiness`); and the two AI surfaces
 *   `ai.generate_workflow` + `ai.patch_workflow` (both
 *   write audit/usage evidence + incur LLM cost but NEVER save a workflow
 *   version; their MCP `readOnlyHint` is therefore false even though they are
 *   always visible). Persisting a suggestion needs a follow-up
 *   `workflows.save`, so the two-flag consent still gates the durable product
 *   mutation. GATED WRITE surface (advertised ONLY when
 *   `JANUSLY_MCP_WRITES_ENABLED=true`): author (`workflows.save`,
 *   `workflows.rollback`, `workflows.resume`), operate (`runs.start`,
 *   `runs.resume`, `runs.redrive`, `runs.cancel`, `dlq.replay`), and
 *   outbound-connection management
 *   (`mcp.connections.create/update/rediscover/set_tool/delete`). When the
 *   env is off a write tool is absent from `listTools()` and a direct call is
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
 * - `dispatchTool` throws expected input/API errors to direct callers. The
 *   protocol handler in `index.ts` converts them with `toolErrorResult`, so
 *   an MCP host receives `{ isError: true }` rather than JSON-RPC -32603.
 */

import { V1_MCP_PATHS, V1_READ_PATHS, V1_WRITE_PATHS } from "@janusly/shared/src/api-contract";
import { runStatusValues } from "@janusly/shared/src/status";
import type {
  CallToolResult,
  Tool,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import {
  JanuslyApiError,
  JanuslyProtocolError,
  type CallApi,
} from "./api-client";

const DLQ_STATUSES = ["open", "replayed", "resolved"] as const;
const DLQ_SEVERITIES = ["p1", "p2", "p3", "p4"] as const;
const DLQ_SORTS = ["newest", "oldest", "severity", "sla"] as const;
const RUN_KINDS = ["production", "validation"] as const;
const MCP_TRANSPORTS = ["stdio", "sse", "http"] as const;
const MCP_ALIAS_PATTERN = /^[a-z0-9_-]{1,32}$/;
const MCP_ENV_REF_KEY_PATTERN = /^(?:[a-z0-9_-]{1,32}|[A-Z][A-Z0-9_]{0,63})$/;
const V1_PREFIX = "/v1";

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

function v1(path: string): string {
  return `${V1_PREFIX}${path}`;
}

function toolAnnotations(name: string, readOnly: boolean): ToolAnnotations {
  return {
    readOnlyHint: readOnly,
    destructiveHint: DESTRUCTIVE_TOOLS.has(name),
    idempotentHint: readOnly
      ? true
      : IDEMPOTENT_WRITE_TOOLS.has(name),
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
      "Start a run of a workflow. Pass the FULL workflow DAG in `workflow` (fetch a saved one with `workflows.get` first) plus optional typed `input`. Returns `{ runId }`; poll with `runs.status` and use `runs.get` for paginated history. Include the saved workflow's `id` in the DAG to run it as saved rather than ad-hoc. Gated by the two-flag write consent + per-org rate limit.",
    inputSchema: {
      type: "object",
      required: ["workflow"],
      properties: {
        workflow: { type: "object", description: "Full workflow DAG to run (same shape `POST /start` accepts)." },
        input: {
          description:
            "Optional JSON run input. It may be an object, array, scalar, or null and is validated against the workflow's declared `inputs` when present.",
        },
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
        runId: { type: "string", minLength: 1, maxLength: 256 },
        nodeId: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          description: "The waiting node's id.",
        },
        input: {
          description:
            "JSON input captured as the resumed node's output (webhook / human_form).",
        },
        resumeToken: {
          type: "string",
          minLength: 1,
          maxLength: 8192,
          description: "HMAC resume token — required for `human_form` nodes.",
        },
      },
    },
  },
  {
    name: "runs.redrive",
    description:
      "Continue a failed saved-workflow run from its failed node on the latest or an explicit saved workflow version, reusing succeeded upstream outputs. Use this after validating and saving a patch; unlike `dlq.replay`, redrive can execute the patched version. Returns a durable `{ runId }` and is idempotent for the same source node + target version. Two-flag write consent + rate limit apply.",
    inputSchema: {
      type: "object",
      required: ["runId"],
      properties: {
        runId: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          description: "Failed source run id.",
        },
        nodeId: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          description:
            "Failed node id. Required only when the source run has multiple failed nodes.",
        },
        workflowVersionId: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          description:
            "Optional saved target version. Omit to use the workflow's latest version.",
        },
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
        runId: { type: "string", minLength: 1, maxLength: 256 },
        reason: {
          type: "string",
          minLength: 1,
          maxLength: 1000,
          description: "Optional cancellation reason recorded on the run timeline + audit.",
        },
      },
    },
  },
  {
    name: "dlq.replay",
    description:
      "Replay a dead-letter entry — re-enqueue the failed node through its generation-bound recovery claim so the run can advance after the cause is fixed. Requires the stable `deadLetterId` from `dlq.list`. Two-flag write consent + rate limit apply.",
    inputSchema: {
      type: "object",
      required: ["deadLetterId"],
      properties: {
        deadLetterId: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          description: "Stable dead-letter id (from `dlq.list`).",
        },
      },
    },
  },
  {
    name: "recovery.cases.resolve",
    description:
      "Resolve one deterministic semantic recovery case after inspecting it with `recovery.cases.get`. A replacement is re-validated against the workflow's operator-owned outcome contract before the run can resume; accepting loss is explicit and audited. This can release downstream effects, so two-flag write consent + per-tool rate limit apply.",
    inputSchema: {
      type: "object",
      required: ["caseId", "decision", "reason"],
      properties: {
        caseId: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          description: "Stable case id returned by `recovery.cases.list`.",
        },
        decision: {
          type: "string",
          enum: ["replace", "accept_loss"],
          description:
            "Use `replace` to validate a corrected JSON output, or `accept_loss` to acknowledge the observed outcome explicitly.",
        },
        output: {
          description:
            "Required for `replace`: the complete JSON value that should become the quarantined node's output.",
        },
        reason: {
          type: "string",
          minLength: 1,
          maxLength: 1000,
          description: "Operator rationale written to the durable case history.",
        },
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
        workflowId: { type: "string", minLength: 1, maxLength: 512 },
        sourceVersionId: {
          type: "string",
          minLength: 1,
          maxLength: 512,
          description: "The version id to roll back to (from `workflows.versions`).",
        },
      },
    },
  },
  {
    name: "workflows.resume",
    description:
      "Manually resume a workflow paused by Janusly's recovery circuit breaker and backfill its buffered trigger events oldest-first. Other pause reasons are rejected. Repeat only when `remaining` is greater than zero to drain another bounded page. Two-flag write consent applies.",
    inputSchema: {
      type: "object",
      required: ["workflowId"],
      properties: {
        workflowId: {
          type: "string",
          minLength: 1,
          maxLength: 512,
          description: "Workflow id currently paused by its recovery circuit breaker.",
        },
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
        command: {
          type: "string",
          minLength: 1,
          maxLength: 512,
          description: "stdio only: the allowlisted command to spawn.",
        },
        args: {
          type: "array",
          maxItems: 32,
          items: { type: "string", minLength: 1, maxLength: 200 },
          description: "stdio only: command arguments.",
        },
        url: {
          type: "string",
          minLength: 1,
          maxLength: 2048,
          description: "sse/http only: the server endpoint URL (SSRF-validated).",
        },
        envRefs: {
          type: "object",
          description:
            "Deployment environment-variable references resolved at call time — NEVER secret values. Shape: { HEADER_OR_ENV: { kind: 'env', name: '<environment-variable-name>' } }.",
          propertyNames: { pattern: "^(?:[a-z0-9_-]{1,32}|[A-Z][A-Z0-9_]{0,63})$" },
          additionalProperties: {
            type: "object",
            required: ["kind", "name"],
            properties: {
              kind: { const: "env" },
              name: { type: "string", minLength: 1, maxLength: 128 },
            },
            additionalProperties: false,
          },
        },
      },
    },
  },
  {
    name: "mcp.connections.update",
    description:
      "Update an outbound MCP connection's enabled state, transport settings, environment references, or AI-exposure flag. Only supplied fields change. Requires admin RBAC + two-flag write consent.",
    inputSchema: {
      type: "object",
      required: ["alias"],
      properties: {
        alias: { type: "string", pattern: "^[a-z0-9_-]{1,32}$", description: "Connection alias." },
        enabled: { type: "boolean" },
        exposeToAi: { type: "boolean" },
        command: { type: "string", minLength: 1, maxLength: 512, description: "stdio only: allowlisted command." },
        args: {
          type: "array",
          maxItems: 32,
          items: { type: "string", minLength: 1, maxLength: 200 },
          description: "stdio only: command arguments.",
        },
        url: { type: "string", minLength: 1, maxLength: 2048, description: "sse/http only: SSRF-validated endpoint URL." },
        envRefs: {
          type: "object",
          description:
            "Deployment environment-variable references; values are resolved only inside Janusly.",
          propertyNames: { pattern: "^(?:[a-z0-9_-]{1,32}|[A-Z][A-Z0-9_]{0,63})$" },
          additionalProperties: {
            type: "object",
            required: ["kind", "name"],
            properties: {
              kind: { const: "env" },
              name: { type: "string", minLength: 1, maxLength: 128 },
            },
            additionalProperties: false,
          },
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
          type: ["integer", "null"],
          minimum: 1,
          maximum: 10000,
          description:
            "Per-tool override; omit to keep the current value, or pass null to use the org default.",
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
 * Tool catalog the MCP server advertises. The inspection/AI surface is always
 * present; gated write tools are appended only when
 * `JANUSLY_MCP_WRITES_ENABLED=true`.
 *
 * `tools` (default export) is computed once at module load — matches how
 * the existing tests + boot path consume it. `listTools(env)` is a pure
 * variant for tests that want to vary the env per-case without re-loading
 * the module.
 */
const ALWAYS_VISIBLE_TOOLS: Tool[] = [
  {
    name: "workflows.list",
    description:
      "List active workflows visible to the configured org with bounded filters and keyset pagination. For the next page, pass `before` as `<createdAt>|<id>` from the final row.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Optional cap; defaults to 100.",
        },
        tag: {
          type: "array",
          maxItems: 20,
          items: { type: "string", minLength: 1, maxLength: 40 },
          description: "Optional tags; every supplied tag must match.",
        },
        folder: {
          type: "string",
          minLength: 1,
          maxLength: 60,
          description: "Optional exact folder filter.",
        },
        q: {
          type: "string",
          minLength: 1,
          maxLength: 100,
          description: "Optional case-insensitive workflow name or id search.",
        },
        before: {
          type: "string",
          minLength: 3,
          maxLength: 512,
          description: "Opaque `<createdAt>|<id>` keyset cursor derived from the preceding page's final row.",
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
          minLength: 1,
          maxLength: 512,
          description: "Stable workflow id (the same id returned by `workflows.list`).",
        },
      },
    },
  },
  {
    name: "memory.consent_status",
    description:
      "Read effective process + tenant memory consent and any pending purge state. Use this before authoring workflows that rely on vector memory.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "recovery.ledger",
    description:
      "Read the tenant's lifetime, impact-bound recovery ledger: recovered count, downtime ended, and first measured instant.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "recovery.my_wins",
    description:
      "Read the authenticated operator's recent attributable DLQ recoveries.",
    inputSchema: {
      type: "object",
      properties: {
        days: {
          type: "integer",
          minimum: 1,
          maximum: 90,
          description: "Rolling window in days; defaults to 30.",
        },
      },
    },
  },
  {
    name: "recovery.cases.list",
    description:
      "List bounded tenant-scoped semantic recovery cases. Open cases are returned by default; filter by run when investigating a specific execution.",
    inputSchema: {
      type: "object",
      properties: {
        openOnly: {
          type: "boolean",
          description: "Defaults to true. Set false to include terminal cases.",
        },
        runId: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          description: "Optional exact run id.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Optional cap; defaults to 100.",
        },
      },
    },
  },
  {
    name: "recovery.cases.get",
    description:
      "Inspect one semantic recovery case with its append-only transition history before proposing or applying a resolution.",
    inputSchema: {
      type: "object",
      required: ["caseId"],
      properties: {
        caseId: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          description: "Stable case id returned by `recovery.cases.list`.",
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
        runId: { type: "string", minLength: 1, maxLength: 256 },
        eventsLimit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description: "Optional cap; defaults to 200.",
        },
        eventsCursor: {
          type: "string",
          minLength: 3,
          maxLength: 512,
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
          minLength: 1,
          maxLength: 512,
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
          minLength: 1,
          maxLength: 512,
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
    name: "workflows.schedule_preview",
    description:
      "Validate a five-field cron expression and preview its next three UTC fire instants. No schedule is saved.",
    inputSchema: {
      type: "object",
      required: ["cron"],
      properties: {
        cron: {
          type: "string",
          minLength: 1,
          maxLength: 100,
          description: "Five-field cron expression.",
        },
      },
    },
  },
  {
    name: "runs.list",
    description:
      "List recent workflow runs newest-first with workflow, status, run-kind, and keyset filters. For the next page, pass `before` as `<createdAt>|<id>` from the final row.",
    inputSchema: {
      type: "object",
      properties: {
        workflowId: {
          type: "string",
          minLength: 1,
          maxLength: 512,
          description:
            "Optional filter — when present, only runs against this workflow id are returned.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Optional cap; defaults to 100.",
        },
        status: {
          type: "string",
          enum: [...runStatusValues],
          description: "Optional run lifecycle status.",
        },
        runKind: {
          type: "string",
          enum: [...RUN_KINDS],
          description: "Production or validation runs.",
        },
        before: {
          type: "string",
          minLength: 3,
          maxLength: 512,
          description: "Opaque `<createdAt>|<id>` keyset cursor derived from the preceding page's final row.",
        },
      },
    },
  },
  {
    name: "runs.status",
    description:
      "Poll the latest state and bounded event page for one run. Prefer this lightweight polling contract after `runs.start`; use `runs.get` with `eventsCursor` when walking older history.",
    inputSchema: {
      type: "object",
      required: ["runId"],
      properties: {
        runId: { type: "string", minLength: 1, maxLength: 256 },
        eventsLimit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description: "Optional event cap; defaults to 200.",
        },
      },
    },
  },
  {
    name: "runs.usage",
    description:
      "Read bounded LLM token/cost and memory-operation usage attributed to one run.",
    inputSchema: {
      type: "object",
      required: ["runId"],
      properties: {
        runId: { type: "string", minLength: 1, maxLength: 256 },
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
        severity: {
          type: "string",
          enum: ["p1", "p2", "p3", "p4"],
          description: "Optional severity filter.",
        },
        sort: {
          type: "string",
          enum: ["newest", "oldest", "severity", "sla"],
          description: "Optional sort mode.",
        },
        owner: {
          type: "string",
          minLength: 1,
          maxLength: 200,
          description: "Optional owner filter.",
        },
        search: {
          type: "string",
          minLength: 1,
          maxLength: 100,
          description: "Optional bounded search term.",
        },
        limit: {
          type: "integer",
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
          type: "integer",
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
          type: "integer",
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
      "Generate a structured explanation report for a single run (root cause, failed node, recommended next action, run metadata). Uses the stable JSON contract; the equivalent Markdown artifact remains available from the unversioned download endpoint. No workflow mutation; the API writes the same report-export audit row as the web download path.",
    inputSchema: {
      type: "object",
      required: ["runId"],
      properties: {
        runId: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          description: "Stable run id (the same id returned by `runs.list` / `dlq.list`).",
        },
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
        deadLetterId: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          description: "Stable dead-letter id (from `dlq.list`).",
        },
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
          minLength: 1,
          maxLength: 20000,
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
  const alwaysVisibleTools = ALWAYS_VISIBLE_TOOLS.map((tool) =>
    decorateTool(tool, !SIDE_EFFECTING_ALWAYS_VISIBLE_TOOLS.has(tool.name))
  );
  if (!mcpWritesEnabled(env)) return alwaysVisibleTools;
  return [
    ...alwaysVisibleTools,
    ...WRITE_TOOLS.map((tool) => decorateTool(tool, false)),
  ];
}

export const tools: Tool[] = listTools();

/**
 * Dispatch one MCP tool call by name to its underlying API request, returning
 * the response as both compatible JSON text and machine-readable
 * `structuredContent`. Direct dispatcher errors throw; `index.ts` converts
 * them into `isError` tool results at the protocol boundary.
 */
export async function dispatchTool(
  callApi: CallApi,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  assertKnownArguments(name, args);
  const json = await runOne(callApi, name, args);
  const result = json === undefined ? null : json;
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent: { result },
  };
}

function assertKnownArguments(name: string, args: Record<string, unknown>): void {
  const descriptor = [...ALWAYS_VISIBLE_TOOLS, ...WRITE_TOOLS]
    .find((tool) => tool.name === name);
  if (!descriptor) throw new Error(`Unknown MCP tool: ${name}`);

  const properties = descriptor.inputSchema.properties ?? {};
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(properties, key)) {
      throw new Error(`${name} received unknown argument \`${key}\``);
    }
  }
}

/**
 * Convert an expected dispatcher/API failure into an MCP tool result.
 * Expected tool failures stay inside the model's tool loop instead of
 * becoming JSON-RPC -32603 transport failures.
 */
export function toolErrorResult(error: unknown): CallToolResult {
  const detail = normalizeToolError(error);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(detail, null, 2) }],
    structuredContent: { result: detail },
  };
}

function normalizeToolError(error: unknown): Record<string, unknown> {
  if (error instanceof JanuslyApiError) {
    return {
      ok: false,
      error: {
        message: error.message,
        code: error.code ?? "janusly_api_error",
        status: error.status,
        ...(error.requestId ? { requestId: error.requestId } : {}),
        ...(error.params ? { params: error.params } : {}),
      },
    };
  }
  if (error instanceof JanuslyProtocolError) {
    return {
      ok: false,
      error: {
        message: error.message,
        code: "janusly_protocol_error",
      },
    };
  }
  return {
    ok: false,
    error: {
      message: error instanceof Error ? error.message : "Tool call failed",
      code: "mcp_tool_error",
    },
  };
}

function optionalInteger(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number"
    || !Number.isInteger(value)
    || value < min
    || value > max
  ) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function optionalString(
  value: unknown,
  label: string,
  maxLength: number,
  minLength = 1,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length < minLength || normalized.length > maxLength) {
    throw new Error(`${label} must be ${minLength}-${maxLength} characters`);
  }
  return normalized;
}

function requireString(
  value: unknown,
  label: string,
  maxLength = 512,
): string {
  const normalized = optionalString(value, label, maxLength);
  if (normalized === undefined) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function optionalEnum<T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${label} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function optionalStringArray(
  value: unknown,
  label: string,
  maxItems: number,
  maxItemLength: number,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`${label} must be an array with at most ${maxItems} items`);
  }
  return value.map((item, index) =>
    requireString(item, `${label}[${index}]`, maxItemLength)
  );
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be a boolean`);
  }
  return value;
}

function optionalEnvRefs(
  value: unknown,
  label: string,
): Record<string, { kind: "env"; name: string }> | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
    throw new Error(`${label} must be an object`);
  }
  const refs: Record<string, { kind: "env"; name: string }> = {};
  for (const [key, ref] of Object.entries(value)) {
    if (!MCP_ENV_REF_KEY_PATTERN.test(key) || !isObject(ref) || ref.kind !== "env") {
      throw new Error(`${label} contains an invalid environment reference`);
    }
    const unknownRefField = Object.keys(ref).find(
      (field) => field !== "kind" && field !== "name",
    );
    if (unknownRefField) {
      throw new Error(`${label}.${key} contains unknown field \`${unknownRefField}\``);
    }
    refs[key] = {
      kind: "env",
      name: requireString(ref.name, `${label}.${key}.name`, 128),
    };
  }
  return refs;
}

function connectionCreatePayload(args: Record<string, unknown>): Record<string, unknown> {
  const alias = requireMcpAlias(args.alias, "mcp.connections.create");
  const transport = optionalEnum(
    args.transport,
    "mcp.connections.create `transport`",
    MCP_TRANSPORTS,
  );
  if (transport === undefined) {
    throw new Error("mcp.connections.create `transport` is required");
  }
  const payload: Record<string, unknown> = { alias, transport };
  const command = optionalString(args.command, "mcp.connections.create `command`", 512);
  const commandArgs = optionalStringArray(args.args, "mcp.connections.create `args`", 32, 200);
  const url = optionalString(args.url, "mcp.connections.create `url`", 2048);
  const envRefs = optionalEnvRefs(args.envRefs, "mcp.connections.create `envRefs`");
  if (command !== undefined) payload.command = command;
  if (commandArgs !== undefined) payload.args = commandArgs;
  if (url !== undefined) payload.url = url;
  if (envRefs !== undefined) payload.envRefs = envRefs;
  return payload;
}

function connectionUpdatePayload(args: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const enabled = optionalBoolean(args.enabled, "mcp.connections.update `enabled`");
  const exposeToAi = optionalBoolean(args.exposeToAi, "mcp.connections.update `exposeToAi`");
  const command = optionalString(args.command, "mcp.connections.update `command`", 512);
  const commandArgs = optionalStringArray(args.args, "mcp.connections.update `args`", 32, 200);
  const url = optionalString(args.url, "mcp.connections.update `url`", 2048);
  const envRefs = optionalEnvRefs(args.envRefs, "mcp.connections.update `envRefs`");
  if (enabled !== undefined) payload.enabled = enabled;
  if (exposeToAi !== undefined) payload.exposeToAi = exposeToAi;
  if (command !== undefined) payload.command = command;
  if (commandArgs !== undefined) payload.args = commandArgs;
  if (url !== undefined) payload.url = url;
  if (envRefs !== undefined) payload.envRefs = envRefs;
  if (Object.keys(payload).length === 0) {
    throw new Error("mcp.connections.update requires at least one field to update");
  }
  return payload;
}

function mcpToolPatchPayload(args: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const enabled = optionalBoolean(args.enabled, "mcp.connections.set_tool `enabled`");
  const writeSide = optionalBoolean(args.writeSide, "mcp.connections.set_tool `writeSide`");
  const exposeToAi = optionalBoolean(args.exposeToAi, "mcp.connections.set_tool `exposeToAi`");
  if (enabled !== undefined) payload.enabled = enabled;
  if (writeSide !== undefined) payload.writeSide = writeSide;
  if (exposeToAi !== undefined) payload.exposeToAi = exposeToAi;
  if (args.rateLimitPerMin === null) {
    payload.rateLimitPerMin = null;
  } else {
    const rateLimit = optionalInteger(
      args.rateLimitPerMin,
      "mcp.connections.set_tool `rateLimitPerMin`",
      1,
      10_000,
    );
    if (rateLimit !== undefined) payload.rateLimitPerMin = rateLimit;
  }
  if (Object.keys(payload).length === 0) {
    throw new Error("mcp.connections.set_tool requires at least one field to update");
  }
  return payload;
}

function requireMcpAlias(value: unknown, toolName: string): string {
  if (typeof value === "string" && MCP_ALIAS_PATTERN.test(value)) return value;
  throw new Error(`${toolName} requires \`alias\` matching /^[a-z0-9_-]{1,32}$/`);
}

function requireMcpToolName(value: unknown): string {
  if (typeof value === "string") {
    const normalized = value.trim();
    if (normalized.length > 0 && normalized.length <= 512) return normalized;
  }
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
      const limit = optionalInteger(args.limit, "workflows.list `limit`", 1, 200);
      if (limit !== undefined) params.set("limit", String(limit));
      const tags = optionalStringArray(args.tag, "workflows.list `tag`", 20, 40);
      for (const tag of tags ?? []) params.append("tag", tag);
      const folder = optionalString(args.folder, "workflows.list `folder`", 60);
      if (folder !== undefined) params.set("folder", folder);
      const search = optionalString(args.q, "workflows.list `q`", 100);
      if (search !== undefined) params.set("q", search);
      const before = optionalString(args.before, "workflows.list `before`", 512, 3);
      if (before !== undefined) params.set("before", before);
      const query = params.toString();
      const path = v1(V1_READ_PATHS.workflows);
      return callApi(query ? `${path}?${query}` : path);
    }
    case "workflows.get": {
      const workflowId = requireString(args.workflowId, "workflows.get `workflowId`");
      return callApi(`${v1(V1_READ_PATHS.latestWorkflowVersion)}?workflowId=${encodeURIComponent(workflowId)}`);
    }
    case "recipes.list":
      return callApi(v1(V1_READ_PATHS.templates));
    case "tools.list":
      return callApi(v1(V1_READ_PATHS.tools));
    case "memory.consent_status":
      return callApi(v1(V1_READ_PATHS.memoryConsentStatus));
    case "recovery.ledger":
      return callApi(v1(V1_READ_PATHS.recoveryLedger));
    case "recovery.my_wins": {
      const days = optionalInteger(args.days, "recovery.my_wins `days`", 1, 90);
      const path = v1(V1_READ_PATHS.recoveryMyWins);
      return callApi(days === undefined ? path : `${path}?days=${days}`);
    }
    case "recovery.cases.list": {
      const params = new URLSearchParams();
      const openOnly = optionalBoolean(
        args.openOnly,
        "recovery.cases.list `openOnly`",
      );
      if (openOnly !== undefined) params.set("openOnly", String(openOnly));
      const runId = optionalString(
        args.runId,
        "recovery.cases.list `runId`",
        256,
      );
      if (runId !== undefined) params.set("runId", runId);
      const limit = optionalInteger(
        args.limit,
        "recovery.cases.list `limit`",
        1,
        200,
      );
      if (limit !== undefined) params.set("limit", String(limit));
      const query = params.toString();
      const path = v1(V1_READ_PATHS.recoveryCases);
      return callApi(query ? `${path}?${query}` : path);
    }
    case "recovery.cases.get": {
      const caseId = requireString(
        args.caseId,
        "recovery.cases.get `caseId`",
        256,
      );
      return callApi(
        v1(V1_READ_PATHS.recoveryCase)
          .replace("{caseId}", encodeURIComponent(caseId)),
      );
    }
    case "runs.get": {
      const runId = requireString(args.runId, "runs.get `runId`", 256);
      const params = new URLSearchParams({ runId });
      const eventsLimit = optionalInteger(args.eventsLimit, "runs.get `eventsLimit`", 1, 500);
      if (eventsLimit !== undefined) params.set("eventsLimit", String(eventsLimit));
      const eventsCursor = optionalString(args.eventsCursor, "runs.get `eventsCursor`", 512, 3);
      if (eventsCursor !== undefined) params.set("eventsCursor", eventsCursor);
      return callApi(`${v1(V1_READ_PATHS.run)}?${params.toString()}`);
    }
    case "workflows.validate": {
      if (!isObject(args.workflow)) {
        throw new Error("workflows.validate requires `workflow` (object)");
      }
      return callApi(v1(V1_WRITE_PATHS.validateWorkflow), {
        method: "POST",
        body: JSON.stringify(args.workflow),
      });
    }
    case "workflows.versions": {
      const workflowId = requireString(args.workflowId, "workflows.versions `workflowId`");
      return callApi(`${v1(V1_READ_PATHS.workflowVersions)}?workflowId=${encodeURIComponent(workflowId)}`);
    }
    case "workflows.health": {
      const workflowId = requireString(args.workflowId, "workflows.health `workflowId`");
      return callApi(`${v1(V1_READ_PATHS.workflowHealth)}?workflowId=${encodeURIComponent(workflowId)}`);
    }
    case "workflows.readiness": {
      if (!isObject(args.workflow)) {
        throw new Error("workflows.readiness requires `workflow` (object)");
      }
      return callApi(v1(V1_WRITE_PATHS.workflowReadiness), {
        method: "POST",
        body: JSON.stringify(args.workflow),
      });
    }
    case "workflows.schedule_preview": {
      const cron = optionalString(args.cron, "workflows.schedule_preview `cron`", 100);
      if (cron === undefined) {
        throw new Error("workflows.schedule_preview `cron` is required");
      }
      const params = new URLSearchParams({ cron });
      return callApi(`${v1(V1_READ_PATHS.schedulePreview)}?${params.toString()}`);
    }
    case "runs.list": {
      const params = new URLSearchParams();
      const workflowId = optionalString(args.workflowId, "runs.list `workflowId`", 512);
      if (workflowId !== undefined) params.set("workflowId", workflowId);
      const limit = optionalInteger(args.limit, "runs.list `limit`", 1, 200);
      if (limit !== undefined) params.set("limit", String(limit));
      const status = optionalEnum(args.status, "runs.list `status`", runStatusValues);
      if (status !== undefined) params.set("status", status);
      const runKind = optionalEnum(args.runKind, "runs.list `runKind`", RUN_KINDS);
      if (runKind !== undefined) params.set("runKind", runKind);
      const before = optionalString(args.before, "runs.list `before`", 512, 3);
      if (before !== undefined) params.set("before", before);
      const query = params.toString();
      const path = v1(V1_READ_PATHS.runs);
      return callApi(query ? `${path}?${query}` : path);
    }
    case "runs.status": {
      const runId = requireString(args.runId, "runs.status `runId`", 256);
      const params = new URLSearchParams({ runId });
      const eventsLimit = optionalInteger(args.eventsLimit, "runs.status `eventsLimit`", 1, 500);
      if (eventsLimit !== undefined) params.set("eventsLimit", String(eventsLimit));
      return callApi(`${v1(V1_READ_PATHS.runStatus)}?${params.toString()}`);
    }
    case "runs.usage": {
      const runId = requireString(args.runId, "runs.usage `runId`", 256);
      return callApi(`${v1(V1_READ_PATHS.runUsage)}?runId=${encodeURIComponent(runId)}`);
    }
    case "dlq.list": {
      const params = new URLSearchParams();
      const status = optionalEnum(args.status, "dlq.list `status`", DLQ_STATUSES);
      if (status !== undefined) params.set("status", status);
      const severity = optionalEnum(args.severity, "dlq.list `severity`", DLQ_SEVERITIES);
      if (severity !== undefined) params.set("severity", severity);
      const sort = optionalEnum(args.sort, "dlq.list `sort`", DLQ_SORTS);
      if (sort !== undefined) params.set("sort", sort);
      const owner = optionalString(args.owner, "dlq.list `owner`", 200);
      if (owner !== undefined) params.set("owner", owner);
      const search = optionalString(args.search, "dlq.list `search`", 100);
      if (search !== undefined) params.set("search", search);
      const limit = optionalInteger(args.limit, "dlq.list `limit`", 1, 200);
      if (limit !== undefined) params.set("limit", String(limit));
      const query = params.toString();
      const path = v1(V1_READ_PATHS.deadLetters);
      return callApi(query ? `${path}?${query}` : path);
    }
    case "dlq.clusters": {
      const params = new URLSearchParams();
      const windowDays = optionalInteger(args.windowDays, "dlq.clusters `windowDays`", 1, 90);
      if (windowDays !== undefined) params.set("windowDays", String(windowDays));
      const query = params.toString();
      const path = v1(V1_READ_PATHS.failureClusters);
      return callApi(query ? `${path}?${query}` : path);
    }
    case "recovery.metrics": {
      const params = new URLSearchParams();
      const windowDays = optionalInteger(args.windowDays, "recovery.metrics `windowDays`", 1, 90);
      if (windowDays !== undefined) params.set("windowDays", String(windowDays));
      const query = params.toString();
      const path = v1(V1_READ_PATHS.recoveryMetrics);
      return callApi(query ? `${path}?${query}` : path);
    }
    case "reports.run_explain": {
      const runId = requireString(args.runId, "reports.run_explain `runId`", 256);
      const params = new URLSearchParams({ runId, format: "json" });
      return callApi(`${v1(V1_READ_PATHS.runExplainReport)}?${params.toString()}`);
    }
    case "ai.patch_workflow": {
      const deadLetterId = requireString(
        args.deadLetterId,
        "ai.patch_workflow `deadLetterId`",
        256,
      );
      return callApi(v1(V1_WRITE_PATHS.patchWorkflow), {
        method: "POST",
        body: JSON.stringify({ deadLetterId }),
      });
    }
    case "ai.generate_workflow": {
      const prompt = requireString(args.prompt, "ai.generate_workflow `prompt`", 20_000);
      return callApi(v1(V1_WRITE_PATHS.generateWorkflow), {
        method: "POST",
        body: JSON.stringify({ prompt }),
      });
    }
    case "mcp.connections.list":
      return callApi(v1(V1_MCP_PATHS.connections));
    case "mcp.connections.tools": {
      const alias = requireMcpAlias(args.alias, name);
      return callApi(v1(V1_MCP_PATHS.connectionTools)
        .replace("{alias}", encodeURIComponent(alias)));
    }
    case "runs.start": {
      requireWrites(name);
      if (!isObject(args.workflow)) {
        throw new Error("runs.start requires `workflow` (object)");
      }
      const payload: Record<string, unknown> = { workflow: args.workflow };
      if (args.input !== undefined) payload.input = args.input;
      return callApi(v1(V1_WRITE_PATHS.startRun), {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }
    case "runs.resume": {
      requireWrites(name);
      const runId = requireString(args.runId, "runs.resume `runId`", 256);
      const nodeId = requireString(args.nodeId, "runs.resume `nodeId`", 256);
      const payload: Record<string, unknown> = { runId, nodeId };
      if (args.input !== undefined) payload.input = args.input;
      const resumeToken = optionalString(
        args.resumeToken,
        "runs.resume `resumeToken`",
        8192,
      );
      if (resumeToken !== undefined) payload.resumeToken = resumeToken;
      return callApi(v1(V1_WRITE_PATHS.resumeRun), {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }
    case "runs.redrive": {
      requireWrites(name);
      const runId = requireString(args.runId, "runs.redrive `runId`", 256);
      const payload: Record<string, unknown> = { runId };
      const nodeId = optionalString(args.nodeId, "runs.redrive `nodeId`", 256);
      if (nodeId !== undefined) payload.nodeId = nodeId;
      const workflowVersionId = optionalString(
        args.workflowVersionId,
        "runs.redrive `workflowVersionId`",
        256,
      );
      if (workflowVersionId !== undefined) {
        payload.workflowVersionId = workflowVersionId;
      }
      return callApi(v1(V1_WRITE_PATHS.redriveRun), {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }
    case "runs.cancel": {
      requireWrites(name);
      const runId = requireString(args.runId, "runs.cancel `runId`", 256);
      const payload: Record<string, unknown> = { runId };
      const reason = optionalString(args.reason, "runs.cancel `reason`", 1000);
      if (reason !== undefined) payload.reason = reason;
      return callApi(v1(V1_WRITE_PATHS.cancelRun), {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }
    case "dlq.replay": {
      requireWrites(name);
      const deadLetterId = requireString(args.deadLetterId, "dlq.replay `deadLetterId`", 256);
      return callApi(v1(V1_WRITE_PATHS.replayDeadLetter), {
        method: "POST",
        body: JSON.stringify({ deadLetterId }),
      });
    }
    case "recovery.cases.resolve": {
      requireWrites(name);
      const caseId = requireString(
        args.caseId,
        "recovery.cases.resolve `caseId`",
        256,
      );
      const decision = optionalEnum(
        args.decision,
        "recovery.cases.resolve `decision`",
        ["replace", "accept_loss"] as const,
      );
      if (decision === undefined) {
        throw new Error(
          "recovery.cases.resolve `decision` is required",
        );
      }
      const reason = requireString(
        args.reason,
        "recovery.cases.resolve `reason`",
        1000,
      );
      const payload: Record<string, unknown> = { decision, reason };
      if (decision === "replace") {
        if (args.output === undefined) {
          throw new Error(
            "recovery.cases.resolve `output` is required for `replace`",
          );
        }
        payload.output = args.output;
      }
      return callApi(
        v1(V1_WRITE_PATHS.recoverSemanticCase)
          .replace("{caseId}", encodeURIComponent(caseId)),
        {
          method: "POST",
          body: JSON.stringify(payload),
        },
      );
    }
    case "workflows.rollback": {
      requireWrites(name);
      const workflowId = requireString(args.workflowId, "workflows.rollback `workflowId`");
      const sourceVersionId = requireString(
        args.sourceVersionId,
        "workflows.rollback `sourceVersionId`",
      );
      return callApi(v1(V1_WRITE_PATHS.rollbackWorkflow), {
        method: "POST",
        body: JSON.stringify({ workflowId, sourceVersionId }),
      });
    }
    case "workflows.resume": {
      requireWrites(name);
      const workflowId = requireString(
        args.workflowId,
        "workflows.resume `workflowId`",
      );
      return callApi(
        v1(V1_WRITE_PATHS.resumeWorkflow)
          .replace("{workflowId}", encodeURIComponent(workflowId)),
        { method: "POST", body: "{}" },
      );
    }
    case "mcp.connections.create": {
      requireWrites(name);
      return callApi(v1(V1_MCP_PATHS.connections), {
        method: "POST",
        body: JSON.stringify(connectionCreatePayload(args)),
      });
    }
    case "mcp.connections.update": {
      requireWrites(name);
      const alias = requireMcpAlias(args.alias, name);
      const patch = connectionUpdatePayload(args);
      return callApi(
        v1(V1_MCP_PATHS.connection).replace("{alias}", encodeURIComponent(alias)),
        { method: "POST", body: JSON.stringify(patch) },
      );
    }
    case "mcp.connections.rediscover": {
      requireWrites(name);
      const alias = requireMcpAlias(args.alias, name);
      return callApi(v1(V1_MCP_PATHS.rediscoverConnection)
        .replace("{alias}", encodeURIComponent(alias)), {
        method: "POST",
        body: "{}",
      });
    }
    case "mcp.connections.set_tool": {
      requireWrites(name);
      const alias = requireMcpAlias(args.alias, name);
      const toolName = requireMcpToolName(args.toolName);
      const patch = mcpToolPatchPayload(args);
      return callApi(
        v1(V1_MCP_PATHS.connectionTool)
          .replace("{alias}", encodeURIComponent(alias))
          .replace("{toolName}", encodeURIComponent(toolName)),
        { method: "POST", body: JSON.stringify(patch) },
      );
    }
    case "mcp.connections.delete": {
      requireWrites(name);
      const alias = requireMcpAlias(args.alias, name);
      return callApi(
        v1(V1_MCP_PATHS.connection).replace("{alias}", encodeURIComponent(alias)),
        { method: "DELETE" },
      );
    }
    case "workflows.save": {
      requireWrites(name);
      if (!isObject(args.workflow)) {
        throw new Error("workflows.save requires `workflow` (object)");
      }
      const dryRun = optionalBoolean(args.dryRun, "workflows.save `dryRun`");
      if (dryRun === true) {
        const validation = await callApi(v1(V1_WRITE_PATHS.validateWorkflow), {
          method: "POST",
          body: JSON.stringify(args.workflow),
        });
        return {
          mode: "dry-run",
          ...(isObject(validation) ? validation : { validation }),
        };
      }
      return callApi(v1(V1_WRITE_PATHS.saveWorkflow), {
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
