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
- Retrieved memory and run evidence are scrubbed and framed as untrusted data.
- Model judgments never grant permissions or direct write authority.

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

`internal/httpapi/testdata/workflow-assurance-golden.json` is the provider-free
golden set for deterministic compilation. It covers single and multiple intent
outputs, English and Spanish resilience intent, conservative effect
classification, authored output preservation, and preservation of the
qualified V2 flagship.

The opt-in `make qualify-real-provider` profile is deliberately separate from
ordinary tests. With explicit consent and `ANTHROPIC_API_KEY`, it runs one
Janusly product-generation case through the real system prompt, parse/repair
ladder, assurance compiler, domain validator, and readiness gate. The test has
a local hard ceiling of two Anthropic calls, zero SDK retries, a USD 1 maximum,
redacted logs, measured token/cost accounting, and checksummed evidence. A
green provider profile proves that bounded case only; it is not a general model
quality or production-readiness certification.
