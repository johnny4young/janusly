# Observability Operations Guide

Janusly exposes OpenTelemetry traces and Prometheus metrics from the API and
worker. The starter kit in `deploy/observability` turns those signals into a
usable local dashboard and can forward them to Grafana Cloud without changing
application code.

## What The Signals Answer

| Signal | Janusly source | Use it to answer |
| --- | --- | --- |
| Metrics | API `:9464`, worker `:9465` | Is work queued, failing, retrying, or rate-limit degraded? |
| Traces | OTLP/HTTP exporter | Where did a request or workflow node spend time? |
| Product evidence | Postgres run events, audit logs, DLQ, recovery metrics | What happened to this tenant, run, or recovery action? |
| Logs | API/worker stdout | What did one process report around an incident? |

Metrics and traces are infrastructure signals. They complement, rather than
replace, Janusly's tenant-scoped evidence in Postgres. The starter kit does not
collect logs in order to keep the first deployment small and inexpensive; use
the container or process manager's bounded log retention until centralized
logs are justified.

## Recommended Starting Point

- **One machine or development:** use the local profile. It is self-contained,
  easy to inspect, and stores seven days of metrics plus 24 hours of traces.
- **A small public deployment:** use Grafana Cloud Free with the cloud Alloy
  profile. Alloy remains under your control and forwards only the telemetry you
  configure. Review current plan limits before relying on it for production.
- **Regulated or offline deployment:** start from the local profile, move the
  named volumes to durable storage, add authentication/TLS in front of
  Grafana, and tune retention to your policy.

The images are intentionally pinned. Upgrade them as a reviewed change rather
than following mutable `latest` tags.

## Local Quick Start

1. Make the API and worker metrics endpoints reachable from Docker Desktop:

   ```env
   OTEL_METRICS_HOST=0.0.0.0
   OTEL_EXPORTER=otlp
   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces
   ```

   Do not set a shared `OTEL_METRICS_PORT` in the root `.env`: the API and
   worker deliberately default to different ports (`9464` and `9465`).

2. Start the telemetry services, then restart Janusly so it reads the env:

   ```bash
   pnpm observability:up
   pnpm dev
   ```

3. Open <http://127.0.0.1:3000/d/janusly-operations>. The provisioned
   **Janusly Operations** dashboard shows target health, workflow and
   maintenance pressure, failures, retries, and node latency. Grafana is bound
   to loopback; the local admin login is `admin` / `janusly-local` unless
   `GRAFANA_ADMIN_PASSWORD` is set before startup.

4. Inspect the pipeline at <http://127.0.0.1:12345>, Prometheus at
   <http://127.0.0.1:9090>, and Tempo through Grafana Explore.

5. Stop the telemetry services without deleting their volumes:

   ```bash
   pnpm observability:down
   ```

`OTEL_METRICS_HOST=0.0.0.0` is needed here because Alloy runs in another
network namespace. Do not expose ports `9464`/`9465` on an untrusted network;
prefer a private container network, host firewall, or loopback when the
collector runs beside the processes.

## Grafana Cloud Profile

Copy the non-secret template and fill values from your Grafana Cloud stack:

```bash
cp deploy/observability/cloud.env.example deploy/observability/cloud.env
docker compose \
  --env-file deploy/observability/cloud.env \
  -f deploy/observability/compose.cloud.yml up -d
```

`cloud.env` is ignored by Git. Use a scoped access-policy token with only the
metric-write and trace-write permissions required by Alloy. The Janusly app
uses the same OTLP settings as the local profile because Alloy still receives
traces on loopback port `4318`. Import
`deploy/observability/grafana/dashboards/janusly-operations.json` into the
cloud stack and select its Prometheus data source.

## Queue Topology And Activation

| Queue | Process | Default | Purpose |
| --- | --- | --- | --- |
| `workflow-nodes` | engine worker | on | Executes customer workflow nodes. |
| `maintenance-jobs` | engine worker | on | Runs retention, health polling, calibration, and durable repair jobs without competing at the BullMQ delivery lane with workflow nodes. |
| `alerts-system` | API | periodic scanner off | Evaluates state-based alert policies. Event-driven alert dispatch remains available when matching policies exist, even while this scanner is off. |
| `auto-healing-system` | API | off | Scans failures and watches supervised repair proposals. |

Enable optional scanners in `.env`, then restart the **API process**:

```env
JANUSLY_ALERTS_ENABLED=true
JANUSLY_AUTO_HEALING_ENABLED=true
```

Redis does not need a restart. The API re-registers deterministic BullMQ
schedulers on boot. Auto-healing also requires `autoHealing.enabled=true` in
the organization's runtime configuration. Automatic application is deliberately
double-gated by `JANUSLY_AUTO_HEALING_AUTO_APPLY=true` and the tenant's
`autoHealing.autoApply=true`; start with supervised proposals instead.

## Retention And Repair Jobs

Retention deletes data after a bounded policy window so operational tables and
storage do not grow forever. Janusly applies separate windows to run events,
audit logs, usage, recovery feedback, memory, processed SCIM events, and
soft-deleted workflows. Tenant policy, legal holds, and bounded batches are
respected; a soft-deleted workflow stays restorable until its configured
deletion window expires.

Repair jobs exist because a Postgres transaction and a BullMQ publication
cannot be committed atomically. A process can crash after durable state is
written but before a Redis job or parent-terminal update is published. Bounded
reconcilers scan durable leases/outbox markers and safely retry those missing
side effects. They are normal reliability machinery, not evidence of known
corruption, and are designed to be idempotent.

## Alerts And Customization

Prometheus loads `deploy/observability/prometheus/rules.yml`. The initial rules
cover missing API/worker targets, sustained workflow or maintenance backlog,
fail-open rate-limit degradation, and node failures. They appear in
Prometheus immediately. To deliver notifications, connect Prometheus to an
Alertmanager or reproduce the rules in Grafana Alerting with a contact point.

Before changing thresholds, observe a normal week and choose values that
represent user impact:

- Workflow queue waiting should be strict because it delays customer work.
- Maintenance waiting can tolerate a wider window because jobs are bounded and
  mostly periodic.
- A degraded rate limiter still allows traffic, but it removes shared-replica
  protection and should be investigated.
- Alert on sustained conditions instead of a single scrape to avoid noise.

Dashboard panels are provisioned from JSON. Edit a copy in Grafana, export it
back to the same path, and run `pnpm observability:check` before committing.

## Configuration Reload And Troubleshooting

Janusly reads process environment at startup. Changing a Janusly env variable
requires restarting the affected API or worker process; changing Alloy,
Prometheus, Tempo, or Grafana configuration requires recreating that service.
Redis and Postgres do not need to be restarted for either operation.

If the dashboard has no Janusly series:

1. Check `http://127.0.0.1:9464/metrics` and `:9465/metrics` on the host.
2. Check Alloy targets and logs with
   `docker compose -f deploy/observability/compose.local.yml logs alloy`.
3. Confirm `OTEL_METRICS_HOST=0.0.0.0` was present when Janusly started.
4. Query `up{job=~"janusly-api|janusly-worker"}` in Prometheus.

If traces are absent, confirm `OTEL_EXPORTER=otlp`, use an endpoint ending in
`/v1/traces`, and generate a new request after restart. The legacy Jaeger
exporter variables are intentionally unsupported; Jaeger deployments should
enable their OTLP receiver and use the same OTLP configuration.
