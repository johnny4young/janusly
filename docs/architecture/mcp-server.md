# MCP server

`cmd/mcp` and `internal/mcpserver` expose a stable catalog for external agents.
The catalog order, schemas, risk annotations, and write-capability flags are
part of the public contract.

Inspect and AI tools are tenant-scoped through the Janusly API. Write tools are
advertised and dispatched only when process and tenant consent both allow them.
Long-running operations return durable run IDs that clients poll; the server
does not maintain another task store.

`workflows.assure` is the read-only Workflow Assurance surface. It inspects the
latest immutable version of one active, tenant-scoped workflow and returns
bounded evidence for:

- Intent Contract input/output field names;
- Recovery Contract version, autonomy, semantic mode, evidence level, effects,
  and approval posture;
- Qualification Contract detector/fixture counts and deterministic fixture
  replay outcome;
- structural validation and readiness status with bounded issue codes.

It never returns the DAG, node configuration, templates, credential references,
fixture payloads, provider output, or raw evidence. This makes it useful to an
agent deciding whether a workflow is safe to operate without turning MCP into
an alternate unbounded workflow-export API.

Never expose credential material, identity secrets, organization-wide security
settings, or unbounded raw evidence through MCP.
