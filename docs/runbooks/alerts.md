# Alert response

This runbook covers the alert rules in
`deploy/observability/prometheus/rules.yml`. It is operator guidance, not an
automatic repair policy. Use the private Prometheus/metrics plane and the
tenant-scoped Janusly UI; do not paste request bodies, credentials, SQL text,
or tenant data into tickets. The Compose stack and loopback URLs in
[Observability](../observability.md) are for local diagnosis, not a production
deployment recipe.

For every alert, record the firing time, instance/pool/sweep labels, exact
deployed commit/tree, and whether `/readyz` succeeds. Stop the current rollout
until the cause is understood. Check the [recovery boundary](../local-deployment.md#local-postgresql-backup-and-restore)
before rollback: drain the current executable, select only a previously
qualified binary compatible with the **current** baseline/snapshot, and keep
PostgreSQL queue state. Never reset a volume, downgrade the schema, replay
write-capable work, expose port `9464`, or raise the DB pool cap as a generic
response. Escalate immediately on suspected cross-tenant access, credential
exposure, corruption, loss of a compatible binary/snapshot, or an unavailable
identity/key recovery domain. The operator owns incident severity and RPO/RTO;
this repository sets no numeric promise.

<a id="unavailable-metrics"></a>
## Unavailable metrics

**Alert:** `JanuslyMetricsMissing`.

- **Detect/diagnose:** Compare `up{job="janusly"}` in private Prometheus with
  the application's `/readyz` through its normal protected route. Inspect the
  collector target error and private-network route to `9464`; a scrape failure
  alone does not prove the public process is down. Check exact build identity
  from the privileged listener only if that plane is reachable.
- **Mitigate:** Restore collector connectivity if only the scrape path failed.
  If readiness also fails, stop rollout and diagnose database reachability and
  process logs before replacing the instance. Keep the internal listener
  private rather than opening a public metrics port.
- **Rollback/escalate:** Roll back only to a schema-compatible qualified image
  after drain. Escalate if readiness remains down, all replicas are affected,
  or observability cannot be restored safely.

<a id="queue-and-workers"></a>
## Queue and workers

**Alerts:** `JanuslyQueueStalled`, `JanuslyWorkflowQueueWaiting`,
`JanuslyQueueWaitDegraded`, `JanuslyQueueWaitCritical`.

- **Detect/diagnose:** Compare depth and eligible-to-claim wait; retry backoff
  is excluded from the latter. Check worker and pool state before concluding
  that a nonzero depth means starvation:

  ```promql
  max(janusly_queue_depth{job="janusly",state="queued"})
  max(workflow_queue_waiting_jobs{job="janusly"})
  histogram_quantile(0.95, sum by (le) (rate(janusly_queue_wait_seconds_bucket{job="janusly"}[5m])))
  sum by (pool,state) (janusly_db_pool_connections{job="janusly"})
  ```

- **Mitigate:** Stop an in-progress rollout, inspect worker availability and
  PostgreSQL waits, then reduce new ingress through the approved traffic
  control if capacity is genuinely exhausted. Let durable queue polling and
  supervised workers recover; do not delete queue rows or force bulk replay.
- **Rollback/escalate:** Drain and return to a compatible qualified image if
  the regression follows a deployment. Escalate if eligible wait keeps rising,
  durable rows cease progressing, or the database cannot be reached.

<a id="failures-and-rate-limits"></a>
## Failures and rate limits

**Alerts:** `JanuslyTerminalFailures`, `JanuslyWorkflowTaskFailures`,
`JanuslyRateLimiterDegraded`, `JanuslyHTTPServerErrors`.

- **Detect/diagnose:** Check the affected tenant in the authorized Activity/
  recovery UI. A failed or cancelled run can be an expected business outcome;
  identify the error class before retrying. Correlate 5xx by registered route
  pattern and request ID, without logging payloads:

  ```promql
  sum by (pattern,status) (increase(janusly_http_requests_total{job="janusly",status=~"5.."}[5m]))
  sum(increase(janusly_runs_terminal_total{job="janusly",status=~"failed|cancelled"}[5m]))
  max(janusly_rate_limit_degraded_buckets{job="janusly"})
  ```

- **Mitigate:** Fix the failing dependency or roll back the new executable if
  the failure coincides with deployment. The rate limiter deliberately fails
  open on a store error: protect ingress through an approved external control
  if abuse is occurring; do not mistake continued traffic for healthy limits.
  Validate write effects and tenant consent before any replay.
- **Rollback/escalate:** Use the compatible binary/snapshot boundary above.
  Escalate on persistent 5xx, widespread task failures, abuse while limits are
  degraded, or uncertainty about an external write's outcome.

<a id="background-loops"></a>
## Background loops

**Alerts:** `JanuslyFastSweepStalled`, `JanuslyAutoHealingSweepStalled`,
`JanuslyHourlySweepStalled`, `JanuslyDailySweepStalled`,
`JanuslySweepNeverRan`, `JanuslySweepFailing`.

- **Detect/diagnose:** Filter by the `instance` and `sweep` alert labels.
  Compare the last successful pass with recent failure increments and process
  uptime; the never-ran rule waits for the hourly cadence plus margin (the
  daily calibration pass also runs at startup). A missing or stale calibration
  curve leaves AI patch suggestions at raw model confidence, not a fabricated
  calibrated score:

  ```promql
  time() - janusly_sweep_last_success_timestamp_seconds{job="janusly"}
  sum by (instance,sweep) (increase(janusly_sweep_failures_total{job="janusly"}[15m]))
  time() - process_start_time_seconds{job="janusly"}
  ```

- **Mitigate:** Inspect supervised-loop errors and PostgreSQL waits. A healthy
  HTTP probe does not prove a background loop is progressing. Stop rollout or
  restore the last qualified compatible binary after drain when a regression
  is confirmed; do not run maintenance SQL manually without an owner-approved
  procedure.
- **Rollback/escalate:** Escalate when a loop never reports success after the
  startup window, failures repeat across replicas, or recovery would require
  manual mutation of durable queue/state.

<a id="database-pools"></a>
## Database pools

**Alert:** `JanuslyDBPoolStarved`.

- **Detect/diagnose:** Distinguish `api` from `worker` by the alert's `pool`
  label. Look at empty acquisitions and the connection-state split. A
  read-only aggregate from PostgreSQL avoids exposing statement text:

  ```promql
  sum by (pool) (increase(janusly_db_pool_acquires_total{job="janusly",outcome="empty"}[5m]))
  sum by (pool,state) (janusly_db_pool_connections{job="janusly"})
  ```

  ```sql
  SELECT state, wait_event_type, wait_event, count(*)
  FROM pg_stat_activity
  WHERE datname = current_database()
  GROUP BY state, wait_event_type, wait_event;
  ```

- **Mitigate:** Find the blocked/slow operation and its owner; preserve the
  separate API and execution pool limits. Lower ingress or roll back a
  confirmed regression after drain. Raising a pool cap blindly can worsen
  PostgreSQL saturation and does not repair lock contention.
- **Rollback/escalate:** Escalate if waiting transactions or connection count
  keep growing, the database nears its own connection ceiling, or safe
  cancellation/rollback cannot be established.
