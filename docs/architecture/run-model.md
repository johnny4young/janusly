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

## Agent authority

Agent planning is not an authorization boundary. The dispatcher computes one
per-node write grant from process policy, tenant consent, workflow opt-in, run
mode, and graph-dominating human approval. That grant and the node's exact
literal HTTP target set travel to the executor; the executor rejects a planned
write or a different/dynamic URL even if a provider emits it. Dry-run and
validation modes always suppress writes.

One authorized `agent` node execution owns a single write-attempt lease. A
`multi_agent` crew shares that same lease across every sequential or parallel
child; it does not receive one mutation per child or per `maxSteps`. The lease
is consumed immediately before dispatch and remains spent after validation,
timeout, or an ambiguous transport result. Deterministic planners stop after
the attempt; an AI planner may use remaining steps only for read-side
verification. Another mutation requires a new approved run.

Approval ancestry means dominance, not mere reachability: every path that can
enter a write-enabled agent must cross an approval. Alternate unapproved paths,
missing predecessors, and malformed cycles fail closed. Explicit `http`,
`tool`, and `mcp_tool` nodes remain the preferred representation when the
mutation is known during authoring because their effect, inputs, retries, and
approval topology stay directly inspectable.

## Retry policy

`config.retry` uses one closed grammar at authoring and execution. A present
policy requires `maxAttempts` (the first execution counts as attempt one), with
a range of 1–10. Initial delay is limited to 1–600,000 ms, an authored maximum
to 1–3,600,000 ms, and the scheduler applies the one-hour ceiling even when the
author omits `maxDelayMs`. Backoff is fixed or exponential; jitter is boolean;
retry/ignore matcher lists are bounded. Invalid legacy policy data fails closed
to no retry rather than being partially interpreted.

When a run flips to `failed`, its still-queued siblings go back to `pending`
in the same transaction: a failed run can never claim again, and queued rows
would otherwise sit at the head of the FIFO claim index forever, rejected by
the running-run join on every claim. A redrive re-queues them through the
ordinary readiness pass; cancellation marks its own nodes cancelled.

Wake-ups carry a count: `janusly_wake` notifications and the wake sweeper
say how many nodes just became claimable, and that many workers wake,
rotating through the pool. Waking one worker left a fan-out waiting on the
poll fallback; waking every worker made each start open a claim
transaction per worker. The claim itself is a semi-join over the FIFO
partial index, so a grown `runs` table cannot steer the planner into
walking running runs first.

Outcome transactions (complete, fail, retry, waiting) are compare-and-swap
guarded, so a worker replays one that a lock wait cancelled, a deadlock or
serialization decision lost, or a dropped connection interrupted — up to six
attempts over roughly eight seconds, each counted in
`janusly_outcome_persist_retries_total{op}`. A permanent error still leaves
the node `running` for the stalled-node reaper; a transient one no longer
does.
