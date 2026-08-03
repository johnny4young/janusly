# Global work-plane cutover runbook — Node.js to Go

This is the candidate transition procedure. [`CUTOVER-MAP.md`](CUTOVER-MAP.md)
defines route families; this document defines traffic ownership, observation,
and rollback. Read-only HTTP families may shadow or move gradually, but the
execution worker and background mutation loops are database-global and move as
one work plane. This runbook is not production-certified until the P0 data,
BullMQ, in-flight-work, and full-browser gates in [`AUDIT.md`](AUDIT.md) pass.
The closed four-queue/job matrix, executable commands, and rollback publication
contract live in [`QUEUE-HANDOFF.md`](QUEUE-HANDOFF.md); an operator must use
that gate rather than infer safety from queue depth alone. The exact-candidate
evidence envelopes and record-only aggregate policy live in
[`EXTERNAL-GATES.md`](EXTERNAL-GATES.md).

## Environment prerequisites

1. The exact Go candidate passes the complete audit ladder, not only
   `make dual`. Run `make release-review` from a clean, fetched checkout and
   retain its commit/tree-bound JSON and Markdown manifest; any review blocker
   aborts publication. Remote CI must publish the exact binary with its
   validated release artifact manifest. Every shadow/cutover/canary/rollback
   record must embed machine-collected runtime proof for the matching
   commit/tree/executable digest. A healthy runtime from another checkout is
   not evidence for this candidate.
2. Node and Go are deployed side by side against a rehearsed copy of the same
   PostgreSQL state. Node retains its Redis/BullMQ dependencies while it owns
   any route or queued-work family; Go does not consume BullMQ jobs.
3. Pool totals for every replica fit the PostgreSQL connection budget.
4. Required auth, resume-token, webhook, credential-root, provider, and service
   secrets are available to the candidate without copying secret values into
   organization configuration.
5. Every side-by-side production Go process runs with
   `JANUSLY_GO_WORK_PLANE_ENABLED=false`; safe shadow responses report
   `X-Janusly-Work-Plane: passive` and metric
   `janusly_go_work_plane_active 0`. Capture one passive runtime proof before
   shadow sampling and another after it; their timestamps must span the full
   declared shadow duration.
6. The proxy can freeze every mutating route while keeping reads available,
   then switch the complete mutation surface atomically without a deployment.
7. The exact candidate's `make -C go queue-handoff-rehearsal` is green, and a
   live `node-to-go` gate has classified all four BullMQ queues, discovered no
   fifth queue or legacy repeatable ownership, retired every scheduler, drained
   executable/schedule work, and validated every parked durable delivery.
8. Run the exact candidate's `migrate` subcommand while every Go process is
   passive. It must install the Node runtime bridge, reconstruct every durable
   timer and approval-deadline wakeup, initialize every enabled schedule due
   clock, and finish with no readiness error. The migration is idempotent and
   must run again after Node is quiesced and after correcting any malformed
   legacy checkpoint.
9. The exact candidate must retain green approval-deadline evidence for
   relative and absolute clocks, `fail`, `auto_reject`, and `escalate`, stale
   generation rejection, manual-resume/HA-sweeper races, and continuation of a
   Node-created waiting checkpoint.

## Ownership rule

At every instant, one runtime owns the complete work plane: new run entry,
PostgreSQL node claims, BullMQ delivery, schedules, timers, replay campaigns,
reconcilers, reapers, and maintenance loops. The current Go claim and sweep
queries are intentionally global, so a per-tenant worker split is not a valid
deployment shape. HTTP routing alone does not transfer queued work.

## Global work-plane switch

1. Keep the Go candidate passive and choose a quiet window with no active
   rollout or replay campaign in any organization.
2. Freeze every mutating ingress route at the proxy and record the freeze
   watermark. Safe reads may remain available.
3. Gracefully stop Node API, alerts, and auto-healing producers, then drain and
   stop both engine BullMQ workers. No producer may remain able to materialize
   a new job.
4. Run the reviewed `retire-schedulers --confirm-node-producers-stopped`
   command, then drain every `execute-node` and materialized `schedule-trigger`
   according to [`QUEUE-HANDOFF.md`](QUEUE-HANDOFF.md). Park only the closed
   durable/idempotent allowlist. Do not convert jobs by ad hoc Redis or
   PostgreSQL edits.
