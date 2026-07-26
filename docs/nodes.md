# Node Reference

Every workflow is a DAG of `nodes` connected by `edges`. Each node has an `id`, a `type` (one of the supported types below), and a `config` object validated by the engine.

The runtime supports the full closed node set from `packages/shared/src/workflow.ts`: `http`, `condition`, `tool`, `agent`, `multi_agent`, `agent_reflection`, `loop`, `router`, `router_llm`, `transform`, `ai`, `webhook`, `approval`, `human_form`, `noop`, `subworkflow`, `wait_until`, `parallel_fork`, `join`, `schedule`, `mcp_tool`, `webhook_received`, `email_received`, `file_dropped`, and `mcp_server_event`. `/ai/generate-workflow` emits only the smaller AI-generation subset; Pass 2 auto-promotes wired placeholder families (`wait_until`, `schedule`, and uniquely matched exposed `mcp_tool` noops), while operators promote the remaining advanced runtime nodes in the Inspector or by editing the workflow JSON.

Templating is supported in any string config value via `{{...}}`:

- `{{context.<nodeId>.output.<field>}}` — read another node's output
- `{{inputs.<field>}}` — read fields from the node's own config
- `{{secret.<NAME>}}` — read `process.env.<NAME>` directly (deploy/vault secret, not a `credentials` row)
- `{{env.<NAME>}}` — read `process.env.<NAME>` (any env var)

## `noop`

Pass-through node. Useful as a graph anchor or for explicit "start" / "done" markers.

```jsonc
{
  "id": "start",
  "type": "noop",
  "config": {}
}
```

**Output:** `{}`

## `http`

Calls an external HTTP endpoint. Subject to the SSRF policy (`ALLOW_PRIVATE_HTTP_TARGETS`).

```jsonc
{
  "id": "fetch_user",
  "type": "http",
  "config": {
    "url": "https://api.github.com/users/octocat",
    "method": "GET",
    "headers": { "Accept": "application/vnd.github+json" }
  }
}
```

**Output:** `{ statusCode: number, ok: boolean, body: string }`

Read the body downstream with: `{{context.fetch_user.output.body}}`.

### Streaming HTTP responses (5 MB CSV recipe)

The default `http` node buffers the entire response into `output.body` before any downstream step runs. That's fine for typical API calls but blocks legitimate large-fetch use cases — multi-MB CSV ingest, PDF retrieval, image processing — because raising the global byte cap (`http.maxResponseBytes`, default 1 MB) defeats the OOM guard.

Set `bodyMode: "stream"` on the node config to opt into the streaming primitive. The executor reads the response chunk-by-chunk and captures the first N bytes into a bounded preview that gets persisted to `run_nodes.state_json.output.body`; the full body still flows through the byte cap (the stream aborts mid-flight if the cap is exceeded). The preview size is controlled per-org by `http.streamPreviewBytes` (default 64 KB, range 1 KB..1 MB) or per-call via the `streamPreviewBytes` config field.

Buffered HTTP nodes and the `http.request` tool preserve the decoded text in
`output.body`. When the final response declares `application/json` or an
`application/*+json` media type and parsing succeeds, the same output also
contains the native value at `output.json`. A lying upstream that declares JSON
but returns invalid text leaves `output.json` absent and sets
`output.jsonParseError: true`; non-JSON media types are never guessed from body
content. Automatic projection is capped at 64 KiB so storing both forms does not
exhaust the node-state persistence budget; a larger declared JSON body remains
at `output.body` and sets `output.jsonParseSkipped: "body_too_large"`. Streaming
previews are not parsed because they may be truncated. Use the read-side
`json.parse` tool when the operator explicitly wants to parse a larger buffered
body or a string whose response did not declare JSON.

Node-config templates remain backward compatible: an absent `context.*` or
`inputs.*` path renders as an empty value and writes one bounded
`template.unresolved_path` event for that resolution phase. Set the workflow's
top-level `templatePolicy` to `"strict"` to fail instead of consuming an
accidental empty value. Ordinary config paths fail before the executor runs;
loop `item`/`index` and sequential-agent `previousAgents` paths fail at their
later binding point. Missing `{{secret.*}}` references retain their existing
immediate hard failure.

