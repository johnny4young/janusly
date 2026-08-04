# Runtime boundaries

The executable in `cmd/api` composes configuration, provenance, migrations,
PostgreSQL pools, HTTP handlers, workflow execution, maintenance loops, metrics,
and graceful shutdown.

- `internal/domain`: pure workflow validation and decision logic.
- `internal/engine`: durable workflow and recovery lifecycle.
- `internal/executors`: task effects and tool dispatch.
- `internal/store`: SQLC persistence boundary.
- `internal/httpapi`: transport, authz, envelopes, and streaming.
- `internal/boot`: pools, logging, supervision, and lifecycle wiring.

The API and execution engine use separate PostgreSQL pools. Background loops are
supervised and stopped before pool shutdown. A task effect may not bypass the
executor safeguards or persist through HTTP route code directly.
