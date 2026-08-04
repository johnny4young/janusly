# Run model

A run binds one organization, workflow snapshot, workflow version, resolved
input, creation actor, and execution mode. Tasks move through durable queued,
running, waiting, and terminal states.

Workers claim eligible tasks with bounded concurrency. Claims carry generation
identity; completion uses compare-and-set predicates. Downstream work becomes
eligible only after the upstream terminal write commits.

PostgreSQL notifications wake workers and SSE readers. Polling and table state
remain authoritative after missed notifications or process restarts.
