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
- Retrieved memory and run evidence are scrubbed and framed as untrusted data.
- Model judgments never grant permissions or direct write authority.

HTTP surfaces live in `internal/httpapi/aigenerate.go`, `aipatch.go`, and
`aisurfaces.go`. Workflow AI execution lives in `internal/executors`.
