# Global work-plane cutover runbook — Node.js to Go

This is the candidate transition procedure. [`CUTOVER-MAP.md`](CUTOVER-MAP.md)
defines route families; this document defines traffic ownership, observation,
and rollback. Read-only HTTP families may shadow or move gradually, but the
execution worker and background mutation loops are database-global and move as
one work plane. This runbook is not production-certified until the P0 data,
BullMQ, in-flight-work, and full-browser gates in [`AUDIT.md`](AUDIT.md) pass.

## Environment prerequisites

1. The exact Go candidate passes the complete audit ladder, not only
   `make dual`.
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
   `janusly_go_work_plane_active 0`.
6. The proxy can freeze every mutating route while keeping reads available,
   then switch the complete mutation surface atomically without a deployment.
7. The queue-transition rehearsal has classified and drained BullMQ delayed,
   active, waiting, scheduled, replay-campaign, approval, and timer work. Until
   that rehearsal is recorded, do not switch the work plane.

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
3. Gracefully stop Node API producers, then drain and stop both Node BullMQ
   workers. No producer may remain able to materialize a new job.
4. Remove recurring Node scheduler ownership and drain or explicitly park
   every pre-watermark job according to the rehearsed queue matrix. Do not
   convert jobs by editing Redis or PostgreSQL.
5. Verify zero active Node job, the expected durable PostgreSQL handoff rows,
   and captured database/Redis checkpoints. Any unexplained `running` node
   aborts the switch.
6. Restart the Go candidate with `JANUSLY_GO_WORK_PLANE_ENABLED=true`; require
   `X-Janusly-Work-Plane: active` and `janusly_go_work_plane_active 1` before
   unfreezing traffic.
7. Switch every mutating route to Go, reload the proxy, and unfreeze writes.
8. Within two minutes verify:
   - `GET /healthz` and `GET /health`;
   - one no-op workflow run;
   - `GET /v1/runs` and the Activity UI;
   - no newly eligible Node job exists beyond the recorded watermark;
   - no passive-gate 503 occurred after unfreezing.
9. Record the exact proxy config, binary commit, database/Redis checkpoints,
   queue watermarks, smoke run, and operator.

## First 24 hours

- Public dependency posture: `GET /health`.
- Administrative queue posture: `GET /system/queue`.
- Prometheus and Go runtime signals: `GET /metrics` on the candidate's internal
  loopback port (4601 by default), including goroutines, RSS, queue depth, node
  latency, reaper activity, and degraded rate-limit buckets.
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
   them. Any unexplained active claim aborts rollback.
3. Restart Go passive and require its header/metric to report passive.
4. Restore Node producers and BullMQ workers only after confirming the Go work
   plane is disabled and the rollback queue matrix is satisfied.
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
- No `pnpm migrate` against a goose-provisioned database.
- No force-push, remote `main` update, or production switch based solely on a
  historical green report.
