# AI pipeline

All completion traffic passes through `internal/ai`. API handlers and workflow
executors resolve tenant-safe configuration, budget, model, and output limits
before calling the client.

## Invariants

- Anthropic is the supported completion provider.
- Every call catches provider errors and returns a deterministic fallback.
- Usage recording occurs at the client boundary and cannot fail the call.
- Generated text is bounded before parsing or persistence.
- Workflow generation and patching pass `internal/domain` validation.
- Workflow generation finishes with a deterministic assurance compilation:
  terminal `outputs` form the Intent Contract, and explicit resilience intent
  may add a conservative technical Recovery Contract V1. The compiler never
  invents semantic success criteria or upgrades autonomy.
- Recovery Contract V2 detectors and immutable evaluation fixtures form the
  Qualification Contract. Authored V2 contracts are preserved and must replay
  successfully through the real semantic validator before a draft is returned.
- Keyless fallback templates pass through the same assurance compiler on a deep
  copy; request-specific contracts never mutate the process-global catalog.
- Contract-first authoring compiles an Intent Brief, binds the proposed graph
  to one tenant `CapabilityCatalog`, and only then exposes an explicit Apply to
  the unsaved canvas. Graph binding validates exact built-in/MCP/subworkflow
  identifiers and required configuration; intent binding also rejects silently
  omitted triggers, effects, approvals, and exact requested capabilities.
- `wait_until`, `schedule`, `multi_agent`, `router_llm`, and `subworkflow` are
  proposal-eligible only when the appended catalog lists them and their config
  is complete. Compatibility generation without that catalog keeps descriptive
  noop placeholders.
- Retrieved memory and run evidence are scrubbed and framed as untrusted data.
- Model judgments never grant permissions or direct write authority.
- Semantic recovery always builds a deterministic diagnosis from the detector,
  retained snapshot/contract availability, and aggregate comparable-case
  counts. `internal/aidiagnosis` may enrich only bounded explanatory prose in a
  closed JSON envelope. Candidate kinds, evidence references, validation,
  approval, apply, and verification remain engine-controlled; provider failure
  or absence never blocks recovery.

Terminal run summaries do not spawn request- or worker-owned goroutines.
Completion enqueues one row in `run_summary_memory_jobs`; a supervised sweep
claims jobs with expiring leases, applies bounded retry, and drains an in-flight
claim on shutdown. `memory_entries` has a final unique run-summary key so lease
redelivery is idempotent. Semantic-search reads are tenant-rate-limited before
embedding work.

HTTP surfaces live in `internal/httpapi/aigenerate.go`, `aiassurance.go`,
`aipatch.go`, and `aisurfaces.go`. Workflow AI execution lives in
`internal/executors`.

## Qualification layers

`internal/httpapi/testdata/workflow-assurance-golden.json` remains the focused
provider-free compiler set. The broader
`workflow-assurance-evaluation.json` corpus contains 10 assisted-authoring and
10 semantic-diagnosis cases, balanced EN/ES. Its ordinary test path makes zero
external calls and covers bounded brief questions, typed primitives, exact and
explicitly missing bindings, deterministic diagnosis, malicious evidence,
payload limits, and engine-owned recovery candidate authority.

The opt-in `make qualify-real-provider` profile is deliberately separate from
ordinary tests. With explicit consent and `ANTHROPIC_API_KEY`, it replays the
same 20 cases through the production authoring and diagnosis chokepoints. Hard
breakers allow at most two calls per case, 40 calls globally, USD 3 globally,
and zero SDK retries. The gate requires 20/20 valid bounded envelopes, 20/20
without invented graph capabilities or authority escalation, and at least
18/20 useful under the checked rubric. Evidence records case ID/category,
model, tokens, latency, cost, repair flag, and result only—never prompts or raw
incident evidence—and is checksummed. A green profile proves this bounded
corpus only; it is not production or general model-quality certification.
