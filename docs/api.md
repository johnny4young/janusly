# HTTP API Reference

Base URL: `http://localhost:3001`. Every request must carry an auth context. In
dev, send `x-org-id` and `x-user-id` headers. In production, send a provider
token (`Authorization: Bearer <jwt>` for Supabase or service-token mode, or
`x-janusly-session` for Janusly SSO) plus `x-org-id` when the user has more
than one membership. The org header is a scope selector; authorization is
granted by the server-side `org_members` row, not by a client-side claim.

CORS allowed origins come from `API_ALLOWED_ORIGINS` (default: `http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174`). The `5174` ports are included so dev still works when Vite falls back from `5173` due to a port collision. Body limit defaults to 1 MiB (`API_MAX_JSON_BODY_BYTES`).

All examples below assume the dev-headers shorthand `-H "x-org-id: default" -H "x-user-id: dev-user"`.

This file gives worked examples for the stable public HTTP surface. The
authoritative route registry is the composed `routes: Route[]` in
[`apps/api/src/index.ts`](../apps/api/src/index.ts); it is first-match-wins, so
more-specific prefixes such as `/runs/:id/stream`, `/dlq/clusters`, and
`/workflows/health/delta` must remain registered before their broader siblings.

Current route families. The worked examples below expand the common workflow,
run, AI, recovery, credential, SDK, and report paths; the quick index keeps the
rest of the registry discoverable without duplicating every handler body.

| Family | Routes | Purpose |
| --- | --- | --- |
| Org config / roles / permissions | `/org/config`, `/org/permissions/catalog`, `/org/roles*` | Tenant runtime config, permission catalog, custom roles. |
| Enterprise identity | `/org/sso/connections*`, `/auth/sso/start`, `/auth/sso/callback`, `/org/scim/directories*`, `/webhooks/workos/directory` | WorkOS SSO + SCIM admin and webhook surfaces. |
| MCP client admin | `/mcp/connections*`, `/mcp/connections/:alias/tools*` | Register external MCP servers, rediscover descriptors, enable tools, rate-limit tools, expose selected descriptors to AI. |
| Recovery operations | `/recovery/items*`, `/recovery/items/:id/handoff`, `/auto-healing*`, `/alerts/*` | Recovery Center item workflow, cross-team handoff, supervised auto-healing queue, alert policies. |
| PromptOps / evals / experiments | `/prompts*`, `/eval/datasets*`, `/experiments*` | Versioned prompt registry, opted-in eval datasets, experiment runs and readouts. |
| Triggers and snippets | `/triggers/*/ingest`, `/triggers/events*`, `/snippets*`, `/onboarding` | External event ingestion, replay, reusable workflow snippets, onboarding state. |
| Solution packs and reports | `/solution-packs*`, `/workflows/import-pack`, `/reports/run-explain*`, `/reports/value-dashboard` | Demo/import packs, run explain exports/delivery, value dashboard exports. |
| Upstream health / metadata | `/upstream/sources*`, `/workflows/:id/metadata` | Source-health checks and workflow metadata overlays. |

## Route Registry Quick Index

Access below is the route-declared gate in `routes: Route[]`. When both a role
and permission are listed, both must pass. Routes without an explicit role are
still authenticated unless marked `public`; if they declare only `permission:`,
that permission is the authorization gate.