```jsonc
{
  "id": "ingest_invoices_csv",
  "type": "http",
  "config": {
    "url": "https://files.partner.example.com/invoices/2026-05.csv",
    "method": "GET",
    "headers": { "Accept": "text/csv" },
    "bodyMode": "stream",
    "maxResponseBytes": 8000000,
    "streamPreviewBytes": 16384
  }
}
```

**Output when streamed:** `{ statusCode, ok, body, streamed: true, streamedBytes, streamTruncated }`

- `body` is a UTF-8 string preview (up to `streamPreviewBytes`); auditable in the Runs panel without inflating the row.
- `streamedBytes` is the total bytes consumed from the upstream (capped by `maxResponseBytes`).
- `streamTruncated` is `true` when `streamedBytes > streamPreviewBytes`.

For true row-by-row CSV processing, use the `csv.fetch` tool instead of `http.request` + `csv.parse`. It fetches through the same streaming HTTP chokepoint, parses chunks through the shared RFC 4180 tokenizer, and returns a bounded summary/sample rather than a live stream:

```jsonc
{
  "id": "summarize_invoices_csv",
  "type": "tool",
  "config": {
    "tool": "csv.fetch",
    "input": {
      "url": "https://files.partner.example.com/invoices/2026-05.csv",
      "headers": { "Accept": "text/csv" },
      "sampleRows": 25,
      "filter": { "status": "open" },
      "maxBytes": 8000000,
      "timeoutMs": 30000,
      "maxRedirects": 3
    }
  }
}
```

**`csv.fetch` output:** `{ ok, statusCode, totalRows, matchedRows, sampleRows, headers, streamedBytes, streamTruncated, malformedRows, error? }`

- `totalRows` counts data rows after the header, including filtered-out and malformed rows.
- `matchedRows` and `sampleRows` include only rows that match the optional exact-match `filter`; malformed rows are excluded from the sample.
- `malformedRows` counts rows whose column count does not match the header.
- `streamTruncated` is `true` when the upstream stream aborts mid-flight, for example after `maxBytes` is exceeded. Partial counts and sample rows still return with `ok: false`.

**Remaining limitation:** live streams are still consumed within the same executor invocation. Downstream nodes see only the persisted preview or the bounded `csv.fetch` summary, because run state is checkpointed to Postgres between every node.

**Safeguards preserved:** the SSRF guard (`ALLOW_PRIVATE_HTTP_TARGETS=false` rejects private targets), DNS-rebinding pin (the validated IP is pinned to the connect), timeout (`timeoutMs`), redirect chain (`maxRedirects`), and the byte cap (`maxResponseBytes`) all apply to the streaming path identically. The `http.request` tool gains the same `bodyMode` / `streamPreviewBytes` input fields when called directly from an `agent` or `tool` node.

## `condition`

Evaluates a sandboxed boolean expression and emits `{ result: boolean }`. Combine with edge `condition` to branch the graph.

Supported operators: `===`, `!==`, `==`, `!=`, `>`, `<`, `>=`, `<=`, `contains`, `startsWith`, `matches`, `in`, `&&`, `||`, `!`, and parentheses. Values may be strings, numbers, booleans, `null`, primitive array literals, or dotted/indexed paths under `context.*` and `inputs.*`. Anything else is rejected (no arbitrary JavaScript or function calls).

- `contains` is case-sensitive substring matching for strings and membership for arrays.
- `startsWith` is a case-sensitive string-prefix check.
- `matches` is a bounded whole-string glob match: `*` matches any run of characters and `?` matches one character. Patterns are capped at 256 characters and values at 16,384 characters; it is intentionally not a regular-expression engine.
- `in` checks whether the left value is a member of an array path or literal, for example `'billing' in context.input.tags`.
- Ordered comparisons are numeric for two numbers and lexicographic for two strings, so equal-width ISO 8601 timestamps compare naturally. A number paired with a numeric string preserves the legacy numeric coercion; incompatible runtime values remain non-fatal and evaluate `false`, while statically invalid literal/operator combinations are rejected during validation.

