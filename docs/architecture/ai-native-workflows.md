# AI-native workflows

## Product thesis

AI is a first-class operator interface for Janusly, not a sidecar chat box.
The system can draft workflows, explain behavior, review readiness, and
propose repairs, but every AI-produced artifact still flows through schema
validation, engine validation, audit logging, and human/operator action before
it changes production behavior.

## Current AI surfaces

| Surface | Route / module | Current behavior |
| --- | --- | --- |
| Generate workflow | `POST /ai/generate-workflow` | Creates a draft workflow from an operator prompt. Default mode is `free_json`: `LlmClient.generateText({ responseFormat: "json" })` -> `parseGeneratedWorkflow` -> noop promotion -> `sanitizeAiWorkflow` -> strict engine validation. Graph-validity failures get up to two targeted repair attempts via `repairGeneratedWorkflow` before deterministic fallback. |
| Explain workflow | `POST /ai/explain-workflow` | Produces a human-readable walkthrough of a workflow; fallback returns local deterministic content. |
| Review workflow | `POST /ai/review-workflow` | Runs deterministic readiness checks plus an optional LLM semantic pass; invalid or unconfigured LLM paths still return a structured fallback review. |
| Patch failed workflow | `POST /ai/patch-workflow` | Recovery-dialog surface. Reads DLQ/run context, asks for 1-3 config or structural alternatives, merges each candidate, validates through the same workflow gate, sorts by confidence, and returns legacy + multi-suggestion fields. It never saves or replays by itself. |
| Suggest improvement | `POST /ai/suggest-improvement` | Compare-panel sibling of patch-workflow for non-DLQ workflow improvement suggestions. |
| Explain run | `POST /ai/explain-run` | Answers questions about a run using compact evidence from run events, nodes, DLQ, recovery items, and bounded recalled recovery snippets when memory is enabled. |
| Health | `GET /ai/health` | Reports the effective tenant runtime config (`enabled`, provider/model/generation mode) without exposing credentials. |

All routes live in `apps/api/src/routes/ai-routes.ts`. Provider calls route
through `packages/ai/src/llm-client.ts`; API keys still come from env, while
safe tenant choices such as provider/model/limits come from `org_configs`.

## Provider posture

LLM completions are provider-neutral in code but Anthropic-only in the current
MVP release posture. Use `anthropic/claude-haiku-4-5-20251001` for demos,
evals, and release smoke. OpenAI remains registered for future expansion but
is not a supported runtime target until it passes the eval harness and release
verification. Embeddings are separate: memory v1 uses Ollama BGE-m3 when both
global and tenant memory flags are enabled.

## Validation pipeline

AI-generated workflows converge through the same runtime gates used by saved
workflows:

1. Parse / shape-check against the AI generation envelope.
2. Promote supported noop placeholders (`wait_until`, `schedule`) when Pass 2
   can produce a typed config.
3. Sanitize expressions and transform placeholders in `sanitizeAiWorkflow`.
4. Validate the whole graph with `validateWorkflow`.
5. When strict graph validation fails after parsing succeeds, run bounded
   self-repair and re-validate.
6. On any unresolved failure, return `{ mode: "fallback", aiError, ... }`.

Patch and improvement suggestions are also validated after merge. Invalid
candidates are dropped rather than returned to the operator.

## Safety model

AI may:

- draft workflow JSON;
- explain workflows and runs;
- review readiness;
- propose config or structural patches;
- phrase evidence-backed recommendations.

AI must not:

- save a workflow version without the operator choosing to save;
- replay a run with modified behavior without explicit user action;
- reveal secret values or provider-native claims;
- mutate credentials, roles, audit logs, or org config directly;
- bypass `sanitizeAiWorkflow`, `validateWorkflow`, audit rows, budget gates, or
  rate limits.

The Recovery dialog's production path is intentionally multi-step: suggest ->
operator review -> sandbox validation (`POST /dlq/validate-fix`) -> save new
workflow version -> replay. This is the control boundary that keeps AI from
silently changing production behavior.

## Data framing

Prompt inputs that originate from users, workflows, tool descriptions, run
events, DLQ payloads, or remembered snippets are treated as data. Prompts use
explicit boundaries and suspicion framing where third-party or user-authored
text can contain instructions. The MCP-exposure path additionally sanitizes
tool descriptions before they can appear in the generation system prompt.

## Auditing and telemetry

AI mutations audit both success and fallback paths with stable action names
such as `ai.workflow.generated`, `ai.workflow.reviewed`,
`ai.workflow.patch_suggested`, and `ai.workflow.improvement_suggested`.
`usage_events` records LLM calls through the `LlmClient` recorder, including
success/failure metadata. Generate-workflow audit metadata includes
`generationMode`, `generationAttempts`, `repairAttempts`, and noop-promotion
counts so operators can see reliability pressure without reading logs.

## Evolution policy

AI-generation changes must remain evidence-driven. Provider expansion, new direct
node emission, and model-routing changes require representative eval coverage,
reliability and quality thresholds, cost evidence, and explicit fallback tests.
Current supported behavior is documented in [`ai-pipeline.md`](ai-pipeline.md);
private planning must not be used as an architectural dependency.