| Surface | Endpoint(s) | Access | Notes |
| --- | --- | --- | --- |
| Health | `GET /health` | public | Liveness plus additive public rate-limiter degradation snapshot. |
| Rate limiter admin | `GET /system/rate-limiter` | admin | Process-local Redis limiter degradation details. |
| Tools/templates/plugins | `GET /tools`, `GET /templates`, `GET /plugins`, `POST /plugins/install` | authenticated / admin install | Tool registry, static workflow templates, installed-plugin catalog. |
| Org config | `GET /org/config`, `POST /org/config` | viewer / admin + `org.config.write` | Closed-catalog tenant runtime overrides; secret material stays in env/vault-backed credentials. |
| Permissions/roles | `GET /org/permissions/catalog`, `GET /org/roles`, `POST /org/roles`, `POST /org/roles/:name`, `DELETE /org/roles/:name` | viewer / admin + `org.permissions.write` | Built-in role overrides, custom roles, admin-floor coercion, role-in-use delete guard. |
| Members/invites | `GET /members`, `GET /members/invitations`, `POST /members/invite`, `POST /members/invitations/:id/revoke`, `POST /members/role`, `DELETE /members?userId=` | viewer/admin + member perms | Org membership and invitation lifecycle, including custom role names. |
| SSO | `GET /org/sso/connections`, `POST /org/sso/connections`, `POST /org/sso/connections/:id`, `DELETE /org/sso/connections/:id`, `GET /auth/sso/start`, `GET /auth/sso/callback` | admin for CRUD; public for flow | WorkOS connection CRUD plus HMAC state/nonce SSO redirect flow. |
| SCIM | `GET /org/scim/directories`, `POST /org/scim/directories`, `POST /org/scim/directories/:id`, `DELETE /org/scim/directories/:id`, `POST /webhooks/workos/directory` | viewer/admin; webhook public with WorkOS HMAC | Directory Sync attach/update/revoke and fail-closed webhook receiver. |
| MCP client | `GET /mcp/connections`, `POST /mcp/connections`, `POST /mcp/connections/:alias`, `DELETE /mcp/connections/:alias`, `POST /mcp/connections/:alias/rediscover`, `GET /mcp/connections/:alias/tools`, `POST /mcp/connections/:alias/tools/:toolName` | viewer/admin + `mcp.connections.*` | External MCP server registry, descriptor discovery, tool enable/write/rate/expose flags. |
| Workflow CRUD/readiness | `GET /workflows`, `POST /workflows/save`, `GET /workflows/versions`, `GET /workflows/latest`, `DELETE /workflows/:id`, `POST /validate`, `POST /workflows/readiness` | viewer/editor | Structural validation plus production-readiness checks. |
| Workflow operations | `POST /workflows/rollback`, `POST /workflows/:id/slo`, `GET /workflows/:id/schedule-history`, `GET /workflows/health`, `GET /workflows/health/delta`, `GET /workflows/:id/metadata`, `POST /workflows/:id/metadata`, `GET /billing/budget`, `POST /workflows/:id/budget` | viewer/editor/admin by route | Rollback, SLO, schedule observability, health scoring, metadata, and cost-budget overrides. |
| Runs | `POST /start`, `GET /runs`, `GET /run`, `GET /status`, `GET /runs/:id/stream`, `POST /resume`, `POST /run/cancel`, `POST /runs/replay-lab`, `POST /runs/replay-lab/fork`, `GET /runs/compare`, `GET /causal` | viewer/editor + run perms | Start, poll, stream, resume, cancel, sandbox replay, fork, compare, and router explainability. |
| Credentials | `GET /credentials`, `GET /credentials/health`, `POST /credentials`, `POST /credentials/:name/bulk-update` | viewer/admin + credential perms | Operator-facing credential rows; health and rotation never echo `secretRef`. |
| AI helpers | `GET /ai/health`, `POST /ai/generate-workflow`, `POST /ai/explain-workflow`, `POST /ai/review-workflow`, `POST /ai/patch-workflow`, `POST /ai/suggest-improvement`, `POST /ai/explain-run` | authenticated; editor where mutating | Provider-neutral LLM surfaces with deterministic fallback/audit contracts. |
| DLQ/recovery loop | `GET /dlq`, `GET /dlq/clusters`, `GET /dlq/cluster-members`, `POST /dlq/resolve`, `POST /dlq/validate-fix`, `POST /dlq/cluster-apply`, `POST /dlq/replay`, `GET /recovery/metrics`, `POST /recovery/feedback` | viewer/editor + DLQ perms | Dead-letter triage, validation sandbox, clustered replay, metrics, and feedback. |
| Recovery items | `GET /recovery/items`, `GET /recovery/items/:id`, `GET /recovery/items/:id/children`, `POST /recovery/items/:id/acknowledge`, `POST /recovery/items/:id/in-progress`, `POST /recovery/items/:id/waiting-external`, `POST /recovery/items/:id/escalate`, `POST /recovery/items/:id/assign`, `POST /recovery/items/:id/resolve`, `POST /recovery/items/:id/reopen`, `POST /recovery/items/:id/comment`, `POST /recovery/items/:id/evidence`, `POST /recovery/items/:id/handoff` | viewer/editor + recovery perms | Incident workflow, evidence export, and cross-team handoff. |
| Auto-healing/alerts | `GET /auto-healing/pending`, `GET /auto-healing/:id`, `POST /auto-healing/:id/decide`, `POST /auto-healing/scan`, `GET /alerts/policies`, `POST /alerts/policies`, `POST /alerts/policies/:id`, `DELETE /alerts/policies/:id`, `GET /alerts/recent` | viewer/editor/admin + feature perms | Supervised repair decisions, on-demand scan, alert policies, recent dispatch feed. |
| PromptOps/evals | `GET /prompts`, `POST /prompts`, `GET /prompts/:name`, `GET /prompts/:name/versions/:version`, `POST /prompts/:name/versions`, `POST /prompts/:name/versions/:version/pin`, `GET /eval/datasets`, `POST /eval/datasets`, `GET /eval/datasets/:id`, `GET /eval/datasets/:id/export?format=jsonl|json`, `DELETE /eval/datasets/:id`, `GET /experiments`, `POST /experiments/run`, `GET /experiments/:id` | viewer/editor/admin + prompt/eval perms | Versioned prompt registry, opted-in eval datasets, synchronous model/prompt experiments. |
| Triggers/snippets/onboarding | `POST /triggers/<kind>/ingest`, `POST /triggers/email/ingest`, `POST /triggers/file/ingest`, `POST /triggers/mcp/ingest`, `POST /triggers/events/:id/replay`, `GET /triggers/events`, `GET /snippets`, `POST /snippets`, `POST /snippets/:id`, `DELETE /snippets/:id`, `POST /snippets/:id/inserted`, `GET /onboarding`, `POST /onboarding` | viewer/editor/admin + feature perms | Event ingestion/replay, reusable snippet library, first-recovered-run checklist. |
| Solution packs/reports | `GET /solution-packs`, `GET /solution-packs/:id`, `POST /workflows/import-pack`, `POST /solution-packs/:id/sample-run`, `POST /solution-packs/:id/inject-failure`, `GET /reports/run-explain`, `POST /reports/run-explain/deliver`, `GET /reports/value-dashboard` | viewer/editor + pack/report perms | Code-resident packs, sample/failure demos, report export/delivery, value dashboard. |
| Upstream health | `GET /upstream/sources`, `POST /upstream/sources`, `POST /upstream/sources/:id`, `DELETE /upstream/sources/:id`, `POST /upstream/sources/:id/check` | viewer/admin + upstream perms | Source config and immediate check-now poll; worker owns background polling. |