```jsonc
{
  "id": "is_example_domain",
  "type": "condition",
  "config": {
    "expression": "context.fetch_user.output.email matches '*@example.com'"
  }
}
```

A string-and-collection expression can compose the new operators:

```jsonc
{
  "id": "is_priority_customer",
  "type": "condition",
  "config": {
    "expression": "context.fetch_user.output.email matches '*@example.com' && 'priority' in context.fetch_user.output.tags"
  }
}
```

**Output:** `{ result: true }`

## `transform`

Runs `mapInput` over `config.mapping`, expanding all `{{...}}` placeholders against the run context. Returns the rendered object as the node output.

```jsonc
{
  "id": "shape",
  "type": "transform",
  "config": {
    "mapping": {
      "userId": "{{context.fetch_user.output.body}}",
      "isOk": "{{context.fetch_user.output.ok}}",
      "checkedAt": "{{env.NODE_ENV}}"
    }
  }
}
```

**Output:** the rendered `mapping` object as-is.

## `loop`

Iterates over `config.items` (array, comma-separated string, or template that resolves to one). The omitted/default `mode: "map"` preserves the original projection contract: for each item, it expands `mapping` with `item` and `index` in scope.

```jsonc
{
  "id": "fanout",
  "type": "loop",
  "config": {
    "items": "alpha,beta,gamma",
    "mapping": { "key": "{{item}}", "position": "{{index}}" }
  }
}
```

**Output:** `{ count: 3, items: [{key:"alpha",position:"0"}, {key:"beta",position:"1"}, {key:"gamma",position:"2"}] }`

`mode: "for_each"` invokes one registered tool per item with bounded in-node concurrency. The per-item `input` can reference `item` and `index`; all inputs are rendered before the first tool call so a strict unresolved-template failure cannot partially process the batch.

```jsonc
{
  "id": "parse_batch",
  "type": "loop",
  "config": {
    "items": "1,invalid,2",
    "mode": "for_each",
    "tool": "json.parse",
    "input": { "value": "{{item}}" },
    "concurrency": 2,
    "toleratedFailureCount": 1
  }
}
```

The node accepts at most 1,000 items. `concurrency` defaults to 4 and is limited to 1..20. A failure is either a thrown tool error or a registered-tool envelope with `ok: false`. With no configured budget, any failure fails the node; exactly one of `toleratedFailureCount` (0..1,000) or `toleratedFailurePercentage` (0..100) can permit failures up to and including the threshold. Crossing it fails the node with `LOOP_FAILURE_BUDGET_EXCEEDED`, preserving structured counts, all failed indices, and a bounded failure sample for retries and DLQ inspection. Validation/sandbox runs skip write-side tools through the same registry gate as ordinary `tool` nodes.

**Output:** `{ mode: "for_each", tool, count, succeededCount, skippedCount, failedCount, failedPercentage, failedIndices, failures, failureDetailsTruncated, resultTruncatedCount, toleratedFailureCount?, toleratedFailurePercentage?, items }`. Per-item results preserve input order, are capped at 64 KB, and the aggregate item list is capped at 700 KB with explicit truncation sentinels. Failed-items-only redrive remains separate recovery work. Read-side failures may retry the whole node under its retry policy; possibly committed write-side failures do not retry automatically and require operator-gated DLQ replay.

## `tool`

Invokes a registered in-tree tool such as `http.request`, `text.uppercase`, `json.pick`, `csv.fetch`, `email.send`, or `pdf.generate`. The config key is always `tool`; `input` is rendered through the template engine before execution. In validation/sandbox replay, write-side tools are skipped while read-side tools still run.

```jsonc
{
  "id": "shout",
  "type": "tool",
  "config": {
    "tool": "text.uppercase",
    "input": { "value": "hello workflow" }
  }
}
```

