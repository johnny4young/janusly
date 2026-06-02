# Workflow Examples

Each example below is a complete, runnable DAG. Save it via `POST /workflows/save`, run it with `POST /start`, and inspect with `GET /run?runId=...`.

`dslVersion` is optional in examples because `WorkflowSchema` defaults it to
`"1.0"`; persisted workflows store the defaulted value. `POST /start` accepts
either the flat workflow body shown below or `{ "workflow": <dag>, "input": <payload> }`
when the workflow declares typed `inputs`. In production mode
(`JANUSLY_PRODUCTION_MODE=true`), start also runs the readiness gate and rejects
fail-level issues before `startRun` writes anything.

Pause/resume nodes share one endpoint with different token posture:
`webhook` and `approval` use the legacy `<runId>:<nodeId>` checkpoint coordinate
and rely on authenticated `POST /resume`; `human_form` uses an HMAC-signed,
purpose-bound `resumeToken` because submitted form values become node output.
`POST /run/cancel` flips the run and still-open nodes to `cancelled`; a worker
job already in progress may finish its current executor, but the runtime will
not enqueue downstream work after cancellation.

---

## 1. Fetch + transform + uppercase tool

```json
{
  "id": "github-uppercase",
  "name": "Fetch GitHub user and uppercase login",
  "nodes": [
    {
      "id": "fetch_user",
      "type": "http",
      "config": {
        "url": "https://api.github.com/users/octocat",
        "method": "GET",
        "headers": { "Accept": "application/vnd.github+json" }
      }
    },
    {
      "id": "shape",
      "type": "transform",
      "config": {
        "mapping": {
          "raw": "{{context.fetch_user.output.body}}",
          "ok": "{{context.fetch_user.output.ok}}"
        }
      }
    },
    {
      "id": "shout",
      "type": "tool",
      "config": {
        "tool": "text.uppercase",
        "input": { "value": "octocat status: {{context.fetch_user.output.statusCode}}" }
      }
    }
  ],
  "edges": [
    { "from": "fetch_user", "to": "shape" },
    { "from": "shape", "to": "shout" }
  ]
}
```

**Sample run output (final node):**
```json
{ "tool": "text.uppercase", "result": { "value": "OCTOCAT STATUS: 200" } }
```

---

## 2. Conditional branch on HTTP status

```json
{
  "id": "guarded-fetch",
  "name": "Branch on HTTP success",
  "nodes": [
    { "id": "fetch", "type": "http", "config": { "url": "https://api.github.com/repos/anthropics/anthropic-cookbook" } },
    { "id": "is_ok", "type": "condition", "config": { "expression": "context.fetch.output.statusCode === 200" } },
    { "id": "happy", "type": "noop", "config": {} },
    { "id": "rescue", "type": "noop", "config": {} }
  ],
  "edges": [
    { "from": "fetch", "to": "is_ok" },
    { "from": "is_ok", "to": "happy", "condition": "context.is_ok.output.result === true" },
    { "from": "is_ok", "to": "rescue", "condition": "context.is_ok.output.result === false" }
  ]
}
```

When `fetch` succeeds, `rescue` is marked `skipped` and `happy` runs. Inverted on failure.

---

## 3. Loop fan-out

```json
{
  "id": "fanout-greetings",
  "name": "Loop over a list",
  "nodes": [
    {
      "id": "fanout",
      "type": "loop",
      "config": {
        "items": "alice,bob,carol",
        "mapping": { "greeting": "Hello {{item}}", "position": "{{index}}" }
      }
    }
  ],
  "edges": []
}
```

**Output:**
```json
{
  "count": 3,
  "items": [
    { "greeting": "Hello alice", "position": "0" },
    { "greeting": "Hello bob",   "position": "1" },
    { "greeting": "Hello carol", "position": "2" }
  ]
}
```

---

## 4. Single agent using rules planner

```json
{
  "id": "uppercase-agent",
  "name": "Single agent uppercase",
  "nodes": [
    {
      "id": "writer",
      "type": "agent",
      "config": {
        "name": "writer",
        "role": "Content writer",
        "goal": "uppercase this text",
        "value": "Workflow Engine",
        "planner": "rules",
        "maxSteps": 2,
        "reflection": true
      }
    }
  ],
  "edges": []
}
```

The rules planner sees the word "uppercase" in the goal and selects `text.uppercase`. The agent emits step events the UI renders in the **Multi-agent timeline** panel.

---

## 5. Sequential multi-agent step (analyzer → validator)

```json
{
  "id": "agents-analyze-validate",
  "name": "Two-agent multi-agent step",
  "nodes": [
    {
      "id": "agents",
      "type": "multi_agent",
      "config": {
        "mode": "sequential",
        "aggregation": "last",
        "continueOnError": false,
        "agents": [
          {
            "name": "analyzer",
            "role": "Data analyst",
            "goal": "uppercase the input value",
            "value": "raw data 42",
            "planner": "rules",
            "maxSteps": 2
          },
          {
            "name": "validator",
            "role": "QA reviewer",
            "goal": "uppercase the analyzer output",
            "value": "{{previousAgents.0.result.finalAnswer}}",
            "planner": "rules",
            "maxSteps": 2,
            "reflection": true
          }
        ]
      }
    }
  ],
  "edges": []
}
```

Run this and open the **Multi-agent timeline** in the UI to see analyzer and validator lanes side by side.

---

## 6. Human approval gate

```json
{
  "id": "approval-gate",
  "name": "Pause for human approval",
  "nodes": [
    { "id": "begin",   "type": "noop",     "config": {} },
    { "id": "publish", "type": "approval", "config": { "message": "Approve to publish to production" } },
    { "id": "done",    "type": "noop",     "config": {} }
  ],
  "edges": [
    { "from": "begin",   "to": "publish" },
    { "from": "publish", "to": "done" }
  ]
}
```

Run starts, `publish` enters `waiting`. The UI shows an "Approve publish" button under **Runs**. Clicking it issues `POST /resume {runId, nodeId:"publish"}` and the rest of the DAG completes.

---

## 7. Workflow using an environment secret placeholder

```json
{
  "id": "secret-call",
  "name": "Call API with env-backed secret",
  "nodes": [
    {
      "id": "call",
      "type": "http",
      "config": {
        "url": "https://api.example.com/v1/me",
        "method": "GET",
        "headers": { "Authorization": "Bearer {{secret.EXAMPLE_API_TOKEN}}" }
      }
    }
  ],
  "edges": []
}
```

`{{secret.EXAMPLE_API_TOKEN}}` resolves at render time from `process.env.EXAMPLE_API_TOKEN`. This is a direct environment-backed placeholder. Operator-managed `credentials` rows are separate: `POST /credentials` stores a credential name/kind plus a `secretRef` env-var name, and integration tools then reference the credential by its operator-facing name.

---

## End-to-end smoke (curl)

```bash
# 1. Save
curl -s -X POST http://localhost:3001/workflows/save \
  -H "Content-Type: application/json" \
  -H "x-org-id: default" -H "x-user-id: dev-user" \
  -d @docs/examples/github-uppercase.json

# 2. Start
RUN=$(curl -s -X POST http://localhost:3001/start \
  -H "Content-Type: application/json" \
  -H "x-org-id: default" -H "x-user-id: dev-user" \
  -d @docs/examples/github-uppercase.json)
RUNID=$(echo "$RUN" | jq -r .runId)

# 3. Inspect
curl -s "http://localhost:3001/run?runId=$RUNID" \
  -H "x-org-id: default" -H "x-user-id: dev-user" | jq .
```