---

## Health

### `GET /health`

Liveness probe. No auth needed.

**Response 200**
```json
{ "ok": true }
```

### `GET /system/rate-limiter`

Admin-only diagnostic for Redis-backed rate limiter degradation state. Exposes
current in-process degraded buckets and recent recovery markers; use it for
operator checks, not for end-user UI polling.

---

## Tool catalog

### `GET /tools`

Lists tools registered in the engine. Used by the workflow builder and by agents to plan.

**Response 200**
```json
[
  {
    "name": "http.request",
    "description": "Make an HTTP request to an external API.",
    "required": ["url"],
    "optional": ["method", "headers", "body"],
    "inputExample": { "url": "https://example.com", "method": "GET" }
  },
  {
    "name": "text.uppercase",
    "description": "Convert text to uppercase.",
    "required": ["value"],
    "inputExample": { "value": "hello" }
  },
  {
    "name": "json.pick",
    "description": "Pick a value from workflow context using a dot path.",
    "required": ["path"],
    "optional": ["source"],
    "inputExample": { "path": "1.output.statusCode" }
  }
]
```

### `GET /templates`

Returns the curated workflow templates shipped with the API.

**Response 200**
```json
[
  {
    "id": "http-ai-summary",
    "name": "HTTP → AI Summary",
    "description": "Call an API and summarize the response with an AI/agent step.",
    "category": "AI",
    "workflow": { "id": "http-ai-summary", "nodes": [...], "edges": [...] }
  }
]
```

---

## Solution Packs

Solution packs are code-resident, installable workflow starters from
`packages/solution-packs`. They are broader than templates: each pack includes
workflow JSON, required credential/org-config hints, sample payloads, failure
fixtures, and a README. Installing a pack copies the workflow into the caller's
org; it never creates credentials or exposes `secretRef` values.

### `GET /solution-packs`

Returns the public catalog. Requires `packs.read`.

```json
{
  "packs": [
    {
      "id": "incident-triage",
      "name": "Incident triage",
      "version": "1.0.0",
      "requiredCredentials": [{ "name": "ops_slack", "kind": "slack_webhook", "purpose": "Pages your on-call channel" }],
      "nodeCount": 4,
      "samplePayloadIds": ["default"],
      "failureFixtureIds": ["slack_5xx_transient"]
    }
  ]
}
```

### `GET /solution-packs/:id`

Returns one public pack plus per-org missing dependency hints. Requires
`packs.read`.

```json
{
  "pack": { "id": "incident-triage", "name": "Incident triage" },
  "missingCredentials": [{ "name": "ops_slack", "kind": "slack_webhook", "purpose": "Pages your on-call channel" }],
  "missingOrgConfigs": []
}
```

### `POST /workflows/import-pack`

Installs a pack as a draft workflow using the same validation/save path as
`POST /workflows/save`. Requires `packs.install`.

```json
{ "packId": "incident-triage", "name": "Incident triage - Acme" }
```

Returns the new workflow/version ids plus `missingCredentials` /
`missingOrgConfigs`.

### `POST /solution-packs/:id/sample-run`

Starts a writes-skipped sandbox sample using a bundled sample payload. Requires
`packs.install`.

```json
{ "samplePayloadId": "default" }
```

### `POST /solution-packs/:id/inject-failure`

Seeds a demo failed run + DLQ row using a bundled failure fixture. Requires
`packs.install`.

```json
{ "fixtureId": "slack_5xx_transient" }
```

---

## Workflow CRUD

### `GET /workflows`

List the org's workflows, newest first.

**Response 200**
```json
[
  { "id": "etl-daily", "orgId": "default", "name": "Daily ETL", "createdBy": "dev-user", "createdAt": "2026-04-26T02:00:00.000Z" }
]
```

### `POST /workflows/save`

Validates the DAG, then either creates a new workflow + version 1 or appends a new version to an existing workflow id. Updates the workflow `name` if it changed. Requires `editor` role.

**Request**
```json
{
  "id": "etl-daily",
  "name": "Daily ETL",
  "nodes": [
    { "id": "fetch", "type": "http", "config": { "url": "https://api.example.com/orders" } },
    { "id": "shape", "type": "transform", "config": { "mapping": { "count": "{{context.fetch.output.statusCode}}" } } }
  ],
  "edges": [{ "from": "fetch", "to": "shape" }]
}
```

**Response 200**
```json
{ "workflowId": "etl-daily", "versionId": "1fb4e7b0-ab69-456a-9b91-d6e960b7135f", "version": 3 }
```

**Response 400** (invalid DAG)
```json
{
  "error": "Validation failed",
  "issues": [
    { "code": "http_missing_url", "message": "HTTP node requires config.url", "nodeId": "fetch" }
  ]
}
```

### `GET /workflows/versions?workflowId=etl-daily`

