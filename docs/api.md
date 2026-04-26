# HTTP API Reference

Base URL: `http://localhost:3001`. Every request must carry an auth context. In dev, send `x-org-id` and `x-user-id` headers. In production with Supabase, send a `Bearer <jwt>` whose `user_metadata.orgId` resolves the org.

CORS allowed origins come from `API_ALLOWED_ORIGINS` (default: `http://localhost:5173,http://127.0.0.1:5173`). Body limit defaults to 1 MiB (`API_MAX_JSON_BODY_BYTES`).

All examples below assume the dev-headers shorthand `-H "x-org-id: default" -H "x-user-id: dev-user"`.

---

## Health

### `GET /health`

Liveness probe. No auth needed.

**Response 200**
```json
{ "ok": true }
```

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

---

## Validate

### `POST /validate`

Stateless DAG validation. Available to all authenticated users (no role check).

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
| `multi_agent_missing_agents` | `multi_agent.config.agents` is empty |
| `edge_invalid_from` / `edge_invalid_to` | Edge references unknown node id |
| `edge_invalid_condition` | Edge condition expression invalid |
| `cycle_detected` | DAG has a cycle |
| `missing_start_node` | Every node has incoming edges |

---

## Runs

### `POST /start`

Validates and starts a run. Requires `editor` role.

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

List the org's runs, newest first.

### `GET /run?runId=<uuid>`

Returns the run, all of its nodes, and the full event log. Use this for "open run" detail screens.

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
  ]
}
```

Run statuses: `running`, `succeeded`, `failed`, `canceled`.
Node statuses: `pending`, `queued`, `running`, `waiting`, `succeeded`, `failed`, `skipped`.

### `GET /status?runId=<uuid>`

Same shape as `/run` (nodes + events + run). The UI polls this every 1.5s.

### `GET /events?runId=<uuid>`

Server-sent events stream. Emits incremental batches of new events (only ones with `createdAt > lastSeen`).

```
data: [{"id":"...","type":"node.queued",...}]

data: [{"id":"...","type":"node.succeeded",...}]
```

### `POST /resume`

Resumes a run that's `waiting` on an `approval` or `webhook` node. Requires `editor` role.

**Request**
```json
{ "runId": "12aff2ba-...", "nodeId": "human_approval" }
```

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

### `GET /credentials` / `POST /credentials`

Credentials reference secrets stored elsewhere (Supabase Vault, Doppler, env vars). Requires `admin` for writes.

```json
{ "name": "Slack bot", "kind": "slack", "secretRef": "SLACK_BOT_TOKEN" }
```

In workflow nodes, use `{{secret.SLACK_BOT_TOKEN}}` to dereference.

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

### `POST /ai/generate-workflow`

Generates a workflow JSON from a natural-language prompt. Falls back to the first template when `OPENAI_API_KEY` is not set.

**Request**
```json
{ "prompt": "Fetch GitHub trending repos and uppercase the names." }
```

**Response 200**
```json
{ "id": "...", "nodes": [...], "edges": [...] }
```

### `POST /ai/explain-workflow`

```json
{ "workflow": { ...DAG... } }
```

```json
{ "explanation": "This workflow fetches data and ..." }
```

---

## Audit & Billing

### `GET /audit`

Last 100 audit events for the org (newest first).

### `GET /billing/usage`

```json
{ "tokens": 12420, "runs": 142 }
```

Sources from the `usage_events` table.
