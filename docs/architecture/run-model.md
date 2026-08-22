# Run model

A run binds one organization, workflow snapshot, workflow version, resolved
input, creation actor, and execution mode. Tasks move through durable queued,
running, waiting, and terminal states.

Workers claim eligible tasks with bounded concurrency. Claims carry generation
identity; completion uses compare-and-set predicates. Downstream work becomes
eligible only after the upstream terminal write commits.

PostgreSQL notifications wake workers and SSE readers. Polling and table state
remain authoritative after missed notifications or process restarts.

Edges gate downstream eligibility. A conditional edge skips its target when
the expression is falsy. An on-error edge inverts the gate: it fires only when
its source node fails terminally. A failure with at least one on-error route
is handled — the run continues down the error branch, the success branch is
skipped as not taken, and no dead letter or recovery case is produced. A
failure without an on-error route fails the run and dead-letters, unchanged.
