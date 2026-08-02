# Janusly Go backend

This directory contains the complete Go replacement candidate for Janusly's
Node.js backend. It uses PostgreSQL-native claims and due clocks for execution,
serves the legacy and `/v1` HTTP contracts, embeds the production web bundle,
and includes the API, workers, recovery loops, MCP server, admin CLI, migration
runner, and deterministic demo seeder.

Implementation waves are complete. Independent certification is active in
[`AUDIT.md`](AUDIT.md); until its exit criteria pass, "implemented" does not
mean "approved for production cutover". The Node implementation remains on
`nodejs-legacy` as the compatibility and rollback oracle.

Read next:

- [`AUDIT.md`](AUDIT.md) — certification status and findings.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — runtime design and ADRs.
- [`RUNBOOK.md`](RUNBOOK.md) — build and operations.
- [`RUNBOOK-CUTOVER.md`](RUNBOOK-CUTOVER.md) and
  [`CUTOVER-MAP.md`](CUTOVER-MAP.md) — candidate transition procedure.
- [`PLAN.md`](PLAN.md) and [`JOURNAL.md`](JOURNAL.md) — historical execution
  record.

## Quick start

```bash
make db-up       # PostgreSQL 18 on 127.0.0.1:4632
make migrate     # apply embedded goose migrations
make verify      # generate/drift, build, lint, unit, integration, parity
make run         # API + supervised background workers on :4600
```

Additional gates include `make ci`, `make test-pg15`, `make dual`,
`make test-ha`, `make failover`, `make chaos`, `make fuzz`, and
`make bench-hostile`. See the audit ledger before interpreting a historical
green result as current evidence.

## Binaries

| Command | Purpose |
| --- | --- |
| `cmd/api` | HTTP API, migration subcommand, workers, and supervised system loops |
| `cmd/mcp` | in-process MCP stdio server |
| `cmd/admin` | API-driven redrive, schedule, credential, and run operations |
| `cmd/contract` | checked-in OpenAPI generation |
| `cmd/seed` | deterministic demo organization through public API routes |
| `cmd/loadgen` | cross-backend load generation |

## MCP server

`cmd/mcp` exposes eight tools over stdio:

- `workflows.save`
- `workflows.list`
- `runs.start`
- `runs.status`
- `runs.inspect`
- `runs.list`
- `dlq.list`
- `dlq.redrive`

The process executes workers in-process, so runs progress without a separate
worker service. Writes require both `JANUSLY_MCP_WRITES_ENABLED=true` and the
organization's durable MCP consent. Expected validation, not-found, consent,
and replay conflicts return MCP `isError` results rather than terminating the
session.

```bash
go build -o /usr/local/bin/janusly-go-mcp ./cmd/mcp
```

Example client configuration:

```json
{
  "mcpServers": {
    "janusly-go": {
      "command": "/usr/local/bin/janusly-go-mcp",
      "env": {
        "JANUSLY_GO_DATABASE_URL": "postgres://janusly:janusly-go-local@127.0.0.1:4632/janusly_go",
        "JANUSLY_GO_WORK_PLANE_ENABLED": "true",
        "JANUSLY_GO_ORG": "default"
      }
    }
  }
}
```

Because this MCP process runs its own workers, enable it only when the shared
work plane is already owned by Go, never during Node ownership or passive
shadowing.

## Core configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `JANUSLY_GO_DATABASE_URL` | local pilot DSN | PostgreSQL connection |
| `JANUSLY_GO_PORT` | `4600` | public API listener |
| `JANUSLY_GO_INTERNAL_PORT` | `4601` | loopback metrics and pprof listener |
| `JANUSLY_GO_WORK_PLANE_ENABLED` | active outside production; passive in production | explicitly own queue claims, due clocks, and mutation loops |
| `JANUSLY_GO_WORKER_CONCURRENCY` | `8` | executor goroutines, range 1–64 |
| `JANUSLY_GO_POLL_MS` | `250` | LISTEN/NOTIFY fallback poll, range 50–5000 ms |
| `JANUSLY_GO_ORG` | `default` | MCP server organization scope |
| `JANUSLY_GO_SERVE_WEB` | unset | serve the embedded web bundle when `true` |

Security, auth, integration, object-store, tracing, and per-organization
configuration are documented in [`RUNBOOK.md`](RUNBOOK.md) and the relevant
architecture documents.
