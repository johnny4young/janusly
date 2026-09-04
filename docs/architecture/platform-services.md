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

Alert rules and the bundled Grafana dashboard name only metric families
scraped from the exact executable during E2E. Node execution latency is
reported in seconds and carries only the bounded `node_type` catalog label.

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
rather than pgx's 30-minute default. The profile also checks the drained runtime
in Chromium at desktop and compact widths, in English and Spanish. Every warmup
and measured phase probes the tenant-scoped operator queue once per second.
Transport failures and malformed snapshots fail the phase immediately; the
explicit degraded envelope `{ "queue": null }` remains distinguishable from an
empty queue but must retain 99.5% availability with no more than six consecutive
unavailable snapshots. The summary preserves each phase's counts, observed
peaks, availability, and longest blackout. Use `JANUSLY_LOAD_WARMUP_DURATION`,
`JANUSLY_LOAD_MEASURE_DURATION`, and `JANUSLY_LOAD_SETTLE_SECONDS` together with
`JANUSLY_LOAD_SMOKE=1` only for a local smoke; post-settle budgets remain visible
but are required only by the default-duration qualification evidence. The load
profile disables console trace export so exporter I/O does not distort the
runtime under test. `JANUSLY_LOAD_QUEUE_PROBE_INTERVAL_SECONDS` exists for
bounded harness tests, but qualification evidence uses the one-second default.

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

Three request buckets sit in front of the most abusable entry points and share
that same store: `POST /v1/start` at 120 per minute per organization,
`GET /auth/sso/start` at 60 per minute per client address, and the
unauthenticated `GET /public/status/{token}` at 60 per minute per client
address. An exhausted bucket answers `429 rate_limited` with a `Retry-After`
header. The client address is the socket peer unless `JANUSLY_TRUSTED_PROXY`
is set. Public status pages are additionally served from a 60-second
in-memory snapshot per token, so a scan costs at most one query set per
minute per page. In production the browser header set also carries
`Strict-Transport-Security`.

Recovery feedback is the durable primary operation. Its optional memory side
effect is owned by `V1Server`, not by request goroutines: a fixed worker pool
(four by default) reads a bounded process queue (256 by default), and every task
has a 15-second deadline. A full or closed queue drops only that optional side
effect; the durable feedback row and successful response remain intact. Logs
contain a closed reason and sampled aggregate count, never tenant, operator,
panic, provider, or memory content.

The internal listener publishes accepted, dropped, failed, active, queue-depth,
and duration metrics under `janusly_feedback_memory_*`. Shutdown first closes
HTTP intake, then drains accepted tasks. If the five-minute drain deadline is
reached, it cancels active work and explicitly discards queued work, joining all
owned workers before PostgreSQL pools close.

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