Returns all versions of a workflow (newest first).

**Response 200**
```json
[
  { "id": "...", "workflowId": "etl-daily", "version": 3, "dagJson": { "id": "etl-daily", "nodes": [...], "edges": [...] }, "createdAt": "..." }
]
```

### `GET /workflows/latest?workflowId=etl-daily`

Returns the most recent version, or `null` if none exists.

### `DELETE /workflows/:id`

Hard-deletes the workflow and every saved version for the caller's org. Requires `editor` role. Cron-driven `schedule` entries and their BullMQ schedulers are removed before the workflow rows are deleted. Historical runs and audit rows keep their orphaned `workflow_version_id` text references.

**Response 200**
```json
{ "workflowId": "etl-daily", "ok": true }
```

**Response 404**
```json
{ "error": "Workflow not found" }
```

---

## Validate

### `POST /validate`

Stateless DAG validation. Requires `editor` role. This is the structural
validator used before save/start paths; production-readiness checks live in
`POST /workflows/readiness`.

**Request**
```json
{ "nodes": [{ "id": "x", "type": "http", "config": {} }], "edges": [] }
```

**Response 200 (invalid)**
```json
{
  "valid": false,
  "issues": [{ "code": "http_missing_url", "message": "HTTP node requires config.url", "nodeId": "x" }]
}
```

Common issue codes:

| code | meaning |
| --- | --- |
| `invalid_contract` | Zod schema rejected the shape |
| `empty_workflow` | `nodes` array is empty |
| `duplicate_node_id` | Two nodes share an id |
| `unsupported_node_type` | Node `type` not in registry |
| `http_missing_url` | `http` node without `config.url` |
| `tool_missing_name` | `tool` node without `config.tool` |
| `tool_invalid_input` | Tool input misses required fields |
| `condition_missing_expression` | `condition` without `config.expression` |
| `condition_invalid_expression` | Sandbox rejected the expression |
| `loop_missing_items` | `loop` without `config.items` |
| `ai_missing_prompt` | `ai` node without `config.prompt` |
| `agent_missing_goal` | `agent` node without `config.goal` |
| `transform_missing_mapping` | `transform` node without a non-empty `config.mapping` object |
| `multi_agent_missing_agents` | `multi_agent.config.agents` is empty |
| `human_form_invalid_schema` | `human_form.config.schema` is missing or outside the supported JSON-schema subset |
| `human_form_empty_schema` | `human_form.config.schema.properties` is empty |
| `wait_until_missing_duration` / `wait_until_invalid_duration` / `wait_until_non_positive_duration` | `wait_until.config.duration` is absent or not a positive ISO 8601 duration |
| `parallel_fork_invalid_branches` | `parallel_fork.config.branches` is malformed |
| `join_invalid_sources` | `join.config.sources` is malformed |
| `schedule_invalid_cron` | `schedule.config.cronExpression` is malformed |
| `trigger_invalid_config` | `email_received`, `file_dropped`, or `mcp_server_event` config failed its trigger schema |
| `router_missing_candidates` / `router_invalid_candidate` | `router` / `router_llm` candidates are absent or not objects |
| `router_candidate_missing_node_id` / `router_candidate_unknown_node_id` | A router candidate lacks a target id or points at an unknown node |
| `edge_invalid_from` / `edge_invalid_to` | Edge references unknown node id |
| `edge_invalid_condition` | Edge condition expression invalid |
| `cycle_detected` | DAG has a cycle |
| `missing_start_node` | Every node has incoming edges |

---

## Runs

### `POST /start`

Validates and starts a run. Requires `editor` role. The body can be either a
flat workflow JSON (legacy callers) or `{ "workflow": <DAG>, "input": {...} }`
when the workflow declares typed inputs. `forceRunDuringPause: true` explicitly
overrides an upstream-health pause and is audited. When
`JANUSLY_PRODUCTION_MODE=true`, the route also runs the readiness gate and
returns `422` when fail-level readiness issues remain.

**Request** (any valid workflow shape)
```json
{
  "id": "etl-daily",
  "nodes": [{ "id": "n", "type": "noop", "config": {} }],
  "edges": []
}
```

**Response 200**
```json
{ "runId": "12aff2ba-300f-41f1-8918-72b2489dd661" }
```

### `GET /runs`

List the org's runs, newest first. Supports `?limit=` capped at 200 and
`?workflowId=` to filter through `workflow_versions` while preserving org
scope. Rows are summary projections — `inputJson` (the per-run workflow
snapshot) is intentionally omitted from list responses; use `GET /run`
for the full row.

### `GET /run?runId=<uuid>`

Returns the run, all of its nodes, and one paginated event page. Use this for
"open run" detail screens. Event pagination uses `?eventsLimit=` (default
200, max 500) plus `?eventsCursor=<iso>|<eventId>` for older pages. The page is
returned in chronological order even though the DB query reads newest-first.

