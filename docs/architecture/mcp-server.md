# MCP server

`cmd/mcp` and `internal/mcpserver` expose a stable catalog for external agents.
The catalog order, schemas, risk annotations, and write-capability flags are
part of the public contract. Agent identity, the remote transport and the publish
gate are designed in `agent-platform.md`.

Every tool is tenant-scoped in process and passes the same authority envelope:

- an explicit service-account permission ceiling from
  `JANUSLY_MCP_PERMISSIONS` (the omitted default is read-only);
- an authorized per-tool, per-organization fixed-window rate limit;
- a separate per-tool, per-actor denial bucket, so unauthorized attempts stay
  bounded without consuming the tenant's authorized tool capacity;
- one bounded `mcp.tool.invoked` audit record;
- for business writes, `JANUSLY_MCP_WRITES_ENABLED=true` plus tenant
  `mcp.writeConsent=true`.

Tool requests are explicitly bounded before business parsing and every result
passes a final 256000-byte fail-closed response gate. Expected errors are
secret-scrubbed and truncated. A call rejected before any handler runs, for an
unknown tool name or a schema violation, still fails closed, is denial-rate
limited and is audited with a fixed reason; the caller additionally receives the
tool name and the schema violation, which `tools/list` already exposes. Individual projections remain substantially
smaller where their contract permits it; the global gate is a backstop, not a
pagination substitute.

The permission ceiling is validated before database access or background workers
start. An unknown entry rejects the entire ceiling with a key-only error; invalid
input is never echoed to logs. Omitted permissions retain the read-only default.

The list tools (`workflows.list`, `runs.list`, `dlq.list`) page by keyset:
`limit` defaults to 20 and must be at most 100, and `cursor` must be a
`nextCursor` returned by the previous page. Unlike the HTTP lists, which fall
back to the first page, MCP rejects a malformed cursor or an out-of-range
limit so an agent cannot loop on page one.

`dlq.redrive` revives the run on its original workflow version. Its result
reports that version and the workflow's latest one; when they differ it adds a
hint to start a new run by `workflowId`, because a fix saved after the failure
does not apply to the revived run.

Consent never grants a permission missing from the service-account ceiling.
Long-running operations return durable run IDs that clients poll; the server
does not maintain another task store.

## Agent clients

An agent client is an organization's credential for one external agent,
created by a member through `POST /agent-clients` (`agents.write`) and listed
with `GET /agent-clients` (`agents.read`). The token (`jly_agent_…`) is shown
once at creation or `POST /agent-clients/{id}/rotate`; only its SHA-256 digest
is stored. `POST /agent-clients/{id}/revoke` ends it. Only the creator or an
admin may rotate or revoke, and service tokens can manage none.

A client carries a capability ceiling (`read`, `propose`, `test`, `publish`,
`operate`, `report`; `read` is always included), an optional scope of workflow
ids and tags, an expiry of at most 90 days and a per-minute call limit of at
most 600. A person can grant only capabilities whose permissions they hold.

`cmd/mcp` with `JANUSLY_AGENT_TOKEN` resolves the token on every call, so
revocation, expiry and the creator's removal take effect on the next request.
Each call then runs with:

- the client's organization; nothing in a request can name another;
- the tools its capabilities reach; `tools/list` shows only those, and
  `workflows.save` and `workflows.propose` are in none of them;
- the ceiling's permissions intersected with the creator's current ones, so a
  demoted creator's client loses the matching tools;
- for a scoped client, only workflows it lists or that carry one of its tags,
  and their runs, dead letters and recovery cases. Lists filter in SQL, and
  anything outside the scope answers with the same text as a missing id.
  `operations.brief` is organization-wide, so a scoped client is refused it;
  `catalog.describe` lists only its subworkflows;
- the per-client limit, before the per-organization tool limits.

Every call writes one `mcp.tool.invoked` row as `agent:<clientId>` with the
client, the creator (`onBehalfOf`) and the transport; rows written by the work
it causes carry the same actor with mode `agent`. A run an agent starts records
the creator as an `agent` run actor, so they count as a requester of its tool
approvals. `agent.info` describes the client, its tools, its effective and
missing permissions, scope, expiry and limit, and needs no business permission.

