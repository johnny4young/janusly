# Janusly Go operations runbook

`cmd/api` is a single process containing the public API, execution workers,
SSE hub, replay-campaign pump, retention, upstream-health, subworkflow,
schedule, auto-healing, consent-purge, and stalled-node loops. PostgreSQL is
the durable queue and due clock. Redis and BullMQ are not Go runtime delivery
dependencies.

## Requirements

- Go toolchain pinned by `go.mod` (`go1.26.5`).
- PostgreSQL 18 with `pgvector`; no older database major is supported.
- A database migrated by the same candidate binary.

## Core process configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `JANUSLY_GO_DATABASE_URL` | local pilot DSN | PostgreSQL connection |
| `JANUSLY_GO_PORT` | `4600` | public API listener |
| `JANUSLY_GO_INTERNAL_PORT` | `4601` | loopback Prometheus and pprof listener |
| `JANUSLY_GO_WORK_PLANE_ENABLED` | active outside production; passive in production | process-wide ownership of claims, due clocks, and mutation loops |
| `JANUSLY_GO_WORKER_CONCURRENCY` | `8` | node executors, range 1–64 |
| `JANUSLY_GO_API_POOL_SIZE` | `10` | API PostgreSQL pool, range 1–100 |
| `JANUSLY_GO_WORKER_POOL_SIZE` | concurrency + 2 | worker PostgreSQL pool, range 1–100 |
| `JANUSLY_GO_POLL_MS` | `250` | LISTEN/NOTIFY fallback poll, range 50–5000 ms |
| `JANUSLY_GO_HTTP_TIMEOUT_MS` | `30000` | process-level outbound HTTP timeout |
| `JANUSLY_GO_REAPER_INTERVAL_MS` | `60000` | stalled-node reaper cadence |
| `JANUSLY_GO_REAPER_THRESHOLD_MS` | `3600000` | stale claim threshold; keep above the longest valid node runtime |
| `JANUSLY_GO_REAPER_THRESHOLD_FLOOR_MS` | `900000` | expert-only override of the 15-minute safety floor; emits a warning |
| `JANUSLY_GO_SERVE_WEB` | unset | serve the embedded web bundle when `true` |

## Security and provider configuration

| Variable | Purpose |
| --- | --- |
| `JANUSLY_GO_ENV=production` | enables production auth boot checks |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | Supabase authentication mode |
| `ALLOW_DEV_AUTH_HEADERS=true` | explicit production bypass when Supabase is absent; use only in controlled environments |
| `JANUSLY_API_SERVICE_TOKEN` | service-token authentication mode |
| `JANUSLY_RESUME_TOKEN_SECRET` | dedicated HMAC secret for resume, SSO-state, and browser-session tokens; required in production and never shared with the API service token |
| `API_ALLOWED_ORIGINS` | comma-separated concrete browser origins; `*` is ignored in production |
| `JANUSLY_WEB_BASE_URL` | public web URL used to infer the browser session cookie's `Secure` attribute |
| `JANUSLY_SESSION_COOKIE_SECURE=true|false` | explicit override for the session cookie `Secure` attribute |
| `JANUSLY_CREDENTIAL_MASTER_KEY` or `_FILE` | managed credential envelope root key; invalid material fails boot |
| `JANUSLY_MCP_WRITES_ENABLED=true` | process half of MCP server write consent |
| `JANUSLY_MCP_CLIENT_WRITES_ENABLED=true` | process half of external MCP client write consent |
| `JANUSLY_MCP_STDIO_ALLOWED_COMMANDS` | closed stdio command allowlist fallback |
| `ALLOW_PRIVATE_HTTP_TARGETS=true` | disables private-target SSRF protection; development fixtures only |
| `JANUSLY_PRODUCTION_MODE=true` | enforce workflow readiness on `/start` |
| `JANUSLY_REQUIRE_EVAL_COVERAGE=true` | add evaluation-coverage readiness requirements |
| `OTEL_EXPORTER` | `console`, `otlp`, or `none`; unknown values fail startup |
| `OTEL_SERVICE_INSTANCE_ID` | stable process identity for traces and metrics |

Outbound HTTP, email, AI, object-store, and run policies resolve through the
closed organization configuration catalog. Secret values never belong in
organization configuration. Object-store credentials use the standard AWS
credential variables for S3-compatible storage; see `internal/objectstore/`.

## Build, migrate, and run

```bash
cd go
go build -o ./bin/janusly-go ./cmd/api
JANUSLY_GO_DATABASE_URL='postgres://…' ./bin/janusly-go migrate
JANUSLY_GO_DATABASE_URL='postgres://…' ./bin/janusly-go
```

