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
Descriptors include input validation, stable structured results, truthful
read-only/destructive annotations, and static write capability. Every call is
permission-checked, rate-limited and audited. `JANUSLY_MCP_PERMISSIONS` is the
explicit stdio service-account ceiling; when omitted it grants only
`workflows.read`, `runs.read`, `dlq.read`, and `recovery.read`. Write dispatch
also requires `JANUSLY_MCP_WRITES_ENABLED=true` plus tenant
`mcp.writeConsent=true`.

The server uses durable Janusly run IDs for asynchronous work. It does not keep
a second task database and never exposes secrets, identity configuration, or
unscoped tenant administration.

The read-only `workflows.assure` tool projects the latest version's Intent,
Recovery, and Qualification contract evidence plus deterministic validation and
readiness status. The projection is bounded and excludes the workflow DAG,
configs, credentials, templates, and fixture contents.

`operations.brief` is the same deterministic top-three read model used by Home.
It accepts any contributing read scope (`recovery.read`, `runs.read`, or
`dlq.read`) and filters each source independently, so a narrow service account
does not need unrelated recovery visibility. Ranking, targets and evidence stay
shared, while `allowedActions` is projected onto the actual MCP catalog: it
never advertises the UI-only candidate or approval endpoints, and a diagnosed
case remains actionable through the composite `recovery.cases.diagnose` tool.
`workflows.propose` performs exact CapabilityCatalog binding without saving a
workflow or returning its complete DAG. Semantic recovery is exposed as bounded
inspect/diagnose/validate/apply tools; apply requires a separately created,
unexpired human approval and the immutable candidate's additional permissions.
Diagnose is deterministic without a provider and can use bounded AI enrichment
only when the explicit MCP permission ceiling includes `ai.write`; candidate
authority remains deterministic. MCP never exposes an approval tool, provider
diagnosis prose, stable evidence identifiers, or active approval grants.

See [MCP client architecture](architecture/mcp-client.md) and
[MCP server architecture](architecture/mcp-server.md).
