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
- Recognized PagerDuty on-call action intent takes a canonical local recipe
  before provider budget or completion calls. The model cannot choose or omit
  its authoritative read, explicit action clock, deterministic policy,
  acknowledge, bounded snooze, read-after-write incident identity,
  acknowledgement, snooze-deadline verification, or evidence topology. A
  requested human approval is bounded and followed by a fresh authoritative
  read, clock, and full policy revalidation before either write. Missing tenant
  credential or user identities remain explicit incomplete bindings. Ambiguous
  time range, timezone, or finite-campaign start keeps the Intent Brief
  incomplete instead of silently authorizing defaults; an explicitly anchored
  relative week is frozen to exact proposal timestamps. For this recognized
  deterministic recipe only, the bounded original source accompanies the
  compiled brief into proposal generation so exact configuration near the end
  of a long prompt cannot be lost to brief-field truncation. Generic/provider
  generation still receives the normalized contract prompt. AI remains
  optional for later explanation.
- Contract-first authoring compiles an Intent Brief, binds the proposed graph
  to one tenant `CapabilityCatalog`, and only then exposes an explicit Apply to
  the unsaved canvas. Graph binding validates exact built-in/MCP/subworkflow
  identifiers and required configuration; intent binding also rejects silently
  omitted triggers, effects, approvals, and exact requested capabilities, plus
  known write effects introduced beyond the brief. Every subworkflow invocation
  is treated as an explicit delegation effect (`subworkflow:<workflowId>`), even
  when the child is currently read-only: an unpinned child may change after the
  proposal and a bounded catalog must not pretend to infer its transitive
  authority. Provider graphs that expand identity or effect authority are
  discarded, not patched. Apply re-reads the
  catalog and refuses a proposal whose binding version is no longer current.
  The server returns the canonical parsed DAG that binding and readiness
  inspected, never the original provider map: normalized identifiers,
  metadata, recovery policy, and editor positions cannot disagree with the
  draft copied by Apply.
  Credential and subworkflow projections are each capped at 200 entries; the
  builder fetches one sentinel row beyond the cap and emits an explicit
  `*_truncated` warning rather than presenting a silently incomplete catalog.
  MCP discovery likewise preserves its bounded sentinel as a visible
  `mcp_tools_truncated` warning, and a discovery failure is distinct from an
  honestly empty opt-in set through `mcp_tools_unavailable`. The UI localizes
  these postures instead of exposing internal warning keys. A proposal request
  carrying a stale catalog version never reaches the provider, budget gate, or
  AI rate bucket: it returns a neutral, explicitly unappliable local proposal
  bound to the current catalog version so the operator can rebuild safely.
- `workflows.propose` keeps an incomplete MCP brief as a bounded clarification
  response with no speculative DAG. A caller-supplied draft may still be
  inspected and bound, but remains unappliable until the brief is complete.
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

Contract-first authoring lives in `internal/httpapi/authoring.go`. Its
compile/proposal operations are canonical versioned routes in OpenAPI and keep
the corresponding unversioned `/ai/...` aliases for existing callers; both
lanes share one core, one strict decoder, and the `ai.write` gate.

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
