/** Descriptors advertised only after the process-wide MCP write opt-in. */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export const WRITE_TOOLS: Tool[] = [
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