**Response 200**
```json
{
  "run": {
    "id": "12aff2ba-...",
    "orgId": "default",
    "workflowVersionId": "etl-daily",
    "status": "succeeded",
    "inputJson": { "workflow": {...}, "input": {} },
    "createdBy": "dev-user",
    "createdAt": "2026-04-26T02:38:42.079Z"
  },
  "nodes": [
    {
      "id": "...",
      "runId": "12aff2ba-...",
      "nodeId": "n",
      "status": "succeeded",
      "stateJson": { "output": {} },
      "attempts": 0,
      "startedAt": "...",
      "finishedAt": "..."
    }
  ],
  "events": [
    { "id": "...", "runId": "12aff2ba-...", "nodeId": null, "type": "run.started", "payload": { "workflowVersionId": "etl-daily" }, "createdAt": "..." }
  ],
  "eventsCursor": "2026-04-26T02:38:42.079Z|evt_123",
  "eventsHasMore": true
}
```

Run statuses: `created`, `running`, `waiting`, `succeeded`, `failed`, `cancelled`, `timed_out`.
Node statuses: `pending`, `queued`, `running`, `waiting`, `succeeded`, `failed`, `skipped`, `cancelled`.

### `GET /status?runId=<uuid>`

Same shape as `/run` (run + nodes + latest event page). Supports
`?eventsLimit=` with the same 200/500 default/max, but does not consume
`eventsCursor`; the UI polls this for fresh state and uses `GET /run` to load
older event pages.

### `GET /runs/:runId/stream`

Server-sent events stream for live run updates. The initial timeline should
come from `GET /run?runId=...`; the stream carries live signals and, on
reconnect, uses `Last-Event-ID` to replay a bounded gap. The route verifies the
run's `orgId` before joining the Redis pub/sub stream.

```
retry: 3000

event: run_event
id: evt_123
data: {"id":"evt_123","type":"node.queued",...}

event: run_event
id: evt_124
data: {"id":"evt_124","type":"node.succeeded",...}
```

### `POST /run/cancel`

Cancels a non-terminal run. Requires `editor` role plus `runs.cancel`
permission. The engine marks the run and non-running nodes as `cancelled`; an
already-running worker job may still finish, but the run rollup preserves the
cancelled terminal state.

```json
{ "runId": "12aff2ba-...", "reason": "operator cancelled from UI" }
```

```json
{ "runId": "12aff2ba-...", "status": "cancelled" }
```

### `POST /runs/replay-lab`

Starts a writes-skipped sandbox validation run from any source run. Requires
`editor` role. The workflow snapshot is resolved from, in order:
caller-supplied `suggestedWorkflow`, the saved `workflow_versions.dagJson`, then
the ad-hoc `runs.inputJson.workflow` fallback. Source runs are org-scoped and
nested replay-lab runs are rejected.

```json
{ "sourceRunId": "run-prod-1", "suggestedWorkflow": { "...": "optional DAG patch" } }
```

```json
{ "runId": "run-lab-1" }
```

### `POST /runs/replay-lab/fork`

Starts a targeted writes-skipped replay beginning at one node. Requires
`editor` role. Predecessors of `forkNodeId` are cloned from the source run only
when they succeeded, so the forked node can read upstream outputs without
re-running earlier HTTP/AI/tool work. `inputOverride` is optional and capped at
64 KiB.

```json
{ "sourceRunId": "run-prod-1", "forkNodeId": "shape", "inputOverride": { "ticketId": "T-42" } }
```

```json
{ "runId": "run-lab-fork-1", "predecessorCount": 2 }
```

### `GET /runs/compare?baseRunId=<uuid>&replayRunId=<uuid>`

Returns the per-node comparison bundle consumed by Replay Lab. Requires
`viewer` role. Both runs are org-scoped; missing or cross-org ids return the
same 404 envelope to avoid enumeration.

### `GET /causal?runId=<uuid>&nodeId=<nodeId>`

Replays a recorded router decision for explainability. The route finds the
`decision.made` event for the given node, re-runs the deterministic causal
replay helper over the recorded candidate bundle, and returns the chosen route
analysis. Cross-org or missing runs return `403`; missing decision events
return `404`.

### `POST /resume`

Resumes a run that's `waiting` on an `approval`, `webhook`, or `human_form` node. Requires `editor` role.

**Request**
```json
{
  "runId": "12aff2ba-...",
  "nodeId": "human_form_1",
  "input": { "approved": true },
  "resumeToken": "engine-signed-human-form-token"
}
```

`input` is captured as the resumed node output for `webhook` and
`human_form` nodes. `resumeToken` is required for `human_form` and optional
for `webhook` / `approval` nodes.

**Response 200**
```json
{ "resumed": true }
```

---

## Members

All write operations require `admin` role.

### `GET /members`

```json
[
  { "id": "...", "orgId": "default", "userId": "alice@example.com", "email": "alice@example.com", "role": "editor", "invitedBy": "dev-user", "createdAt": "..." }
]
```

### `POST /members/invite`

```json
{ "email": "alice@example.com", "role": "editor" }
```

Returns `409 Conflict` if the user already belongs to the org.

### `POST /members/role`

```json
{ "userId": "alice@example.com", "role": "admin" }
```

### `DELETE /members?userId=alice@example.com`

```json
{ "ok": true }
```

---

## Credentials & Plugins

### `GET /credentials` / `GET /credentials/health` / `POST /credentials`

Credentials are operator-managed name/kind rows that point at an environment variable name (`secretRef`). `GET /credentials` intentionally omits `secretRef`; use `GET /credentials/health` for a safe `secretRefPresent` boolean and referencing workflow ids. Requires `admin` for writes.

