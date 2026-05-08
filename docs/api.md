# HTTP API Reference

Base URL: `http://localhost:3001`. Every request must carry an auth context. In dev, send `x-org-id` and `x-user-id` headers. In production with Supabase, send a `Bearer <jwt>` whose `user_metadata.orgId` resolves the org.

CORS allowed origins come from `API_ALLOWED_ORIGINS` (default: `http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174`). The `5174` ports are included so dev still works when Vite falls back from `5173` due to a port collision. Body limit defaults to 1 MiB (`API_MAX_JSON_BODY_BYTES`).

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

Generates a workflow JSON from a natural-language prompt. In the supported MVP setup this uses Anthropic through `JANUSLY_LLM_PROVIDER=anthropic`; it falls back to a deterministic template when the selected provider key is not available or the model call fails.

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

### `POST /ai/review-workflow`

AI semantic readiness pass that complements the deterministic readiness gate (`POST /workflows/readiness`). The LLM looks for ambiguous prompts, raw secrets in node config, missing approvals upstream of write-side actions, and ambiguous tool inputs — every finding carries `severity: "info" | "warn" | "fail"`, `code`, `message`, `nodeId`, `rationale`, `suggestion`. AI mode and the deterministic findings are merged at the route layer. Falls back gracefully without a provider key.

### `POST /ai/explain-run`

```json
{ "runId": "...", "question": "Why did this fail?" }
```

```json
{ "mode": "ai", "answer": "...", "model": "claude-haiku-4-5-20251001", "provider": "anthropic" }
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
