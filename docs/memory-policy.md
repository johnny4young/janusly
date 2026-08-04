# Runtime memory policy

Janusly memory is an optional, tenant-controlled aid for workflow generation,
recovery suggestions, and operator context. It is never an authorization or
policy source.

## Gates

Memory is active only when both conditions are true:

1. `JANUSLY_MEMORY_ENABLED=true` for the process;
2. the organization enables memory and at least one allowed memory kind.

When either gate is closed, recall and commit paths return without provider
calls or storage writes.

## Storage and retrieval

Memory rows are organization-scoped in PostgreSQL 18. Embeddings default to
Ollama BGE-m3 when configured. Recall is bounded by kind, count, similarity,
and workflow scope. Raw secret-like material is scrubbed before storage.

Recalled text is framed as untrusted data. It cannot override permissions,
write consent, workflow validation, recovery policy, or system instructions.

## Retention and audit

Consent revocation schedules durable deletion. Retention sweeps delete expired
entries, and memory creation, recall failure, purge, and consent changes are
auditable without logging recalled content or credentials.

See `internal/memory`, `internal/engine/memorypurge.go`, and
`internal/httpapi` memory routes.