```json
{ "name": "incidents-slack", "kind": "slack_webhook", "secretRef": "INCIDENTS_SLACK_WEBHOOK_URL" }
```

Integration tools reference credentials by operator-facing name, for example:

```json
{
  "type": "tool",
  "config": {
    "tool": "slack.post",
    "input": { "credential": "incidents-slack", "text": "Incident detected." }
  }
}
```

Direct `http` nodes do not dereference `credentials` rows. They can use supported env-backed templates such as `{{secret.SLACK_BOT_TOKEN}}` or `{{env.SLACK_BOT_TOKEN}}` in headers.

### `GET /plugins`

```json
{ "available": [...tool schemas...], "installed": [...installed plugins...] }
```

### `POST /plugins/install`

```json
{ "pluginId": "http.request", "config": {} }
```

---

## AI helpers

### `GET /ai/health`

Returns the effective tenant AI status without exposing credentials:

```json
{ "enabled": true, "provider": "anthropic", "model": "claude-haiku-4-5-20251001", "generationMode": "free_json", "timeoutMs": 30000, "maxRetries": 2 }
```

### `POST /ai/generate-workflow`

Generates a workflow JSON from a natural-language prompt. In the supported MVP
setup this uses Anthropic through `JANUSLY_LLM_PROVIDER=anthropic`; other
completion providers remain unverified until they pass the eval harness. The
default `free_json` mode asks the model for JSON text, parses it through the
same 11-type generation envelope used by legacy `constrained` mode, promotes
supported noop placeholders, then runs `sanitizeAiWorkflow`. If the draft is
shape-valid but graph-invalid, the route runs up to two targeted
`repairGeneratedWorkflow` attempts before deterministic fallback.

AI-mode responses include provider metadata. Fallback responses always include
`mode: "fallback"`; `aiError` is present only when an LLM call was attempted
and degraded. When no provider key is configured, the route returns the
deterministic template without `aiError` so local evals can skip AI-required
cases cleanly. The `ai.workflow.generated` audit row records
`generationMode`, `generationAttempts`, `repairAttempts`, and noop-promotion
counts; those are observability metadata, not response fields.

**Request**
```json
{ "prompt": "Fetch GitHub trending repos and uppercase the names." }
```

**Response 200 (AI mode)**
```json
{ "mode": "ai", "model": "claude-haiku-4-5-20251001", "provider": "anthropic", "id": "...", "nodes": [...], "edges": [...] }
```

**Response 200 (fallback mode)**
```json
{ "mode": "fallback", "aiError": "AI request failed", "id": "http-ai-summary", "nodes": [...], "edges": [...] }
```

### `POST /ai/explain-workflow`

```json
{ "workflow": { ...DAG... } }
```

```json
{ "explanation": "This workflow fetches data and ..." }
```

### `POST /ai/review-workflow`

AI semantic readiness pass that complements the deterministic readiness gate (`POST /workflows/readiness`). The LLM looks for ambiguous prompts, raw secrets in node config, missing approvals upstream of write-side actions, and ambiguous tool inputs — every finding carries `severity: "info" | "warn" | "fail"`, `code`, `message`, `nodeId`, `rationale`, `suggestion`. AI mode and the deterministic findings are merged at the route layer. Falls back gracefully without a provider key.

### `POST /ai/explain-run`

```json
{ "runId": "...", "question": "Why did this fail?" }
```

```json
{ "mode": "ai", "answer": "...", "model": "claude-haiku-4-5-20251001", "provider": "anthropic" }
```

### `POST /ai/suggest-improvement`

Suggests 1-3 whole-workflow improvements outside the DLQ flow: retries,
timeout/bounds changes, secret-reference swaps, approval gates,
observability additions, or simplification. Returns the original workflow
unchanged with `approachLabel: "other"` and `confidence: 0` when the model is
unavailable or no useful improvement is justified.

```json
{ "workflow": { "...": "DAG" }, "focus": "add retries and remove hardcoded secrets" }
```

```json
{
  "mode": "ai",
  "suggestions": [
    {
      "workflow": { "...": "improved DAG" },
      "rationale": "Added retries to the external HTTP call.",
      "approachLabel": "add_retry",
      "confidence": 82
    }
  ]
}
```

---

## Failure recovery loop

These routes power the Recovery dialog, the Failure Clusters card, and the Operations recovery metrics. The deterministic surfaces (validate-fix, cluster-apply, rollback, clusters, metrics, health) are always available; only `/ai/patch-workflow` requires a provider key. See [`docs/ai.md`](ai.md) §1b for the full feature matrix.

### `POST /ai/patch-workflow`

```json
{ "deadLetterId": "<uuid>" }
```

Returns 1–3 alternative config patches for the failing node, sorted by self-rated `confidence` desc:

```json
{
  "mode": "ai",
  "suggestedWorkflow": { "...mirrors suggestions[0].workflow for back-compat..." },
  "rationale": "...mirrors suggestions[0].rationale for back-compat...",
  "suggestions": [
    {
      "workflow": { "...full DAG with the failing node patched..." },
      "rationale": "Added retry to handle transient ECONNRESET.",
      "approachLabel": "add_retry",
      "confidence": 85
    }
  ],
  "model": "claude-haiku-4-5-20251001",
  "provider": "anthropic"
}
```

