# AI-native workflows

## Product thesis

AI should be a first-class citizen in the workflow engine, not an optional helper bolted onto the side.

The product should feel easier with AI than without AI:

- Users describe intent in natural language.
- AI proposes workflows, nodes, conditions, retries, credentials, and observability policies.
- Users review diffs before applying changes.
- Runtime failures are explainable and repairable.
- AI can safely suggest, but not silently mutate production workflows without validation and approval.

## Design principles

1. AI is a workflow authoring interface.
2. AI is a runtime debugging assistant.
3. AI is an operations copilot.
4. AI suggestions are always schema-validated.
5. AI changes are represented as diffs and auditable events.
6. AI should learn from run events, DLQ entries, retries, and node outputs.
7. Human approval is required for destructive or production-impacting actions.

## First-class AI surfaces

### 1. Generate workflow

Prompt -> valid workflow JSON.

Use cases:

- “When a webhook arrives, call this API, transform response, then notify Slack.”
- “Create a payment retry workflow with DLQ and alerting.”
- “Build a POS inventory sync workflow.”

### 2. Explain workflow

Workflow JSON -> human explanation.

Should explain:

- trigger
- each node
- branches
- retry/failure behavior
- security concerns
- missing credentials

### 3. Explain failure

Run events + node state + DLQ entry -> failure explanation.

Should answer:

- what failed
- why it likely failed
- whether retry policy was correct
- what config should change
- whether replay is safe

### 4. Suggest fix

Failure context -> validated patch.

Patch examples:

```json
{
  "nodeId": "call-api",
  "patch": {
    "config": {
      "timeoutMs": 10000,
      "retry": {
        "maxAttempts": 5,
        "delayMs": 1000,
        "backoff": "exponential",
        "retryOn": ["timeout", "network", "5xx"],
        "ignoreOn": ["4xx"]
      }
    }
  }
}
```

### 5. Replay with AI patch

AI suggests an override or workflow patch; user reviews and applies.

Never silently replay with modified behavior without explicit user action.

## Runtime context for AI

AI explanations should receive compact context:

```ts
type AiRunContext = {
  workflow: Workflow;
  run: unknown;
  nodes: unknown[];
  events: unknown[];
  deadLetter?: unknown;
};
```

## API proposal

```http
POST /ai/explain-failure
{
  "runId": "...",
  "nodeId": "...",
  "deadLetterId": "optional"
}
```

```http
POST /ai/suggest-fix
{
  "runId": "...",
  "nodeId": "...",
  "deadLetterId": "optional"
}
```

```http
POST /ai/apply-suggested-patch
{
  "workflowId": "...",
  "patch": {...}
}
```

## UI proposal

Add AI actions to the observability and DLQ panels:

- Explain failure
- Suggest fix
- Preview patch
- Apply patch as new workflow version
- Replay after patch

## Safety model

AI may:

- explain
- suggest
- generate draft workflows
- generate patches

AI must not automatically:

- change credentials
- expose secret values
- run production workflows
- replay failed jobs with modified config
- delete workflows or audit logs

## Implementation roadmap

### Phase 1: AI failure explanation

- Add `/ai/explain-failure` endpoint.
- Use existing events, run nodes, run record, and optional DLQ entry.
- Return deterministic fallback when `OPENAI_API_KEY` is missing.
- Add UI button: `Explain failure`.

### Phase 2: AI fix suggestion

- Add `/ai/suggest-fix` endpoint.
- Return a schema-validated patch.
- Show patch preview in UI.

### Phase 3: AI patch application

- Apply patch as a new workflow version.
- Never mutate in place.
- Emit audit event.

### Phase 4: AI operations copilot

- Batch analyze DLQ.
- Identify recurring failures.
- Suggest retry, timeout, credential, and branching improvements.
