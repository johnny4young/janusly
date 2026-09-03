# Workflow task types

The task grammar is defined in `internal/domain`, rendered by
`internal/grammar`, and executed by `internal/executors`.

## Core types

| Type | Purpose |
| --- | --- |
| `noop` | Deterministic pass-through task. |
| `transform` | Build an output object from templates. |
| `condition` | Choose downstream paths with the bounded expression grammar. |
| `router` | Select a candidate path with deterministic routing policy. |
| `loop` | Map data or execute a bounded per-item tool call. |
| `http` | Call an HTTP endpoint through the shared SSRF-safe client. |
| `tool` | Invoke a registered integration tool. |
| `mcp_tool` | Invoke a tenant-configured external MCP tool. |
| `ai` | Produce bounded model output with fallback. |
| `agent` | Run a bounded planner/tool loop. |
| `multi_agent` | Run bounded specialist agents sequentially or in parallel. |
| `approval` | Pause until an authorized operator resumes the run. |
| `human_form` | Pause for schema-validated structured input. |
| `schedule` | Register a workflow schedule. |
| `trigger` | Define event-driven entry behavior. |
| `subworkflow` | Start a bounded child workflow. |

## Universal safeguards

- Task configuration is validated before a workflow can be saved.
- Retries and timeouts are bounded.
- Write effects are suppressed during validation replay.
- Persisted payloads are size-bounded and redact secret-shaped values.
- Loop work has item, concurrency, and failure-budget limits.
- Waiting tasks use signed, purpose-bound tokens and compare-and-set completion.
- HTTP and MCP network requests retain DNS and redirect policy through every
  connection attempt.