`approachLabel` enum: `add_retry` / `raise_timeout` / `swap_secret_ref` / `add_approval` / `fix_url` / `other`. Audited as `ai.workflow.patch_suggested` with `suggestionsCount` + `topApproachLabel` + `envelopeKind` metadata.

For `headers` (HTTP nodes) and `input` (tool nodes), the LLM emits a bounded `Array<{ name, value }>` patch shape — non-null `value` sets/replaces the key, `null` removes it. The merge layer folds the patch against the failing node's existing record before shallow-merging the rest. Example header swap:

```json
{
  "patchedConfig": {
    "headers": [{ "name": "Authorization", "value": "Bearer {{secret.GITHUB_TOKEN}}" }],
    "url": null,
    "method": null,
    "retry": null,
    "timeoutMs": null,
    "maxResponseBytes": null,
    "maxRedirects": null
  },
  "approachLabel": "swap_secret_ref",
  "confidence": 90,
  "rationale": "Swap the literal Bearer token to a secret-template reference."
}
```

### `POST /dlq/validate-fix`

```json
{ "deadLetterId": "<uuid>", "suggestedWorkflow": { "...DAG..." } }
```

Replays the proposed patch in a writes-skipped sandbox run. Returns `{ "runId": "<uuid>" }`. Poll `GET /run?runId=<uuid>` until terminal — `succeeded` gates the production save+replay chain; `failed` / `cancelled` surfaces the failed node's `errorJson` so the operator can iterate.

### `GET /dlq/clusters?windowDays=30`

Failure-cluster rollup grouped by normalized error signature. Used by the Failure Clusters card.

### `GET /dlq/cluster-members?signature=...&windowDays=30&limit=100`

DLQ ids whose normalized signature matches `signature`. Capped at 100 by default. Used by the Recovery dialog when entering cluster mode.

### `POST /dlq/cluster-apply`

```json
{ "clusterSignature": "...", "deadLetterIds": ["<uuid>", "..."] }
```

Bulk replay across the cluster. Re-validates each row's signature server-side before replaying, runs in series, marks accepted rows replayed, and writes one `recovery.cluster_apply` audit row per accepted row. Returns `{ "replayed": N, "failed": M, "errors": [{ "deadLetterId", "error" }] }`.

### `POST /workflows/rollback`

```json
{ "workflowId": "<id>", "sourceVersionId": "<uuid>" }
```

Saves the source version's `dagJson` as a new latest in a single transaction. Returns `{ "workflowId", "versionId", "version", "sourceVersion" }`. Audited as `workflow.rolled_back` with `{ sourceVersionId, sourceVersion, newVersion }`. Returns `404` with the same message for cross-org / wrong-workflow / missing source — no enumeration leak.

### `GET /workflows/health?workflowId=<id>`

Per-workflow 0–100 score with six per-category sub-scores (reliability, safety, cost, latency, maintainability, AI risk). Status thresholds: `≥80 healthy / ≥60 warn / <60 unhealthy`. New workflows (`totalRuns < 5`) return a neutral default 80 so an untested workflow isn't graded as unhealthy.

### `GET /workflows/health/delta?workflowId=<id>&afterVersion=<n>&windowDays=<1..30>&priorFailureSignature=<sig>`

Recovery before/after rollup. Splits the same time window by version cutoff: runs whose `workflow_versions.version < afterVersion` form the "before" side; runs whose `version >= afterVersion` form the "after" side. Returns:

```json
{
  "workflowId": "wf-xyz",
  "afterVersion": 4,
  "windowDays": 1,
  "hasEnoughData": true,
  "before": { "score": 81, "status": "healthy", "breakdown": { ... }, "signals": { ... } },
  "after":  { "score": 85, "status": "healthy", "breakdown": { ... }, "signals": { ... } },
  "delta": { "score": 4, "p95LatencyMs": -1900, "costPerRunUsd": -0.004 },
  "recentRunsAgainstAfter": { "totalRuns": 6, "succeeded": 6, "failed": 0, "running": 0 },
  "sameFailureSinceApply": { "count": 0, "sampleDeadLetterIds": [], "priorSignature": "HTTP 500 on http node" },
  "priorVersion": { "version": 3, "versionId": "ver-prev" }
}
```

`delta` is `null` until `after.signals.totalRuns >= 5` (constant `MIN_RUNS_FOR_DELTA` in `@janusly/engine/src/workflow-health`); the dialog renders the run counter + same-failure pill while waiting. `recentRunsAgainstAfter` is always populated and includes in-flight runs (`running`) so the operator sees activity from run 1. `sameFailureSinceApply` is `null` when `priorFailureSignature` is omitted — when supplied, the route normalizes each new DLQ row's `errorJson` and counts matches against the supplied signature; defense-in-depth, the `priorSignature` echoed in the response is the caller-supplied input verbatim, never a freshly-derived signature. `priorVersion` is `null` when the workflow only has one version. Mounted by `<RecoveryDeltaCard>` inside the recovery dialog's `applied` step.

### `GET /recovery/metrics?windowDays=30`

Org-level Operations dashboard payload — six metric cards (success rate, MTTR, p95 latency, approvals pending, replay rate, cost) each with `value` / `display` / `severity` / `rationale`. Severity bands are tunable constants in the engine module.

