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

## `multi_agent` (crew)

Runs a crew of agents. Modes:

- `sequential` — agents run in order, each can read the previous results from `previousAgents`.
- `parallel` — agents run concurrently with `Promise.allSettled`.

Aggregation strategies for the final answer: `last` (default), `first`, `all`, `best-effort`.

```jsonc
{
  "id": "crew",
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

---

## Edge conditions

Edges have an optional `condition` that must evaluate to `true` for the target to be queued. Same expression sandbox as `condition` nodes.

```jsonc
{ "from": "is_ok", "to": "shout", "condition": "context.is_ok.output.result === true" }
```

If the condition is `false`, the target is marked `skipped`.