**Output:** `{ tool: "text.uppercase", result: { value: "HELLO WORKFLOW" } }`

### Business hours and other recurring time windows

`time.window` is the only zone-aware weekday + time-of-day primitive. The
edge-condition grammar has no function calls and the other `time.*` tools are
zone-unaware, so any "only during business hours" / "after hours" / "weekends"
rule is expressed as a `time.window` node plus a branch on its result.

```jsonc
{
  "id": "check_hours",
  "type": "tool",
  "config": {
    "tool": "time.window",
    "input": {
      "timeZone": "Europe/Madrid",
      "windows": [{ "days": [1, 2, 3, 4, 5], "start": "09:00", "end": "17:00" }]
    }
  }
}
```

- `days` uses `0`=Sunday..`6`=Saturday; `start` is inclusive and `end` exclusive.
- A window whose `end` precedes its `start` crosses midnight (night shifts): it
  opens on a listed day and closes on the next calendar day.
- `at` defaults to now. Template an upstream timestamp
  (`"{{context.on_event.output.event.occurredAt}}"`) to decide on event time
  instead of processing time — they differ whenever work is retried or replayed.
- Read-side, so it still runs in validation/sandbox replay.

**Output:** `{ inWindow, at, timeZone, localDay, localTime, matchedWindow }` —
branch with `context.check_hours.output.result.inWindow === false`.

Malformed configuration (unknown IANA zone, a time that is not 24h `HH:MM`, or
`start === end`) **fails the node** rather than returning `false`: a decision
primitive must not let broken config look like a legitimate "outside the
window" answer. The PagerDuty off-hours evaluator
(`pagerduty.policy.evaluate`) deliberately takes the opposite posture for its
own provider-specific decision — it absorbs malformed policy data as "inside
working hours" so it can never authorize a mutation. Both share one zone
implementation (`packages/engine/src/zoned-window.ts`); only the bias differs.

## `agent`

Runs a single-agent loop using either the rule-based planner or the provider-backed planner (`config.planner: "rules" | "openai"`). The agent picks tools from the registry and iterates up to `maxSteps` times. With `reflection: true`, each step is followed by a self-check.

```jsonc
{
  "id": "summarizer",
  "type": "agent",
  "config": {
    "name": "summarizer",
    "role": "Content writer",
    "goal": "uppercase this text",
    "value": "Workflow Engine v2",
    "planner": "rules",
    "maxSteps": 3,
    "reflection": true
  }
}
```

**Output:** `{ steps: [...], finalAnswer?: string, finalResult?: any, reflection?: {...} }`

## `multi_agent`

Runs a team of agents. Modes:

- `sequential` — agents run in order, each can read the previous results from `previousAgents`.
- `parallel` — agents run concurrently with `Promise.allSettled`.

Aggregation strategies for the final answer: `last` (default), `first`, `all`, `best-effort`.

```jsonc
{
  "id": "agents",
  "type": "multi_agent",
  "config": {
    "mode": "sequential",
    "aggregation": "last",
    "continueOnError": false,
    "agents": [
      { "name": "analyzer", "role": "Data analyst", "goal": "uppercase the input" },
      { "name": "validator", "role": "QA reviewer", "goal": "review {{previousAgents.0.result.finalAnswer}}" }
    ]
  }
}
```

**Output:** `{ mode, aggregation, count, finalAnswer, agents: [{name, role, status, result}] }`

## `agent_reflection`

Pure heuristic node: inspects an input string for failure signals (`error`, `failed`) and emits `{ decision: "accept" | "retry", reason, input }`. Useful as a guard between agents.

```jsonc
{
  "id": "double_check",
  "type": "agent_reflection",
  "config": {
    "input": "{{context.summarizer.output.finalAnswer}}"
  }
}
```

**Output:** `{ decision: "accept", reason: "...", input: "..." }`

## `router` / `router_llm`

