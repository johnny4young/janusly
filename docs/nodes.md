# Node Reference

Every workflow is a DAG of `nodes` connected by `edges`. Each node has an `id`, a `type` (one of the supported types below), and a `config` object validated by the engine.

Templating is supported in any string config value via `{{...}}`:

- `{{context.<nodeId>.output.<field>}}` — read another node's output
- `{{inputs.<field>}}` — read fields from the node's own config
- `{{secret.<NAME>}}` — read `process.env.<NAME>` (workspace secret)
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

**v1 limitations:**
- Streams are consumed within the same executor invocation. Downstream nodes (different DAG steps) see only the persisted preview — workflows can't pass a live stream across persistence boundaries, because the run state is checkpointed to Postgres between every node.
- A future streaming-aware tool (e.g. `csv.parse-stream` that combines fetch + parse in one step) is the path for true line-by-line processing of large payloads. Until then, raise `streamPreviewBytes` per call when the operator needs more bytes for downstream `transform` / `condition` evaluation.

**Safeguards preserved:** the SSRF guard (`ALLOW_PRIVATE_HTTP_TARGETS=false` rejects private targets), DNS-rebinding pin (the validated IP is pinned to the connect), timeout (`timeoutMs`), redirect chain (`maxRedirects`), and the byte cap (`maxResponseBytes`) all apply to the streaming path identically. The `http.request` tool gains the same `bodyMode` / `streamPreviewBytes` input fields when called directly from an `agent` or `tool` node.

## `condition`

Evaluates a sandboxed boolean expression and emits `{ result: boolean }`. Combine with edge `condition` to branch the graph.

Supported operators: `===`, `!==`, `==`, `!=`, `>`, `<`, `>=`, `<=`, `&&`, `||`, `!`, parentheses, string and numeric literals, and dotted paths under `context.*` and `inputs.*`. Anything else is rejected (no arbitrary JS).

```jsonc
{
  "id": "is_ok",
  "type": "condition",
  "config": {
    "expression": "context.fetch_user.output.statusCode === 200"
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

Iterates over `config.items` (array, comma-separated string, or template that resolves to one). For each item, expands `mapping` with `item` and `index` in scope.

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

## `tool`

Invokes a builtin tool from the registry (`http.request`, `text.uppercase`, `json.pick`).

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

## `agent`

Runs a single-agent loop using either the rule-based planner or an OpenAI planner (`config.planner: "rules" | "openai"`). The agent picks tools from the registry and iterates up to `maxSteps` times. With `reflection: true`, each step is followed by a self-check.

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
      { "name": "validator", "role": "QA reviewer", "goal": "uppercase the previous output" }
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

## `ai`

Synthetic AI placeholder. Echoes the prompt and the available context. Replace with an OpenAI/Anthropic call when integrating a real model.

```jsonc
{
  "id": "summary",
  "type": "ai",
  "config": { "prompt": "Summarize the workflow context" }
}
```

**Output:** `{ prompt, contextUsed, response: string }`

## `webhook`

Pauses the run and emits a `node.waiting` event with a `resumeToken` of the form `<runId>:<nodeId>`. Resume with `POST /resume`.

```jsonc
{
  "id": "wait_callback",
  "type": "webhook",
  "config": {}
}
```

**Output (on resume):** the run continues; this node is marked `succeeded`.

## `approval`

Same wait/resume mechanic as `webhook`, intended for human-in-the-loop. The UI surfaces an Approve button under the Runs panel for each waiting node.

```jsonc
{
  "id": "human_approval",
  "type": "approval",
  "config": { "message": "Please review the report and approve to publish." }
}
```

**Output (on resume):** the run continues; node `succeeded`.

## `human_form`

Pauses the run and asks an operator for structured input. The node config carries a small JSON-schema subset; the web renders it as a form, validates submitted values, and resumes the run with the parsed form body as this node's output.

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

---

## Edge conditions

Edges have an optional `condition` that must evaluate to `true` for the target to be queued. Same expression sandbox as `condition` nodes.

```jsonc
{ "from": "is_ok", "to": "shout", "condition": "context.is_ok.output.result === true" }
```

If the condition is `false`, the target is marked `skipped`.
