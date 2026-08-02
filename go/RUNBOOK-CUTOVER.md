# Per-tenant cutover runbook — Node.js to Go

This is the candidate transition procedure. [`CUTOVER-MAP.md`](CUTOVER-MAP.md)
defines route families; this document defines traffic ownership, observation,
and rollback. It is not production-certified until the P0 data, BullMQ,
in-flight-work, and full-browser gates in [`AUDIT.md`](AUDIT.md) pass.

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
5. The proxy can switch one tenant and route family atomically and can restore
   the previous mapping without a deployment.
6. The queue-transition rehearsal has classified and drained BullMQ delayed,
   active, waiting, scheduled, replay-campaign, approval, and timer work. Until
   that rehearsal is recorded, do not switch a tenant.

## Ownership rule

At every instant, one runtime owns each tenant's entry and scheduler family.
Never run Node and Go schedulers for the same tenant concurrently. During a
gradual cut, the proxy and the queue-drain ledger must agree on the owner; HTTP
routing alone does not transfer already queued work.

## Tenant switch

1. Choose a quiet window with no active rollout or replay campaign.
2. Stop creating new Node jobs for the family and record the drain watermark.
3. Drain or explicitly park every pre-watermark Node job according to the
   rehearsed queue matrix. Do not convert jobs by editing Redis or PostgreSQL.
4. Optionally pause schedule workflows for sensitive tenants. A tick observed
   while paused is deliberately dropped and audited rather than backfilled.
5. Switch the tenant/family matcher to Go and reload the proxy.
6. Within two minutes verify:
   - `GET /healthz` and `GET /health`;
   - one no-op workflow run;
   - `GET /v1/runs` and the Activity UI;
   - no newly eligible Node job exists beyond the recorded watermark.
7. Record the exact proxy config, binary commit, database backup/checkpoint,
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
- Redis/BullMQ must stay flat for the transferred family; growth means Node is
  still producing work and the cut must stop.

Use the reviewed 24-hour series in `conformance/perf/SOAK.md` as a reference,
not as a substitute for candidate-environment observation.

## Rollback

1. Stop new Go entries for the affected tenant/family.
2. Drain Go-owned in-flight work according to the rehearsed state matrix. Keep
   the originating runtime responsible for its claims; do not let the other
   runtime guess how to reap them.
3. Restore the proxy matcher to Node and reload it.
4. Resume Node scheduling only after confirming Go scheduling is disabled for
   that tenant.
5. Verify a Node no-op run and the Activity UI against the restored path.
6. Add the divergence to the dual/browser corpus and complete the post-mortem
   before attempting another switch.

Rollback is not considered proven until it has been executed against
Node-created data, Go-upgraded data, delayed work, and an in-flight run. Shared
PostgreSQL reduces the data-movement cost; it does not by itself prove semantic
rollback compatibility.

## Prohibited shortcuts

- No concurrent Node and Go scheduler ownership for one tenant.
- No direct data edits to make a divergence disappear.
- No `pnpm migrate` against a goose-provisioned database.
- No force-push, remote `main` update, or production switch based solely on a
  historical green report.
