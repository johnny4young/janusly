/** Always-visible inspection, validation, AI, and recovery descriptors. */

import { runStatusValues } from "@janusly/shared/src/status";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const RUN_KINDS = ["production", "validation"] as const;

export const ALWAYS_VISIBLE_TOOLS: Tool[] = [
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
