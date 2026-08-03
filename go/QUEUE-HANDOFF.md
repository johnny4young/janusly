# BullMQ work-plane handoff contract

This is the executable queue supplement to [`RUNBOOK-CUTOVER.md`](RUNBOOK-CUTOVER.md).
It is pinned to the Node compatibility oracle
`d26e273a9bfbb42b8326142ccb0765f3f6f0442c`. Go never consumes BullMQ. A
handoff is therefore a transfer of durable ownership, not a payload migration
or a proxy-only route change.

## Closed queue inventory

| Queue | Node owner | Recurring scheduler ownership |
| --- | --- | --- |
| `workflow-nodes` | engine worker | dynamic `schedule:<orgId>:<workflowVersionId>:<nodeId>` workflow schedules; rolling-upgrade copies of maintenance schedulers may also be present |
| `maintenance-jobs` | low-concurrency engine maintenance worker | identity, memory, audit, SCIM, workflow retention, upstream health, confidence calibration, stalled-node, waiting-checkpoint, queue-publication, subworkflow-terminal, rollout, and replay-campaign reconcilers |
| `alerts-system` | API alerts worker | `system:alerts-scanner` |
| `auto-healing-system` | API auto-healing worker | scanner and watcher |

The live gate also performs a bounded read-only scan of the default BullMQ
`bull:*:meta` namespace. A fifth queue, a deprecated repeatable row that is not
the compatibility projection of a current Job Scheduler, an unknown scheduler,
or an unknown open job fails closed. The gate never edits Redis keys directly.

## Open-job matrix

| Queue/job | Node to Go | Go to Node | Durable reason |
| --- | --- | --- | --- |
| `workflow-nodes/execute-node` | **drain; any open delivery blocks** | an exact delivery or `run_nodes.queue_publication_repair_after` is required | Node claims only BullMQ deliveries; Go claims PostgreSQL rows |
| `workflow-nodes/wait-resume` | park | park | `state_json.waiting.wakeAt` plus `go_pilot_wakeups(reason=wait_until)` is authoritative; Node delivery is idempotent |
| `workflow-nodes/approval-deadline-arm` | park only after the node is an exact durable bounded approval | park | the migrated approval checkpoint and `approval_timeout` wakeup own the deadline |
| `workflow-nodes/approval-timeout` | park only when its `deadlineAt` matches the durable generation | park | exact deadline CAS makes stale delivery a no-op |
| `workflow-nodes/schedule-trigger` | **must disappear with scheduler retirement** | none before Node boot | a stale cron tick could duplicate Go's `schedule_entries.next_fire_at` clock |
| `workflow-nodes/replay-campaign-step` | park | park | campaign status, `next_dispatch_at`, and item claims are in PostgreSQL |
| recognized maintenance trigger on `workflow-nodes` | park | park | rolling-upgrade compatibility; handlers are scan/idempotency bounded |
| `maintenance-jobs/memory-bulk-purge-trigger` | park | park | both runtimes re-read consent; Go also owns the durable purge sweep |
| other recognized `maintenance-jobs` trigger | park | park | the database scan is authoritative and another invocation is idempotent |
| recognized alerts/auto-healing trigger | park | park | each handler re-reads current durable state and policy |
| any active job | **block** | **block** | a runtime still owns an in-flight delivery |
| any unknown open job or scheduler | **block** | **block** | absence of a reviewed durability/idempotency contract |

Completed and failed BullMQ history is bounded debugging evidence, not open
work, and is not removed by the handoff gate.

## Shared rollback outbox

While Go owns execution, every transition into `run_nodes.status='queued'`
maintains the reference runtime's existing publication envelope:

- `queue_publication_generation` increments for each physical generation;
- `queue_publication_repair_after` is `now` for ready work;
- a retry stores the exact Go wakeup instant in
  `queue_publication_repair_after`;
- a successful Go claim clears the marker.

This costs no extra round trip: the marker rides the same insert/update that
changes node status. On rollback, Node's existing queue-publication reconciler
waits until the marker is due, publishes the deterministic BullMQ job, and
clears the marker only after Redis accepts it. Therefore a future retry is not
fired early and a Go-created root/downstream/redrive is not stranded. The next
Go migration removes a spent private retry wakeup after Node has consumed that
generation.

