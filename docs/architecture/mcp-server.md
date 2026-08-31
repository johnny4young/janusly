# MCP server

`cmd/mcp` and `internal/mcpserver` expose a stable catalog for external agents.
The catalog order, schemas, risk annotations, and write-capability flags are
part of the public contract.

Every tool is tenant-scoped in process and passes the same authority envelope:

- an explicit service-account permission ceiling from
  `JANUSLY_MCP_PERMISSIONS` (the omitted default is read-only);
- a per-tool, per-organization fixed-window rate limit;
- one bounded `mcp.tool.invoked` audit record;
- for business writes, `JANUSLY_MCP_WRITES_ENABLED=true` plus tenant
  `mcp.writeConsent=true`.

Consent never grants a permission missing from the service-account ceiling.
Long-running operations return durable run IDs that clients poll; the server
does not maintain another task store.

## Catalog

The stable catalog contains 15 tools:

- workflow: `workflows.list`, `workflows.assure`, `workflows.propose`,
  `workflows.save`;
- run: `runs.list`, `runs.status`, `runs.inspect`, `runs.start`;
- dead letter: `dlq.list`, `dlq.redrive`;
- operations: `operations.brief`;
- semantic recovery: `recovery.cases.inspect`,
  `recovery.cases.diagnose`, `recovery.cases.validate`,
  `recovery.cases.apply`.

There is deliberately no recovery approval tool. Approval is an independent
human action created only through authenticated UI/API. `recovery.cases.apply`
can consume a valid one-use approval, but cannot create or renew it.

`operations.brief` returns the exact deterministic top-three read model used by
Home. `workflows.propose` compiles a bounded Intent Brief and binds either a
caller draft or the provider-free template to the exact tenant capability
catalog. Its result contains node id/type summaries and assurance evidence,
not the complete DAG or node configuration.

Recovery diagnose, validate and apply call the same engine operations as HTTP,
including expected-revision CAS, immutable content-addressed artifacts and
transactional audits. Diagnose always has a provider-independent deterministic
path and may add bounded AI prose only when the service-account ceiling also
contains `ai.write` and tenant budget/rate gates allow it. It composes diagnosis
with candidate creation because MCP intentionally exposes neither a separate
candidate mutation nor approval. MCP projections expose diagnosis mode/counts,
not provider prose or stable evidence identifiers.

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
fixture payloads, provider output, or raw evidence. Run inspection likewise
returns only status, attempts, whitelisted redacted error fields, and event
types. Recovery inspection withholds case message/details, transition reasons,
artifact payloads, candidate output/rationale/evidence, and every approval
grant. This makes the surface useful without turning MCP into an alternate
unbounded evidence or workflow-export API.

Never expose credential material, identity secrets, organization-wide security
settings, or unbounded raw evidence through MCP.