`janusly-go migrate` applies the embedded goose migrations from
`internal/migrate/sql/`. A fresh database receives the complete baseline and
subsequent versions. A pre-goose Node database is transactionally stamped at
the shared baseline before later migrations install the Go-owned runtime
tables, reconstruct durable timer and approval-deadline wakeups, and initialize
enabled schedule due clocks. Serving refuses a database whose version differs
from the exact binary or whose runtime bridge is incomplete. Active serving
additionally applies the ownership rules in `RUNBOOK-CUTOVER.md`; passive
shadow reads remain available until the global work-plane switch.

Do not apply `pnpm migrate` to a goose-provisioned database. The Drizzle journal
is intentionally present but empty, and the Node runner could replay historical
migrations. Do not apply SQL files from the removed `go/migrations/` path; it
was folded into the embedded baseline.

### Work-plane ownership

The execution worker and every background mutation loop operate across the
whole database; they are not tenant-filtered. A production process therefore
defaults to a **passive** work plane until
`JANUSLY_GO_WORK_PLANE_ENABLED=true` is explicit. Passive mode opens only the
API pool, starts no claim/due-clock/reaper/sweep loop, and rejects every unsafe
HTTP method plus the stateful SSO and audited-export GETs with 503 before
handler execution. Safe reads, liveness, health, and preflight remain available
for shadow comparison. Development stays active by default for local
compatibility.

Every public response carries `X-Janusly-Work-Plane: active|passive`; the
internal metric `janusly_go_work_plane_active` is `1` only for an active
owner. The in-process MCP server always owns workers and therefore refuses to
start while the gate is passive. Do not enable two runtimes' work planes
against the same database; follow [`RUNBOOK-CUTOVER.md`](RUNBOOK-CUTOVER.md).

Health endpoints:

- `GET /healthz` on the public port: process liveness.
- `GET /health`: public-safe dependency posture.
- `GET /metrics` on `127.0.0.1:4601`: Prometheus metrics.
- pprof endpoints on the same internal loopback listener.

## Supervisor examples

Minimal systemd service:

```ini
[Unit]
Description=Janusly Go backend
After=network-online.target postgresql.service

[Service]
ExecStart=/usr/local/bin/janusly-go
Environment=JANUSLY_GO_DATABASE_URL=postgres://janusly:…@127.0.0.1:5432/janusly
Environment=JANUSLY_GO_ENV=production
Environment=JANUSLY_GO_WORK_PLANE_ENABLED=true
Restart=on-failure
RestartSec=2
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
```

SIGTERM stops the HTTP listeners, cancels and joins supervised background
loops, flushes tracing, and releases pools within the 10-second process grace.

## Backup, restore, and upgrade

All Go runtime state is in PostgreSQL:

```bash
pg_dump -Fc -d "$JANUSLY_GO_DATABASE_URL" > "janusly-$(date +%F).dump"
pg_restore -d "$JANUSLY_GO_DATABASE_URL" --clean --if-exists janusly.dump
```

After restore, overdue due-clock rows remain durable and are processed when the
loops resume. Stale running claims are failed loudly by the reaper rather than
silently executed twice.

Candidate upgrade procedure:

1. Capture a database backup and the exact old/new binary checksums.
2. Run the new binary's `migrate` subcommand.
3. Replace the binary and send SIGTERM to the old process.
4. Verify `/healthz`, `/health`, the internal metrics endpoint, and a no-op run.

Do not claim schema rollback compatibility merely because migrations are
additive. The audit in `AUDIT.md` requires a Node-created → Go-upgraded → Node
rollback rehearsal before cutover approval. The Redis/PostgreSQL ownership
transfer is a separate gate; follow [`QUEUE-HANDOFF.md`](QUEUE-HANDOFF.md) and
never infer it from an empty-looking queue dashboard.

## Fast diagnosis

| Symptom | First check |
| --- | --- |
| Runs remain `running` | queue metrics, worker logs, and stale-claim age versus the reaper threshold |
| Timers do not fire | latest goose version and rows in `go_pilot_wakeups` |
| MCP writes return 403 | process flag, organization consent, member role, and permission |
| Lists slow down | query-plan gate, table statistics, and the matching keyset index |
| API returns dependency 500s | PostgreSQL reachability and pool budgets; startup never intentionally serves a stale schema |
| Internal port unreachable remotely | expected; it binds to loopback by design |

## Multiple replicas

Workers claim nodes through `FOR UPDATE SKIP LOCKED` plus transition CAS.
Replay campaigns, wakeups, reaping, and bounded maintenance loops use durable
claims, idempotent writes, or CAS settlement. Duplicate empty scans are
tolerated; duplicate effects are not.

Before increasing replicas, budget both API and worker pools against
PostgreSQL `max_connections`. Re-run `make test-ha`, `make failover`, the
connection-baseline test, and the appropriate soak on the exact candidate.
