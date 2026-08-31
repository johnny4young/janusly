# Observability

Janusly exposes metrics and build identity on one internal listener. The default
address is `127.0.0.1:9464`; it is not part of the public API.

## Metrics

Important series include:

- `janusly_queue_depth`
- `janusly_queue_wait_seconds` (histogram from durable eligibility to claim;
  retry backoff is excluded)
- `janusly_runs_terminal_total`
- `janusly_rate_limit_degraded_buckets`
- `workflow_queue_waiting_jobs`
- `workflow_queue_active_jobs`
- `maintenance_queue_waiting_jobs`
- `maintenance_queue_active_jobs`
- workflow task duration, retry, and failure metrics
- `janusly_sweep_pass_seconds`,
  `janusly_sweep_last_success_timestamp_seconds`, and
  `janusly_sweep_failures_total`, labeled from a closed catalog of the nine
  supervised maintenance loops
- `target_info` with service and instance identity

The public `/health` response exposes only bounded safe status. Detailed
operational state and Prometheus output stay on protected surfaces.

## Traces

`OTEL_EXPORTER` accepts:

- `console` for local structured trace output;
- `otlp` for OTLP/HTTP export;
- `none` to disable trace export.

Use `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` for an explicit trace endpoint and
`OTEL_SERVICE_INSTANCE_ID` for stable instance labeling.

## Local stack

```bash
docker compose -f deploy/observability/compose.local.yml up -d
```

The stack contains Alloy, Prometheus, Tempo, and Grafana. Alloy scrapes
`host.docker.internal:9464`. On platforms where a container cannot reach the
host loopback listener, set `JANUSLY_INTERNAL_HOST=0.0.0.0` only while the
collector network is protected.

Local endpoints:

- Grafana: <http://127.0.0.1:3000>
- Prometheus: <http://127.0.0.1:9090>
- Tempo: <http://127.0.0.1:3200>
- Alloy: <http://127.0.0.1:12345>

## Grafana Cloud

Copy `deploy/observability/cloud.env.example` to the ignored `cloud.env`, fill
the Cloud metrics and trace credentials, then run:

```bash
docker compose \
  --env-file deploy/observability/cloud.env \
  -f deploy/observability/compose.cloud.yml up -d
```

Set `JANUSLY_METRICS_ADDRESS` when the runtime is not reachable at
`host.docker.internal:9464`.

## Railway private collector

Use `deploy/observability/alloy/railway.alloy` for a separate Alloy service.
Set Janusly `JANUSLY_INTERNAL_HOST=0.0.0.0`, but publish only port `3001`; set
Alloy `JANUSLY_METRICS_ADDRESS` to the Janusly private DNS address on `9464`.
The internal listener includes pprof and build identity in addition to metrics,
so it is part of the privileged operator plane and must not have a public
domain. `make qualify-private-metrics-local CONFIRM=reset
IMAGE=janusly:qualification` proves the equivalent container-network boundary
without contacting Grafana Cloud.

## Alerting

`deploy/observability/prometheus/rules.yml` alerts on missing runtime metrics,
eligible queue-wait latency, terminal/task failures, maintenance delay,
degraded rate limiting, repeated sweep failures, and sweep liveness grouped by
cadence. The never-ran rule waits for the slowest hourly loop plus margin and
counts each scrape instance independently, so startup and multiple replicas do
not create false pages. Dashboard and alert metric families are checked against
a scrape from the exact executable by the executable E2E suite.
