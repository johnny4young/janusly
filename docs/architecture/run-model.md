# Run model

A run binds one organization, workflow snapshot, workflow version, resolved
input, creation actor, and execution mode. Tasks move through durable queued,
running, waiting, and terminal states.

Workers claim eligible tasks with bounded concurrency. Claims carry generation
identity; completion uses compare-and-set predicates. Downstream work becomes
eligible only after the upstream terminal write commits.

Eligible tasks are claimed oldest-first by the durable `run_nodes.enqueued_at`
clock, with the stable row ID used only to break timestamp ties. Every
transition into `queued` refreshes that clock; a retry writes its future
wake-up instant, so the clock always means **eligible since** rather than
merely **row entered queued**. A partial index over
`(enqueued_at, id)` contains only queued rows, so claim cost follows live queue
depth rather than accumulated terminal history. The claim still checks the
wake-up row as defense in depth, but queue health and wait latency remain
correct after the due wake-up row is cleaned up.
Janusly does not currently expose priority or named-lane policy: adding either
requires an operator-facing service contract and load evidence first.

PostgreSQL notifications wake workers and SSE readers. Polling and table state
remain authoritative after missed notifications or process restarts.

Edges gate downstream eligibility. A conditional edge skips its target when
the expression is falsy. An on-error edge inverts the gate: it fires only when
its source node fails terminally. A failure with at least one on-error route
is handled — the run continues down the error branch, the success branch is
skipped as not taken, and no dead letter or recovery case is produced. A
failure without an on-error route fails the run and dead-letters, unchanged.