Chooses one candidate branch using the decision engine. `config.candidates` must list target node ids with the canonical `{ "nodeId": "..." }` shape; the runtime still accepts the legacy `{ "id": "..." }` field for old AI-generated drafts. Optional `strategy` values are `auto`, `cheapest`, `fastest`, and `balanced`; the decision engine also reads run context `preferences` / `budget` and org routing stats.

```jsonc
{
  "id": "pick_route",
  "type": "router",
  "config": {
    "strategy": "balanced",
    "candidates": [
      { "nodeId": "fast_path", "avgLatencyMs": 2000, "avgCost": 0.04, "successRate": 0.97 },
      { "nodeId": "cheap_path", "avgLatencyMs": 8000, "avgCost": 0.01, "successRate": 0.91 }
    ]
  }
}
```

**Output:** `{ decision: { chosenNodeId, ranking, strategy, ... } }`

## `ai`

Runs a provider-neutral LLM text call. `config.prompt` is the inline prompt; `config.promptRef` can point to a saved prompt registry entry and wins over `prompt` when both are set. `config.variables` supplies prompt-ref variables, and `config.model` can be either a bare model id or a `<provider>/<model>` override. Provider errors, missing prompt refs, budget blocks, and missing API keys complete the node with `mode: "fallback"` instead of throwing into retry/DLQ.

```jsonc
{
  "id": "summary",
  "type": "ai",
  "config": { "prompt": "Summarize the workflow context" }
}
```

**Output:** AI success returns `{ mode: "ai", model, provider, prompt, response, usage?, costUsd?, latencyMs? }`; fallback returns `{ mode: "fallback", aiError?, prompt, response, ... }`.

## `webhook`

Pauses the run and emits a `node.waiting` event with a resume token of the form `<runId>:<nodeId>`. Resume with `POST /resume`; the resume payload is stored as this node's output so downstream templates can read fields from the inbound webhook.

```jsonc
{
  "id": "wait_callback",
  "type": "webhook",
  "config": {}
}
```

**Output (on resume):** the submitted resume input, or `{}` when none was supplied.

## `approval`

Same wait/resume mechanic as `webhook`, intended for human-in-the-loop. The UI surfaces an Approve button under the Runs panel for each waiting node. The resume token is the legacy `<runId>:<nodeId>` shape; the approval decision is represented by the timeline/audit trail, while node output stays `{}` for backward compatibility. `assignee` is visible operational ownership, not an authorization boundary: any editor who can resume the run may still approve it.

```jsonc
{
  "id": "human_approval",
  "type": "approval",
  "config": {
    "message": "Please review the report and approve to publish.",
    "assignee": "tier-1-on-call",
    "decisionTimeoutMs": 600000,
    "onTimeout": "escalate",
    "escalateTo": "tier-2-on-call"
  }
}
```

The optional deadline is either a positive integer `decisionTimeoutMs` relative to when the node begins waiting, or an absolute ISO 8601 `until` instant with an explicit timezone; never set both. `decisionTimeoutMs` is deliberately separate from the universal executor `timeoutMs`. Without either deadline field the legacy indefinite wait remains unchanged. A deadline defaults to `onTimeout: "fail"`; the other policies are `"auto_reject"` (terminal failure without advancing downstream work) and `"escalate"` (atomically reassign to the non-empty `escalateTo` owner and remain waiting). A stale timeout delivery cannot overwrite a manual resume, cancellation, replay, or a newer deadline generation.

**Waiting metadata:** `{ kind, assignee?, decisionTimeoutMs?, deadlineAt?, onTimeout?, escalateTo?, timeoutState? }`. Timeout outcomes emit `approval.timed_out`, `approval.auto_rejected`, or `approval.escalated` timeline events.

**Output (on resume):** `{}`. The approval decision is recorded in events/audit, not node state.

## `human_form`

Pauses the run and asks an operator for structured input. The node config carries a small JSON-schema subset; the web renders it as a form, validates submitted values, and resumes the run with the parsed form body as this node's output. Unlike `webhook` / `approval`, the resume token is HMAC-signed and bound to org/run/node/purpose.

