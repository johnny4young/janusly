# MCP client

`internal/mcpclient` lets workflow tasks consume external MCP tools over stdio,
Streamable HTTP, or SSE.

Network transports use the shared outbound HTTP policy on every request and
redirect. Stdio uses an operator command allowlist, bounded environment,
lifetime, stderr, working directory, and platform resource limits.

Discovery results are validated and bounded before storage. Tool input and
output pass schema checks. A write-capable tool requires process consent,
tenant consent, and a non-validation run.

## AI authoring exposure

Discovery does not make a tool visible to AI by itself. A connection must be
enabled and opted into `exposeToAi`; each descriptor must independently be
enabled and opted in too. Workflow generation receives only that tenant-scoped
intersection, in stable alias/name order.

The prompt projection is deliberately smaller than the stored MCP descriptor:

- exact prompt-safe connection alias and tool name;
- the administrator-owned `writeSide` classification;
- bounded top-level input field names, primitive types, and requiredness;
- a scrubbed, single-line, bounded description.

Nested schema descriptions, examples, defaults, and arbitrary schema prose are
not sent to the provider. Identifiers that would require lossy sanitization are
omitted rather than presented under a name that could not execute. The whole
catalog is capped and framed as untrusted JSON data. AI may emit an `mcp_tool`
node only for an exact exposed pair; write-side nodes require an upstream human
approval while the existing runtime consent and validation-mode gates remain
authoritative.
