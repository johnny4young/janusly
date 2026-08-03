# Workflow Examples

Each example below is a complete, runnable DAG. Save it via `POST /workflows/save`, run it with `POST /start`, and inspect with `GET /run?runId=...`.

`dslVersion` is optional in examples because `WorkflowSchema` defaults it to
`"1.0"`; persisted workflows store the defaulted value. `POST /start` accepts
either the flat workflow body shown below or `{ "workflow": <dag>, "input": <payload> }`
when the workflow declares typed `inputs`. In production mode
(`JANUSLY_PRODUCTION_MODE=true`), start also runs the readiness gate and rejects
fail-level issues before `startRun` writes anything.

## Declared settings (`inputs` + `default`)

A declared input with a `default` is how a workflow becomes configurable in one
place. State the value once on the workflow and template it wherever it is
used, instead of repeating a literal across node configs:

```jsonc
{
  "inputs": {
    "type": "object",
    "properties": {
      "workingHoursStart": { "type": "string", "default": "09:00" },
      "workingHoursEnd": { "type": "string", "default": "17:00" },
      "timeZone": { "type": "string", "description": "IANA zone", "default": "Europe/Madrid" }
    },
    "required": ["workingHoursStart", "workingHoursEnd", "timeZone"]
  }
}
```

**Node configs read a declared input as `{{context.input.<name>}}`**, not
`{{inputs.<name>}}` — inside a node the `inputs.` scope means that node's own
config. `{{inputs.<name>}}` does resolve to the run input in workflow-level
`outputs` templates.

`startRun` fills defaults before validating and persists the resolved payload
to `runs.inputJson.input`, so a run record shows the configuration it actually
used even after the workflow's defaults later change. A supplied value always
wins, including an explicit `null` or `false`.

In the web app, pressing **Run** opens a generated form when `inputs` is
declared. Schema keys remain the runtime contract and are never rewritten, but
the form displays readable labels, places required fields first, shows
required/optional state, and requires an explicit Yes/No choice for required
booleans. Optional values without a default remain absent until supplied;
declared defaults are prefilled and still revalidated by `startRun`. API
clients send the original keys in
`{ "workflow": <dag>, "input": <payload> }`.

Defaults are also what make declared inputs usable at all on a trigger-driven
workflow: a webhook or schedule run supplies `{ triggeredBy, event, … }` and
never the declared fields, so a required input without a default would reject
every such run. A `default` that does not match its declared type fails
`validateWorkflow` (`input_default_type_mismatch`) at save time rather than at
the first run.

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

`{{secret.EXAMPLE_API_TOKEN}}` resolves at render time from
`process.env.EXAMPLE_API_TOKEN`. This is a direct deployment-owned placeholder.
Operator-managed `credentials` rows are separate: `POST /credentials` accepts a
managed value by default (or a legacy env-var reference), and integration tools
then reference only the operator-facing credential name.

---

## 8. Prompt-generated PagerDuty off-hours workflow

Create one `pagerduty_api_token` credential and one
`pagerduty_webhook_secret` credential, then enter this in AI Studio:

```text
When PagerDuty alerts user PUSER123 outside working hours 09:00 to 18:00
in America/Bogota, acknowledge it and snooze it for 12 hours. Use API
credential pagerduty-api and webhook credential pagerduty-webhook for
operator@example.com.
```

Janusly recognizes this safety-sensitive intent and compiles it locally; no LLM
key or token budget is required. The generated workflow has strict template
resolution and these visible steps:

```text
PagerDuty incident received
  → Read authoritative incident
  → Evaluate off-hours policy
      ├─ match → Acknowledge incident → Snooze incident → Record action evidence
      └─ no match → Record no-action evidence
```

Save the workflow and select its first node in Step setup. The normal Inspector
shows the derived
`/webhooks/pagerduty/:workflowId/:nodeId` callback. Add that URL to a PagerDuty
V3 webhook subscription. The path is only a selector: Janusly verifies
`X-PagerDuty-Signature` with the node's tenant-scoped signing credential before
persisting the event. Provider retries with the same event id converge on one
run. Add “and create an AI summary” to the prompt only when post-action
enrichment is desired; AI never decides whether acknowledge or snooze is
allowed.

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
