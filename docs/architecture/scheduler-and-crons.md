# Scheduling and maintenance

Schedules are durable PostgreSQL rows evaluated by supervised loops in the
Janusly process. Workflow deletion disables scheduling; restoration rebuilds
active schedule state from the latest workflow version.

Approval and form deadlines use generation-bound durable checkpoints. A stale
deadline cannot overwrite manual resume, cancellation, or a newer deadline.

Maintenance covers retention, stalled-task reaping, recovery campaign pacing,
subworkflow reconciliation, memory consent purge, upstream health, and
supervised auto-healing. Every loop is bounded, restartable, and drains during
shutdown.

## Concurrency posture

Each scheduled tick is identified by its logical due time and keyed through
run-start idempotency, so a lease that expires mid-batch, a crash before the
clock advances, or a second process claiming the same entry all resolve to one
run. Auto-healing candidates, replay-campaign items, upstream health sources,
and alert dispatches are claimed before their work begins rather than after,
and post-commit effects belong to the transaction that won its compare-and-set.

## Stalled-node reaping

A node still `running` past the reaper threshold (`JANUSLY_REAPER_THRESHOLD_MS`,
default one hour, floor fifteen minutes) is failed into the dead-letter queue.
The posture is deliberate — a node is never re-executed behind an operator's
back — but it has an operational consequence worth stating: a legitimately slow
node that exceeds the threshold is dead-lettered **while it is still running**,
and its late completion loses the compare-and-set, so the real output is
discarded and the run stays failed. Set node `timeoutMs` below the reaper
threshold for steps that can legitimately run long, or raise the threshold for
that deployment.
