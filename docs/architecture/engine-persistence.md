# Engine persistence

Run, task, event, waiting, scheduling, recovery, and deployment state is durable
in PostgreSQL 18. `internal/engine` owns lifecycle ordering; `internal/store`
owns generated SQL access.

Critical transitions use transactions or compare-and-set predicates. A claim
must match its generation before completion can write output. Cancellation,
resume, replay, and timeout delivery cannot overwrite a newer terminal state.

Run events are appended in lifecycle order and published after durable writes.
LISTEN/NOTIFY is only a wake-up path; readers always recover truth from tables.
Persisted payloads are bounded and scrubbed before storage.

Workflow version appends are engine operations too. HTTP and MCP both submit a
parsed workflow to the same canonical writer, which serializes on the workflow
parent and commits inherited reliability plus schedule reconciliation with the
new immutable version. Transport-specific persistence is forbidden because it
would create different concurrency and activation semantics for the same
business action.