### `POST /recovery/feedback`

Operator → system feedback channel for the recovery loop. Captures every accept/reject decision the operator makes in the Recovery dialog so future patch suggestions for the same workflow can deprioritize already-rejected approaches.

Body:

```json
{
  "deadLetterId": "dlq-xyz",
  "suggestionMode": "ai",
  "approachLabel": "add_retry",
  "accepted": false,
  "comment": "Wrong approach"
}
```

Closed enums: `suggestionMode ∈ {"ai", "fallback"}`; `approachLabel ∈ {"add_retry", "raise_timeout", "swap_secret_ref", "add_approval", "fix_url", "other"}`. `comment` is optional and capped at 2000 chars; secret-shape substrings (`Bearer sk-…`, `ghp_…`, JWTs) are scrubbed via `scrubSecretShapes` at write time.

Returns `{ "ok": true }` on success, 404 on cross-tenant DLQ, 400 on schema-invalid body, 422 when the DLQ's workflow has no saved id (anonymous workflows aren't aggregated). Audited as `recovery.feedback` with metadata `{ deadLetterId, approachLabel, suggestionMode, accepted }`.

The dialog calls this fire-and-forget at four moments: Apply success (`accepted: true`), Cancel from review or validation-failed (`accepted: false` with the chip text or free-text comment), Iterate from validation-failed (`accepted: false, comment: "validation_failed"` BEFORE re-entering generate). The next call to `/ai/patch-workflow` for the same workflow reads back an aggregated summary via `summarizePastFeedback` and threads it into the LLM prompt as `extraContext.pastFeedbackSummary`.

---

## Audit & Billing

### `GET /audit`

Last 100 audit events for the org (newest first).

### `GET /billing/usage`

```json
{ "tokens": 12420, "runs": 142 }
```

Sources from the `usage_events` table.

---

## TypeScript SDK

A typed Node.js client wraps the routes above. It ships with the monorepo
as the workspace-private package `@janusly/sdk` under
[`packages/sdk-node/`](../packages/sdk-node/). It follows the repo's Node
24 source-package baseline, has zero runtime dependencies, and exposes a
resource-style API:

```typescript
import { JanuslyClient } from "@janusly/sdk";

const client = new JanuslyClient({
  baseUrl: "https://api.janusly.example.com",
  orgId: "acme",
  auth: { kind: "service-token", token: process.env.JANUSLY_TOKEN! },
});

const { runId } = await client.runs.start({ workflowId: "wf-incident", input: { ticketId: "T-42" } });

for await (const event of client.runs.streamEvents(runId)) {
  console.log(event.type, event.nodeId);
  if (event.type === "node.failed") break;
}
```

Surface highlights:

- **`client.runs.*`** — start saved workflows, list the current capped runs page as an async iterator, get details, poll until terminal, stream events (async iterator), resume `human_form` / `approval` nodes with engine-signed resume tokens.
- **`client.reports.exportRunExplain(runId, { format })`** — download the run-explain artefact (markdown or JSON) with the suggested filename from `Content-Disposition`.
- **`client.recovery.getMetrics({ windowDays })`** — operations rollup (success rate, MTTR, p95 latency, approvals pending, replay rate, cost).
- **`client.webhooks.verifySignature({ body, signatureHeader, secret })`** — Stripe-style HMAC-SHA256 verifier for inbound Janusly webhooks (`x-janusly-signature: t=<unix-seconds>,v1=<hex>` over `${t}.${body}`). Uses `crypto.timingSafeEqual` + ±5-min clock-skew tolerance.

Two auth modes: **service-token** (sends `Authorization: Bearer <token>` + `x-user-id` defaulting to `"sdk-user"`) and **caller-supplied bearer** (Authorization only, identity carried in the token). `x-org-id` is always sent.

## Python SDK

`packages/sdk-python/` ships the sibling Python client package (`janusly`,
Python 3.10+) with the same core resource bindings (`runs`, `reports`,
`recovery`, `webhooks`). It is installed from the repo today:

```bash
pip install -e packages/sdk-python
```

PyPI publish is a separate release step. See [`docs/sdk-python.md`](sdk-python.md)
and [`packages/sdk-python/README.md`](../packages/sdk-python/README.md) for the
surface table, examples, and v1 non-goals.

Typed error hierarchy: `JanuslyApiError` base + `JanuslyAuthError` (401/403) + `JanuslyValidationError` (400/422 with `code` + `params`) + `JanuslyRateLimitError` (429, carries `retryAfterSeconds`) + `JanuslyServerError` (5xx) + `JanuslyTimeoutError` (polling deadline) + `JanuslyWebhookSignatureError`. Consumers `instanceof` instead of switching on `statusCode`.

Optional config-level affordances: structured `logger` hook, opt-in `retry` layer (default OFF; respects `Retry-After` on 429s), per-call `{ signal, headers, timeoutMs }` options on every method. AbortSignals propagate everywhere via `AbortSignal.any` composition.

See [`packages/sdk-node/README.md`](../packages/sdk-node/README.md) for the
full documentation: 6 worked use cases (stream events, poll until
terminal, list the capped runs page, resume human_form, export reports,
verify webhooks with Express raw-body handler), error handling, best
practices, and TypeScript notes.