```jsonc
{
  "id": "pto_request",
  "type": "human_form",
  "config": {
    "title": "PTO request",
    "description": "Collect the manager-visible request details.",
    "schema": {
      "type": "object",
      "required": ["employee", "days"],
      "properties": {
        "employee": { "type": "string", "description": "Employee name" },
        "days": { "type": "number", "description": "Requested days" },
        "urgent": { "type": "boolean", "description": "Needs same-day review" }
      }
    }
  }
}
```

**Output (on resume):** the submitted object, for example `{ employee: "Ana", days: 3, urgent: false }`.

## `subworkflow`

Starts another active saved workflow as a child run and pauses until the child reaches a terminal status. The child workflow lookup is scoped to the same org and excludes soft-deleted workflows. Set the optional `config.version` integer from 1 through 2,147,483,647 to execute that exact immutable saved version; omit it to resolve the latest version when the node starts. `config.input` is forwarded when present, otherwise the parent's run input is inherited, and subworkflow nesting is bounded by `runs.subworkflowMaxDepth`.

```jsonc
{
  "id": "run_enrichment",
  "type": "subworkflow",
  "config": {
    "workflowId": "customer-enrichment",
    "version": 3,
    "input": { "customerId": "{{context.fetch_user.output.body.id}}" }
  }
}
```

**Output:** the child run's `outputJson` after the child succeeds. Child creation atomically checkpoints the parent before publishing child roots. Executable parent links are distinct from Replay Lab lineage, so replay provenance does not consume nesting depth; a validation parent passes its sandbox mode to every nested child and still receives the child's terminal handoff. If the child fails, the parent error retains the earliest failed child node and its persisted error; cancellation also fails the parent node, and every failed sibling is settled even when another child already made the parent terminal. If that exact child later succeeds after a recovery replay, the engine reattaches its output with a generation-bound compare-and-set and reopens the parent only when no sibling failures remain. Separate durable outboxes restore both a lost terminal executable child→parent handoff and any parent queue generation consumed during the failed→running transition without bypassing retry backoff.

## `wait_until`

Pauses the run until either a positive ISO 8601 duration elapses or an absolute ISO 8601 instant arrives, then resumes automatically through a delayed BullMQ job. Absolute instants require an explicit timezone. Set exactly one of `duration` and `until`. Manual `POST /resume` can short-circuit the wait, elapsed absolute instants resume immediately, and delayed wake-up is idempotent if the node has already advanced.

```jsonc
{
  "id": "wait_three_days",
  "type": "wait_until",
  "config": { "duration": "P3D" }
}
```

Absolute example:

```jsonc
{
  "id": "wait_for_window",
  "type": "wait_until",
  "config": { "until": "2026-07-15T21:00:00-05:00" }
}
```

**Waiting metadata:** `{ kind: "timer", wakeAt, durationMs, source }`, where `source` is `"duration"` or `"until"`. **Output on resume:** `{}`.

## `parallel_fork` / `join`

`parallel_fork` declares named branches and succeeds immediately; actual fan-out is the normal DAG behavior of multiple outgoing edges. `join` waits for all incoming predecessors through the runtime's fan-in readiness check, then assembles branch outputs from `config.sources`.

```jsonc
{
  "id": "fan_out",
  "type": "parallel_fork",
  "config": {
    "branches": [
      { "label": "crm", "description": "Fetch CRM data" },
      { "label": "billing", "description": "Fetch billing data" }
    ]
  }
}
```

```jsonc
{
  "id": "join_results",
  "type": "join",
  "config": {
    "sources": {
      "crm": "fetch_crm",
      "billing": "fetch_billing"
    }
  }
}
```

**`parallel_fork` output:** `{ branches: [{ label, description? }, ...] }`

**`join` output:** `{ branches: { "<label>": <predecessor output>, ... } }`

## `schedule`

