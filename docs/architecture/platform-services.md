# Platform services

The Janusly executable owns public HTTP, React assets, run streaming, workflow
execution, maintenance, and metrics.

Run streaming is SSE delivered through authenticated `fetch` and
`ReadableStream`. Events are read from durable PostgreSQL state and notification
channels, with bounded reconnect cursors.

The internal listener exposes Prometheus metrics and verified build identity on
`127.0.0.1:9464` by default. Public health returns only safe bounded status.
When a separate collector runs on a managed platform, bind the listener to
`0.0.0.0` only inside that platform's private service network and publish no
host/public route for `9464`. The listener also carries build identity and
pprof, so peers able to reach it belong to the privileged operator plane.

## Local load and soak qualification

`make qualify-local PROFILE=load CONFIRM=reset` runs the deliberately long,
isolated load qualification. It is not part of `PROFILE=all`: the explicit
profile runs three sequential scenarios with 2-minute warmups and 20-minute
measurements, then allows six minutes for pools and goroutines to settle. The
stack binds only to loopback, uses a Compose project whose name starts with
`janusly-qualification-`, runs without Supabase or provider credentials, and
enables development auth headers only for this disposable profile.

The executable load generator retains a fixed-size atomic latency histogram,
caps response bodies, and refuses non-loopback targets without an additional
opt-in. Qualification fails on request errors, undrained queues, p95/p99 latency
budgets, a 512 MiB peak RSS ceiling, or post-settle growth beyond the recorded
RSS, heap, goroutine, and PostgreSQL-connection baselines. Burst PostgreSQL
connections become eligible for retirement after five idle minutes and are
checked every 30 seconds, so the post-settle comparison measures steady state
rather than pgx's 30-minute default. The profile also checks the
drained runtime in Chromium at desktop and compact widths, in English and
Spanish. Use `JANUSLY_LOAD_WARMUP_DURATION`,
`JANUSLY_LOAD_MEASURE_DURATION`, and `JANUSLY_LOAD_SETTLE_SECONDS` together with
`JANUSLY_LOAD_SMOKE=1` only for a local smoke; post-settle budgets remain visible
but are required only by the default-duration qualification evidence. The load
profile disables console trace export so exporter I/O does not distort the
runtime under test.

The measured p95/p99 ceilings are 1.5/5 seconds for start-to-terminal, 750/1500
milliseconds for the 50-VU shared-tenant run list, and 2/5 seconds for the
diamond workflow. The list load includes the real centralized membership,
policy, role, and permission boundary on every request; the smoke baseline must
remain below the ceiling rather than replacing it with an unauthenticated query
benchmark. The gate reuses the membership literal already resolved for the
request instead of performing duplicate membership reads for rank and
permission checks.

Rate limits and workflow queue state are PostgreSQL-backed so multiple Janusly
instances share one durable view. A store error keeps the documented fail-open
traffic posture while emitting degradation evidence.

Each process heartbeat uses one boot-unique instance identity. PostgreSQL keeps
the detailed instance/build/concurrency rows for platform telemetry, while the
tenant-admin `/system/workers` route returns only `healthy`, `degraded`, or
`unhealthy`; global replica topology never crosses the tenant boundary.

The opt-in weekly operations digest is also multi-replica safe. One leased
`org_digest_state` batch records each successful admin recipient before the
provider call moves on. Partial failures release the lease with backoff and a
later sweep resumes only the remaining recipients; a completed batch is not
eligible again for 167 hours. Custom roles inheriting `admin` are recipients,
and large recipient sets are continued in bounded batches instead of silently
truncated.
