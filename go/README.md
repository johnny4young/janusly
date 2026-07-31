# Janusly Go pilot

The Go engine pilot: own Postgres-native queue (`run_nodes` IS the queue),
executable node subset, v1 API shaped against reference goldens, and an MCP
stdio server exposing the operator loop to agents.

Start here: [`PLAN.md`](PLAN.md) (source of truth), [`JOURNAL.md`](JOURNAL.md)
(execution journal), [`AGENTS.md`](AGENTS.md) (cross-agent onboarding).

## Quick start

```bash
make db-up      # pgvector Postgres on 127.0.0.1:4632 (project janusly-go-pilot)
make migrate    # reference migrations + pilot go_pilot_* migrations
make test       # unit + integration (needs the DB), race detector on
make parity     # semantic parity F01–F10 against the reference goldens
make run        # API + in-process workers on :4600 (internal :4601)
```

## MCP server (agents operate the engine)

`cmd/mcp` runs an MCP stdio server over the engine **in process** — no HTTP
hop. Six tools: `workflows.save`, `runs.start`, `runs.status`,
`runs.inspect`, `dlq.list`, `dlq.redrive`. Expected failures (validation,
not-found, replay conflicts) come back as `isError` tool results the agent
can read and act on; the process also runs the worker pool, so runs progress
with nothing else up.

Build and register with Claude:

```bash
go build -o /usr/local/bin/janusly-go-mcp ./cmd/mcp
```

`claude_desktop_config.json` (or `claude mcp add` for Claude Code):

```json
{
  "mcpServers": {
    "janusly-go": {
      "command": "/usr/local/bin/janusly-go-mcp",
      "env": {
        "JANUSLY_GO_DATABASE_URL": "postgres://janusly:janusly-go-local@127.0.0.1:4632/janusly_go",
        "JANUSLY_GO_ORG": "default"
      }
    }
  }
}
```

Then ask Claude to, e.g., *"start the doomed workflow, inspect why it
failed, and redrive it once the upstream heals"* — the failure→redrive loop
in `internal/mcpserver/mcpserver_integration_test.go` is exactly that
conversation, scripted.

## Configuration

| Env | Default | Meaning |
| --- | --- | --- |
| `JANUSLY_GO_DATABASE_URL` | local pilot DSN | Postgres connection |
| `JANUSLY_GO_PORT` | 4600 | public API |
| `JANUSLY_GO_INTERNAL_PORT` | 4601 | metrics + pprof (127.0.0.1) |
| `JANUSLY_GO_WORKER_CONCURRENCY` | 8 | executor goroutines (1..64) |
| `JANUSLY_GO_POLL_MS` | 250 | queue poll fallback (50..5000) |
| `JANUSLY_GO_ORG` | `default` | MCP server org scope |
| `ALLOW_PRIVATE_HTTP_TARGETS` | unset | explicit SSRF-posture bypass |
