# MCP server

`cmd/mcp` and `internal/mcpserver` expose a stable catalog for external agents.
The catalog order, schemas, risk annotations, and write-capability flags are
part of the public contract.

Inspect and AI tools are tenant-scoped through the Janusly API. Write tools are
advertised and dispatched only when process and tenant consent both allow them.
Long-running operations return durable run IDs that clients poll; the server
does not maintain another task store.

Never expose credential material, identity secrets, organization-wide security
settings, or unbounded raw evidence through MCP.
