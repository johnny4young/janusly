# MCP client

`internal/mcpclient` lets workflow tasks consume external MCP tools over stdio,
Streamable HTTP, or SSE.

Network transports use the shared outbound HTTP policy on every request and
redirect. Stdio uses an operator command allowlist, bounded environment,
lifetime, stderr, working directory, and platform resource limits.

Discovery results are validated and bounded before storage. Tool input and
output pass schema checks. A write-capable tool requires process consent,
tenant consent, and a non-validation run.

Connection `envRefs` use one closed
`Record<string, { kind: "env", name: string }>` contract, capped at 64 entries
and 64 KiB. Creation canonicalizes that shape; execution, discovery, workflow
readiness, and credential health all decode it through the same parser.
Malformed persisted references never disappear into an apparently
credential-free connection: calls and readiness fail closed, while the health
inventory marks the connection unhealthy. Tenant-scoped database failures are
errors, not empty-success readiness projections. Error payloads may identify
the operator-owned reference key but never the deployment environment-variable
name or its value.

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
authoritative. CapabilityCatalog discovery retains database failure as an
explicit degraded warning rather than silently presenting an empty MCP set;
the lower-level prompt enrichment path remains fail-closed and empty on the
same failure.