Passthrough trigger for cron-started workflows. The executor does not sleep or schedule by itself; `schedule-scheduler.ts` registers/removes the BullMQ repeatable job when a workflow is saved. `cronExpression` is a standard five-field cron string. `enabled: false` prevents scheduler registration, but manual `POST /start` still runs the node.

```jsonc
{
  "id": "weekday_morning",
  "type": "schedule",
  "config": {
    "cronExpression": "0 9 * * 1-5",
    "enabled": true
  }
}
```

**Output:** `{ triggeredAt, cronExpression }`

## `mcp_tool`

This is how a workflow reaches a system Janusly ships no built-in tool for —
[`docs/mcp.md`](mcp.md) covers registering a server, the per-tool opt-in model,
and the safety posture; this section is the node contract.

Invokes a tool from an org-registered external MCP connection. The connection and descriptor must both be active/enabled; write-side execution requires both the process write flag and the tenant `mcp.clientWriteConsent` flag. Stdio transports run through the subprocess sandbox; URL transports keep the HTTP SSRF validation perimeter.

```jsonc
{
  "id": "notion_lookup",
  "type": "mcp_tool",
  "config": {
    "connectionAlias": "notion",
    "toolName": "pages.search",
    "input": { "query": "{{context.summary.output.title}}" },
    "timeoutMs": 30000
  }
}
```

**Output:** the MCP tool's `output` payload. Runtime failures throw as node failures so retry/DLQ machinery applies.

## Event-driven triggers

`webhook_received`, `email_received`, `file_dropped`, and `mcp_server_event` are passthrough
trigger nodes. The executor never talks to SMTP, a bucket, or an MCP server;
the API ingestion seam owns all external I/O. Ingestion routes normalize the
payload, write a `trigger_events` row, apply a per-trigger storm guard, and
start a run with the normalized event under `input.event`. Replay uses the
stored payload from that structured event row.

- `POST /triggers/webhook/ingest` matches `webhook_received.config.endpointKey`; callers must supply a stable `eventId`, and retries converge on one run.
- `POST /triggers/email/ingest` matches `email_received.config.aliasKey`, then enforces DKIM and optional `fromDomains`.
- `POST /triggers/file/ingest` matches `file_dropped.config.bucket` plus optional `prefix` / `extensions`.
- `POST /triggers/mcp/ingest` matches `mcp_server_event.config.connectionAlias`, `resourceUri`, and optional `eventTypes`.
- `POST /triggers/events/:id/replay` replays a stored event against the current latest workflow version.

Inbound selectors must be unique among active workflows in an organization. A
duplicate selector returns HTTP 409 `trigger_selector_ambiguous` before any
event or run is created; Janusly never chooses an arbitrary first match.

Manual `POST /start` still executes a workflow containing trigger nodes; in
that path the trigger output carries an empty `event` object.

```jsonc
{
  "id": "incoming",
  "type": "webhook_received",
  "config": {
    "endpointKey": "incident-triage",
    "rateLimitPerMin": 60
  }
}
```

```jsonc
{
  "id": "inbox",
  "type": "email_received",
  "config": {
    "aliasKey": "invoices",
    "dkimRequired": true,
    "fromDomains": ["vendor.example"],
    "rateLimitPerMin": 30
  }
}
```

```jsonc
{
  "id": "file_drop",
  "type": "file_dropped",
  "config": {
    "bucket": "customer-imports",
    "prefix": "org/default/",
    "extensions": ["csv"]
  }
}
```

```jsonc
{
  "id": "mcp_change",
  "type": "mcp_server_event",
  "config": {
    "connectionAlias": "notion",
    "resourceUri": "notion://database/customer-tasks",
    "eventTypes": ["notifications/resources/updated"]
  }
}
```

**Output:** `{ triggeredBy, triggeredAt, event }`

---

## Edge conditions

Edges have an optional `condition` that must evaluate to `true` for the target to be queued. Same expression sandbox as `condition` nodes.

```jsonc
{ "from": "is_ok", "to": "shout", "condition": "context.is_ok.output.result === true" }
```

If the condition is `false`, the target is marked `skipped`.