## Catalog

The stable catalog contains 24 tools:

- agent: `agent.info`;
- authoring: `catalog.describe`, `workflows.validate`;
- workflow: `workflows.list`, `workflows.get`, `workflows.assure`,
  `workflows.propose`, `workflows.save`, `workflows.rollback`,
  `workflows.deactivate`, `workflows.reactivate`;
- run: `runs.list`, `runs.status`, `runs.inspect`, `runs.output`,
  `runs.start`, `runs.cancel`;
- dead letter: `dlq.list`, `dlq.redrive`;
- operations: `operations.brief`;
- semantic recovery: `recovery.cases.inspect`,
  `recovery.cases.diagnose`, `recovery.cases.validate`,
  `recovery.cases.apply`.

There is deliberately no recovery approval tool. Approval is an independent
human action created only through authenticated UI/API. `recovery.cases.apply`
can consume a valid one-use approval, but cannot create or renew it.

`operations.brief` accepts any contributing read scope (`recovery.read`,
`runs.read`, or `dlq.read`) and returns the exact deterministic top-three read
model used by Home. Ranking, targets and evidence are identical; its
`allowedActions` are intersected with the MCP catalog so every advertised
action is actually callable. In particular, a diagnosed case points back to
the composite `recovery.cases.diagnose` tool for candidate creation, DLQ
inspection maps to `dlq.list`, and human-only approval actions are omitted.
`workflows.propose` compiles a bounded Intent Brief and binds either a
caller draft or the provider-free template to the exact tenant capability
catalog. Its result contains node id/type summaries and assurance evidence.
With `includeDocument: true` it also returns the bound draft, scrubbed of
secret-shaped literals, so an agent can validate and save it. The draft is the
caller's own document or a template filled with capability names the catalog
already exposes; it is never a saved workflow.

`catalog.describe` lets an agent author without repository docs. The index and
the `nodes`, `tools`, `triggers` and `subworkflows` sections require
`workflows.read`; `nodes` gives the document shape and a validated example per
executable step type, and `tools` lists names unless `tool` selects one entry
with its input fields. The `credentials` section requires `credentials.read`
and returns credential names, kinds and status plus exposed external MCP tools,
never secret material.

`workflows.validate` (`workflows.read`) runs the same structural gate as
`workflows.save`, plus readiness, and saves nothing. Tenant bindings, whose
alternatives name credentials, are added only when the ceiling also holds
`credentials.read`. Every
issue carries a message and a suggestion. `workflows.save` and `runs.start`
return the same JSON report as their `isError` text when they reject a
document, so one call shows every problem.

`runs.start` accepts either a document or a `workflowId`. A `workflowId` runs
the active workflow's latest immutable version, bound exactly as if that
document had been sent. `idempotencyKey` shares the HTTP start's per-tenant key
space: a retry with the same key returns the first run with `replayed: true`.

`workflows.save` calls the same canonical atomic engine append as HTTP. It does
not allocate `MAX(version)+1` independently, persist raw caller JSON, or skip
schedule reconciliation; concurrent API and MCP writers therefore share one
ordered immutable history.

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

`workflows.get` (`workflows.read`) and `runs.output` (`runs.read`) are the two
tools that put saved tenant data into a model's context. `workflows.get`
returns one active workflow's document, either the latest or an exact version,
plus up to 20 versions and its schedules with `nextFireAt`. `runs.output`
returns a run's declared output and its steps' outputs. Both remove
secret-shaped literals before returning, but that removal is shape-based: a
secret written in clear text in an unusual format, or business data in a step
output, reaches the model as is. Each output value is bounded to 32000 bytes and
replaced by its size beyond that. `workflows.assure`, `runs.inspect` and the
recovery tools keep their withheld projections.

`workflows.rollback`, `workflows.deactivate` and `workflows.reactivate`
(`workflows.write`) and `runs.cancel` (`runs.cancel`) call the same engine
operations as the HTTP rollback, trash, restore and cancel routes. They are
business writes, so they also need write consent, and deactivate and cancel are
annotated destructive.

Never expose credential material, identity secrets, organization-wide security
settings, or unbounded raw evidence through MCP.
