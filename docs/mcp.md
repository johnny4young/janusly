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

Write-capable external tools require both process consent
(`JANUSLY_MCP_CLIENT_WRITES_ENABLED`) and tenant consent
(`mcp.clientWriteConsent`). Validation runs suppress write effects.

Tenant administrators can separately expose an enabled connection and selected
enabled descriptors to AI authoring. Janusly appends only those exact tools to
workflow generation as a bounded, untrusted-data catalog with write posture and
a minimal top-level input schema. This opt-in affects authoring awareness only;
it never bypasses execution consent, rate limits, schema validation, SSRF
controls, or write suppression.

## Server posture

The server publishes a deterministic catalog of inspect, AI, and write tools.
Descriptors include input validation, stable structured results, risk
annotations, and static write capability. Write dispatch requires
`JANUSLY_MCP_WRITES_ENABLED` plus tenant `mcp.writeConsent`.

The server uses durable Janusly run IDs for asynchronous work. It does not keep
a second task database and never exposes secrets, identity configuration, or
unscoped tenant administration.

The read-only `workflows.assure` tool projects the latest version's Intent,
Recovery, and Qualification contract evidence plus deterministic validation and
readiness status. The projection is bounded and excludes the workflow DAG,
configs, credentials, templates, and fixture contents.

See [MCP client architecture](architecture/mcp-client.md) and
[MCP server architecture](architecture/mcp-server.md).
