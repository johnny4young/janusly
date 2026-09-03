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

Memory rows are organization-scoped in PostgreSQL 18 and retain workflow/run
attribution when created from an execution. The implemented
embedding protocol is Ollama, using BGE-m3 by default; Janusly does not expose
provider names it cannot execute. Recall is bounded by kind, count, similarity,
and organization scope. Agent episodes use a same-workflow-first tier before
the database limit, followed by organization-wide semantic matches; ordinary
`vector.search` remains organization-wide and similarity-first. Commit content
and provider-bound queries are limited to
64 KiB; metadata is sanitized and limited to 16 KiB. Oversize text is rejected
rather than semantically truncated. Raw secret-like material and exact
secret/environment values resolved for the current execution are scrubbed
before provider calls, storage, and recall output.

Recalled text is framed as untrusted data. It cannot override permissions,
write consent, workflow validation, recovery policy, or system instructions.

## Retention and audit

Consent revocation schedules durable deletion. Retention sweeps delete expired
entries, and memory creation, recall failure, purge, and consent changes are
auditable without logging recalled content or credentials.

`memory.retentionDaysByKind` is a validated JSON object. Empty means the
defaults below; a partial object overrides only the listed kinds. Unknown
kinds, fractional/non-positive values, and values above the per-kind maximum
are rejected before persistence and ignored defensively if found in a legacy
row.

| Kind | Default days | Maximum days |
| --- | ---: | ---: |
| `recovery_rationale` | 180 | 730 |
| `run_summary` | 90 | 365 |
| `runbook_fragment` | 365 | 36,500 |
| `patch_rationale` | 365 | 730 |
| `generated_workflow` | 365 | 730 |
| `workflow_vector` | 180 | 730 |
| `agent_episode` | 180 | 730 |

Each committed entry resolves the active tenant override for its own kind and
freezes the resulting `retain_until`; later configuration changes affect new
entries, while the retention sweep continues to honor each existing deadline.

See `internal/memory`, `internal/engine/memorypurge.go`, and
`internal/httpapi` memory routes.