## Commands

Install the frozen workspace dependencies once in the isolated candidate
worktree, then set `REDIS_URL` plus one of
`JANUSLY_HANDOFF_DATABASE_URL`, `JANUSLY_GO_DATABASE_URL`, or `DATABASE_URL`.

```bash
# Read-only, bounded, double-sampled Node -> Go gate.
make -C go queue-handoff HANDOFF_DIRECTION=node-to-go

# After all Node API producers are stopped. This removes only reviewed Job
# Schedulers through BullMQ's public API and refuses any unknown ownership.
node go/conformance/queue-handoff.mjs retire-schedulers \
  --confirm-node-producers-stopped \
  --output=/secure/operator-evidence/schedulers-retired.json

# Read-only pre-rollback gate while Go is passive and Node is still stopped.
make -C go queue-handoff HANDOFF_DIRECTION=go-to-node

# Isolated destructive rehearsal: temporary database + ephemeral Redis only.
make -C go queue-handoff-rehearsal
```

`--max-rows` defaults to 10,000 and is hard-capped at 100,000. Exceeding the
bound, changing queue identities/counts across the before/after snapshots, or
finding more durable rows than the bound produces a red verdict. Raise the
bound deliberately; never interpret a truncated inventory as empty.

## Node to Go gate order

1. Freeze every mutating ingress and record its watermark.
2. Stop Node API producers, alerts, and auto-healing producers.
3. Gracefully close the workflow and maintenance workers; wait for active
   BullMQ jobs and PostgreSQL `running` claims to reach zero.
4. Retire schedulers with the reviewed command above. It performs no removal
   if any unknown queue/scheduler/repeatable is present.
5. Drain every `execute-node` job and every materialized `schedule-trigger`.
   Delayed retries must wait for Node or be resolved by ordinary operator
   policy; deleting or firing them early is not a handoff.
6. Run the exact Go candidate's `migrate` command while Go remains passive.
7. Run the `node-to-go` gate. A pass proves zero scheduler, active delivery,
   executable Node delivery, running claim, queued executable row, malformed
   waiting bridge, or unarmed enabled schedule.
8. Capture the JSON report and database/Redis checkpoints, then activate Go.

The parked allowlist is deliberately small: timer, approval, replay campaign,
consent purge, and idempotent system scan deliveries. Do not broaden it merely
to make a red inventory green.

## Go to Node rollback order

1. Freeze mutating ingress and gracefully stop Go. Keep Go responsible for its
   claimed work until PostgreSQL has zero `running` node.
2. Restart Go passive and verify its header/metric before starting Node.
3. Run the `go-to-node` gate. Every queued row in a running run must have either
   an exact BullMQ generation or the shared publication marker. Retry marker and
   Go wakeup instants must be identical.
4. Start the Node worker/API. Its boot registration recreates workflow and
   system schedulers; its queue-publication reconciler republishes Go-created
   ready work immediately and retries only when their marker becomes due.
5. Before unfreezing, wait one publication-reconciler interval for already-due
   markers, require no unexplained active claim, then run a Node no-op workflow
   and inspect Activity.
6. Restore mutating routes to Node and unfreeze. Keep the captured Go wakeup
   table until the next candidate migration performs reviewed spent-clock
   cleanup; do not edit it manually.

## Rehearsal acceptance

`run-queue-handoff-rehearsal.mjs` must prove all of the following in resources
it creates and destroys itself:

1. schedulers, an executable job, a queued row, a schedule tick, an unknown
   job/scheduler, and an unknown fifth queue all produce a red initial gate;
2. scheduler retirement refuses the unknown inventory with zero scheduler
   removals;
3. reviewed scheduler retirement covers all four queues;
4. after execution drain, timer, approval, campaign, and memory-purge jobs may
   remain parked and the Node-to-Go gate is green;
5. a Go retry mirrors its deadline, and Node's real reconciler does not publish
   it early;
6. after the deadline, Node publishes and accepts the exact generation;
7. the next Go migration removes the Node-consumed retry clock; and
8. the final Node-to-Go gate is green again.