5. Run the exact Go candidate's `migrate` subcommand, then restart it passive
   and require its exact-version/runtime-bridge boot gate to pass.
6. Run the double-sampled `node-to-go` gate and capture its JSON. It must report
   zero scheduler, active/executable/schedule delivery, `running`/executable
   `queued` row, malformed waiting bridge, unarmed schedule, unknown queue/job,
   legacy repeatable, truncation, or cross-snapshot movement. Any red verdict
   aborts the switch.
7. Restart the exact CI-built Go artifact with
   `JANUSLY_GO_WORK_PLANE_ENABLED=true`; collect an active runtime proof and
   require its commit, tree, and executable SHA-256 to match the CI manifest
   before unfreezing traffic.
8. Switch every mutating route to Go, reload the proxy, and unfreeze writes.
9. Within two minutes verify:
   - `GET /healthz` and `GET /health`;
   - one no-op workflow run;
   - `GET /v1/runs` and the Activity UI;
   - no newly eligible Node job exists beyond the recorded watermark;
   - no passive-gate 503 occurred after unfreezing.
10. Record the exact proxy config, binary commit, migration version,
    database/Redis checkpoints, queue watermarks, smoke run, and operator.

## First 24 hours

- Keep the `Janusly Go Migration` Grafana dashboard open and treat
  `JanuslyMutationOwnershipOverlap` or `JanuslyNodeBacklogAfterGoActivation` as
  immediate rollback signals; no amount of healthy read traffic overrides a
  split mutation plane.
- Public dependency posture: `GET /health`.
- Administrative queue posture: `GET /system/queue`.
- Prometheus and Go runtime signals: `GET /metrics` on the candidate's internal
  loopback port (4601 by default), including goroutines, RSS, queue depth, node
  latency, reaper activity, and degraded rate-limit buckets.
- Capture an active runtime proof after every 1%, 5%, 25%, 50%, and 100% stage
  soak. The first proof precedes the 1% stage; adjacent timestamps must cover
  the declared soak and every proof must retain the CI artifact digest.
- Tenant DLQ and new failure signatures: `/dlq/counts`, queue read model, and
  recovery clusters.
- Circuit-breaker and operational audits.
- PostgreSQL connections and LISTEN sessions versus the reviewed baseline.
- Redis/BullMQ must stay flat after the work-plane transfer; growth means Node is
  still producing work and the cut must stop.

Use the reviewed 24-hour series in `conformance/perf/SOAK.md` as a reference,
not as a substitute for candidate-environment observation.

## Rollback

1. Freeze every mutating ingress route.
2. Stop the Go HTTP listener and gracefully drain its work plane. Keep Go
   responsible for its `running` claims; do not let Node guess how to reap
   them. Any unexplained active claim aborts rollback. Queued Go generations
   remain recoverable through the shared Node publication markers.
3. Restart Go passive and capture a passive runtime proof for the exact
   artifact being rolled back.
4. Run the `go-to-node` gate while Node is still stopped. Every queued
   generation must have either its exact BullMQ delivery or a durable Node
   publication marker; retry marker and Go wakeup deadlines must match. Restore
   Node producers/workers only after this gate and the passive proof pass.
5. Restore every mutating route to Node, reload the proxy, and unfreeze writes.
6. Verify a Node no-op run and the Activity UI against the restored path.
7. Add the divergence to the dual/browser corpus and complete the post-mortem
   before attempting another switch.

Rollback is not considered proven until it has been executed against
Node-created data, Go-upgraded data, delayed work, and an in-flight run. Shared
PostgreSQL reduces the data-movement cost; it does not by itself prove semantic
rollback compatibility.

## Prohibited shortcuts

- No concurrent Node and Go work-plane ownership for the shared database.
- No per-tenant worker split until both runtimes implement and prove a shared
  tenant ownership fence.
- No direct data edits to make a divergence disappear.
- No manual Redis key deletion or PostgreSQL marker rewrite; scheduler removal
  uses only the reviewed BullMQ command.
- No `pnpm migrate` against a goose-provisioned database.
- No force-push, remote `main` update, or production switch based solely on a
  historical green report.
