# Model Context Protocol

Janusly supports both sides of MCP:

1. workflows can consume external MCP tools through `internal/mcpclient`;
2. external agents can inspect and operate Janusly through `cmd/mcp` and
   `internal/mcpserver`.

## Client transports

Connections may use `stdio`, Streamable HTTP, or SSE. Network transports pass
through the outbound HTTP policy, including URL validation, redirect checks,
DNS pinning, byte limits, and timeouts. Stdio connections enforce command and
environment allowlists, bounded lifetime, bounded stderr, and platform resource
limits.

Write-capable external tools require both process consent and tenant consent.
Validation runs suppress write effects.

## Server posture

The server publishes a deterministic catalog of inspect, AI, and write tools.
Descriptors include input validation, stable structured results, risk
annotations, and static write capability. Write dispatch requires
`JANUSLY_MCP_WRITES_ENABLED` plus tenant `mcp.writeConsent`.

The server uses durable Janusly run IDs for asynchronous work. It does not keep
a second task database and never exposes secrets, identity configuration, or
unscoped tenant administration.

See [MCP client architecture](architecture/mcp-client.md) and
[MCP server architecture](architecture/mcp-server.md).
