# AI surfaces

Janusly uses a provider-neutral Go client in `internal/ai`. The supported
completion posture is Anthropic with `claude-haiku-4-5-20251001`; embeddings are
independent and may use self-hosted Ollama.

## Guarantees

- Every provider call is wrapped and returns a deterministic fallback envelope
  on missing credentials, timeout, quota failure, malformed output, or schema
  rejection.
- Provider telemetry is recorded from the central client. A telemetry failure
  never changes the user result.
- Organization recorded-spend thresholds and output limits are checked before
  each provider call. The budget control is not an atomic prepaid reservation:
  concurrent or already in-flight calls can finish above the threshold.
- Prompt context is scrubbed, bounded, and framed as data rather than policy.
- Generated or patched workflows always pass deterministic workflow validation
  before being returned.
- Model output never grants mutation authority. The API, permissions, consent,
  readiness checks, and execution engine remain authoritative.
- Workflow validation and readiness never contact the completion provider or
  episodic-memory embeddings. They exercise only local configuration/schema/
  PromptOps/tool-authority checks, return explicit skipped evidence for AI
  execution, and consume no provider budget or rate admission.

## HTTP surfaces

- `POST /ai/generate-workflow`
- `POST /ai/explain-workflow`
- `POST /ai/review-workflow`
- `POST /ai/suggest-improvement`
- `POST /ai/patch-workflow`
- `POST /ai/explain-run`

The React AI Studio consumes these routes and clearly labels provider-backed
and fallback results.

## Engine surfaces

The `ai`, `agent`, and `multi_agent` workflow task types resolve tenant-safe AI
configuration before calling `internal/ai`. Sequential multi-agent execution
may use the bounded summaries of completed agents; parallel execution may not.

Agents are read-only unless four gates agree: process
`JANUSLY_AGENT_WRITES_ENABLED`, tenant `ai.agentWriteConsent`, node
`allowWriteTools`, and human approval on every path into the node. Safe HTTP
reads are method-sensitive and limited to literal targets already authored in
the node. The planner sees only currently eligible capabilities, and the
executor independently enforces the same boundary.

Provider prompts never receive raw workflow/run structures. Sensitive keys and
resolved values are redacted, literal credential shapes are scrubbed, and
operator/model/external text is labeled as data under a non-overridable system
policy. Janusly template references remain intact because they name a runtime
lookup rather than carrying the secret value.

## Evaluation experiments

The Experiments surface compares a control and candidate against an immutable
snapshot of recovery feedback that was explicitly consented for evaluation.
Datasets may be kept until manual deletion or assigned a 1..3650 day retention
period. The supervised hourly retention sweep deletes an expired dataset and
its raw examples atomically; completed aggregate experiment summaries remain as
non-sensitive evidence.

Every run is advisory and bounded to 20 provider requests, including LLM-judge
calls. SDK retries are disabled. Model comparisons accept only normalized
Anthropic model references; when a real provider is configured, both models
must have complete known pricing before the experiment is admitted. Without a
provider, the run still terminalizes deterministically as inconclusive.

The summary counts generation and judge spend and latency together. An
LLM-judge response must be one finite number in `[0,1]`; invalid or unavailable
judgments retain a deterministic score for diagnosis but mark the comparison
inconclusive. Janusly also refuses to recommend a candidate that produced more
failed outputs than the control. A canceled HTTP request cannot strand a run in
`running`: terminal persistence uses a separate five-second finalization
context and records the failure explicitly.

See [AI pipeline architecture](architecture/ai-pipeline.md) and
[memory policy](memory-policy.md).
