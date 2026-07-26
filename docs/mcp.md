# Connecting tools Janusly doesn't ship (MCP)

Janusly ships a deliberately small set of vendor integrations. Counting
distinct third-party services, the built-in tool registry covers **Slack,
GitHub, and PagerDuty** — plus generic building blocks that are not tied to any
vendor: `http.request` and `webhook.send` for arbitrary HTTP APIs, `db.query.*`
for your own PostgreSQL, `vector.*`, `email.send`, `pdf.generate`, and pure
utilities for text, JSON, CSV, time, and hashing.

That is fewer connectors than an integration-first tool, and it is a choice
rather than a backlog. Recovery is the wedge: what Janusly invests in is what
happens when a step fails, not how many logos it can reach. Every integration
in the registry is hand-written through one HTTP chokepoint with no vendor
SDKs, which keeps the safety properties uniform but makes each new vendor real
work.

**MCP is the answer to everything else.** The Model Context Protocol is an open
standard for exposing tools to AI systems, with a large and growing ecosystem
of servers. Janusly is an MCP **client**: register a server once, and its tools
become callable from workflow nodes with the same retry, dead-letter, replay,
and run-timeline behavior as a built-in tool. You do not wait for Janusly to add a
connector, and Janusly does not have to pretend to be a connector marketplace.

> Janusly is also an MCP **server** — that is the opposite direction, letting
> Claude Desktop or Cursor drive Janusly. See the README section "Use Janusly
> from Claude Desktop / Cursor". This document is about the client direction:
> external tools coming *into* your workflows.

---

## Connect a server

Operations → Connections (requires `mcp.connections.write`), or
`POST /mcp/connections`. Three transports:

| Transport | Use when | Shape |
| --- | --- | --- |
| `http` | The server is remote. Canonical per the MCP spec; prefer it. | one HTTPS endpoint |
| `sse` | The server only speaks the legacy transport. | one HTTPS endpoint |
| `stdio` | The server is a local process on Janusly infrastructure. | `command` + `args` |

Registration runs discovery once and caches every advertised tool. Re-run it
from the panel (or `POST /mcp/connections/:alias/rediscover`) when the upstream
server adds tools; existing opt-ins survive.

Secrets never live in workflow JSON. A connection stores `envRefs` — names of
environment variables the runtime resolves at call time and passes to the
server (as HTTP headers for `http`/`sse`, as the child process env for
`stdio`).

> **Note:** MCP `envRefs` are deployment-owned process environment variables.
> They are the one credential surface that does **not** use the encrypted
> tenant Credential Secret Store, because a ref is a plain variable name rather
> than a stored value. Integration-tool credentials do use the store — see
> [`docs/configuration.md`](configuration.md).

## Turn tools on

Discovery is not activation. Every discovered tool lands **disabled**, and
marked `writeSide: true` until an admin says otherwise. Both defaults are
fail-safe: a newly discovered tool cannot run, and if it does run it is treated
as capable of causing external effects (so sandbox replays skip it, and it
needs write consent).

Enable per tool from the panel or
`POST /mcp/connections/:alias/tools/:toolName`. Mark a tool read-only only when
it genuinely has no side effects — that flag is what lets validation replays
exercise it safely.

## Use it in a workflow

An `mcp_tool` node references the connection alias and tool name:

```jsonc
{
  "id": "lookup_customer",
  "type": "mcp_tool",
  "config": {
    "connectionAlias": "crm",
    "toolName": "customer.search",
    "input": { "email": "{{context.on_webhook.output.event.email}}" }
  }
}
```

A failed call becomes a node failure, so it inherits retry, the dead-letter
queue, replay, and run-timeline behavior exactly like a built-in tool. That
uniformity is the point: an MCP tool is not a second-class citizen with its own
error handling.

### Prompt-driven authoring

The generator does not emit `mcp_tool` nodes directly. When a connection opts
into AI exposure, sanitized tool descriptions are added to the generation
prompt as **data**, and the model emits a `noop` placeholder named
`mcp_<alias>_<toolName>`, which a second pass promotes into a real node when
the name uniquely matches an exposed tool. Anything ambiguous stays a
placeholder for you to resolve in the Inspector.

Exposure is opt-in twice — once per connection, once per tool — because tool
descriptions are third-party text reaching an LLM's context. Several
sanitisation layers sit in between; the architecture doc details them.

## What stops a hostile server

Registering an MCP server is granting it a foothold, so the safety posture is
worth understanding before you connect one you did not write:

- **Write consent needs two flags.** `JANUSLY_MCP_CLIENT_WRITES_ENABLED=true`
  (process) **and** `mcp.clientWriteConsent` (tenant). Either false
  and no write-side call proceeds — the gate sits above the transport, so no
  connection is even opened.
- **Remote URLs are SSRF-gated.** `http` and `sse` targets are validated before
  the transport is constructed, rejecting localhost, private ranges,
  link-local, and cloud metadata endpoints.
- **`stdio` runs a process on your infrastructure**, so it is the most guarded:
  the command must appear in an allowlist (`JANUSLY_MCP_ALLOWED_COMMANDS` or a
  tenant override, fail-closed when both are empty), the child's environment is
  rebuilt from scratch rather than inheriting the worker's, each spawn gets an
  ephemeral working directory, and there are lifetime, stderr, and (on Linux)
  memory caps.
- **Per-tool rate limits**, defaulting to 60/min per org and overridable per
  tool.
- **Every call emits start/completion run events and a usage event**, scoped
  per tenant. Administrative connection/tool changes use the audit log.

Two limits worth knowing rather than discovering later. First, the `http`/`sse`
transports validate the URL up front but their TCP connect does not reuse the
pinned DNS dispatcher that `http` nodes use, so deliberate operator
registration is the real perimeter for a rebinding attack. Second, a tool that
vanishes upstream keeps its cached descriptor; workflows calling it fail into
the normal recovery path rather than silently changing behavior.

## When to use what

| You need | Reach for |
| --- | --- |
| A REST API with no MCP server | `http.request` — no registration needed |
| A service with a maintained MCP server | An MCP connection |
| Slack, GitHub, PagerDuty | The built-in tools (narrower inputs, vendor-specific handling) |
| Your own database | `db.query.*` with a `postgres` credential |
| A recurring weekday/time-of-day rule | `time.window`, not a connector |

---

Implementation details — transport internals, the six sanitisation layers,
descriptor lifecycle, audit actions, permission catalog entries — live in
[`docs/architecture/mcp-client.md`](architecture/mcp-client.md).
