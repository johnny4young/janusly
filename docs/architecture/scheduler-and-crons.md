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
