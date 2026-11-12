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
with `GET /agent-clients` (`agents.read`), newest first, up to `limit` (at
most and by default 200) per page; `nextCursor` is the opaque `cursor` for the
next page. The token (`jly_agent_…`) is shown
once at creation or `POST /agent-clients/{id}/rotate`; only its SHA-256 digest
is stored. `POST /agent-clients/{id}/revoke` ends it, and so does expiry: an
expired client cannot be rotated. Only the creator may
rotate, the creator or an admin may revoke, and service tokens can manage none.

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
- for a scoped client, only the organization's workflows it lists or that
  carry one of its tags, and their runs, dead letters and recovery cases. Lists filter in SQL, and
  anything outside the scope answers with the same text as a missing id.
  `operations.brief` is organization-wide, so a scoped client is refused it;
  `catalog.describe` lists only its subworkflows, with a catalog version
  computed over what it sees;
- `runs.start` by `workflowId` only, never a document, and an
  `idempotencyKey` that is the client's own;
- the per-client limit, before the per-organization tool limits.

Every call writes one `mcp.tool.invoked` row as `agent:<clientId>` with the
client, the creator (`onBehalfOf`) and the transport; rows written by the work
it causes carry the same actor with mode `agent`. Wherever an agent caused a
call (a start, a redrive, a fix), its creator counts as a requester of the
call's tool approval, so the person accountable for an agent cannot approve its
writes alone. Approval and grant decisions accept only person modes. `agent.info` describes the client, its tools, its effective and
missing permissions, scope, expiry and limit, and needs no business permission.
It is the only tool that may name no permission; for any other tool an empty
permission list denies. A rejected token writes `mcp.auth.rejected` (see
`agent-platform.md`), and a store failure while resolving the agent answers
with fixed text while the detail goes to the server log.

## Publish gate

An agent client never saves a version directly. It reaches production only
through the gate, whose tools return failures as
`{"error": {"code", "message", "path", "fix"}}` or, for a list of problems,
`issues` with the same fields.

1. `drafts.save` (`propose`) stores an immutable draft with its behaviour
   fixtures in `workflow_drafts`. Without a `workflowId` the server assigns
   `wf_<uuid>` to a new workflow; a scoped client needs a scope tag to create
   one, and the published workflow gets that tag. Saving the same document
   and fixtures again returns the existing draft with `unchanged: true`. A
   draft never routes, schedules or triggers anything.
2. `workflows.test` (`test`) runs a draft as a draft-test validation run:
   writes are suppressed, stubs replace the steps they name, and the agent
   reads the run with `runs.status` and `runs.output`. An agent always sees
   the runs it started. Only pure steps run unstubbed: logic, person steps,
   triggers and a fixed list of pure tools (`text.uppercase`, `json.*`,
   `csv.parse`, `csv.filter`, `csv.stringify`, `time.now`, `time.window`).
   Every other step, and any step that mentions a secret or the environment,
   must have a stub (`stub_required`), so nothing an agent wrote reaches
   outside Janusly or reads a secret before a person approves it. 120 draft
   and fixture runs per client per hour.
3. `workflows.qualify` (`test`) records a receipt bound to the draft's digest.
   Static checks come first: structural validation, production readiness
   errors, declared outputs, a Recovery Contract v2 with passing evaluation
   fixtures when any step may write, no write step with `resultPolicy:
   envelope`, at least one behaviour fixture that stubs every step a test may
   not run, no output that reads a secret, no secret-shaped literal in the
   document or the fixtures, and every tool, subworkflow and credential bound
   to the tenant catalog. When
   they pass, each fixture runs as a draft test; `qualifications.get`
   settles the receipt once every run ended, comparing the end status
   (`succeeded`, `failed`, or `waiting` at a person's step) and a subset of
   the declared output, and cancels any judged run still open. Runs still
   going after ten minutes fail. Thirty qualifications per client per hour.
4. `workflows.publish` (`publish`, a business write) takes a passed receipt
   for the same digest, at most 24 hours old; the digest covers the base
   version too. Only a workflow made of pure steps, already published, with
   no output reading a secret, and called by no other workflow, is appended
   at once through the canonical engine save. Anything else opens a publish
   request (`approval_required`) with reasons `first_publish`, `writes`,
   `outbound` (a step that is not pure, triggers included, because a read can
   still carry data out) and `callers` (another workflow calls this one, so
   the change reaches it). A newer request for the same workflow supersedes an
   older one. The engine save compares the draft's base version under the
   workflow lock, so a draft whose workflow gained a version is refused as
   stale, even against a concurrent save.

People decide publish requests through `GET /publish-requests`,
`GET /publish-requests/{id}` (the draft, the current version, the receipt) and
`POST /publish-requests/{id}/approve` or `/reject` (`workflows.write`, person
modes only). Deciding and superseding share one lock per workflow, so they
never interleave. The requester can never decide its own request. The
creators of the requesting and the drafting agents may approve unless the
organization sets `agents.publishRequiresSecondPerson`; a setting that cannot
be read refuses. Approval re-checks the receipt and the base version and
appends the version as the approver, tagging a new workflow with the scoped
client's tag; `publish.status` reports the outcome to the agent. `credentials.request` returns the link where
a person creates a credential; no tool accepts a secret value.

## Remote transport

With `JANUSLY_MCP_HTTP_ENABLED=true` the `janusly` executable serves the same
catalog at `/mcp` on the public port, over Streamable HTTP in stateless JSON
mode: no session is kept, so any instance answers any request, and `GET` and
`DELETE` answer 405. It is off by default; production also requires an
`https` `JANUSLY_WEB_BASE_URL`.

- Only `Authorization: Bearer jly_agent_…` authenticates. Browser sessions,
  identity provider tokens, the service token and development headers are
  refused; every credential failure is a 401 with `WWW-Authenticate: Bearer`,
  and a token store failure is a 500 with fixed text. The token is resolved on
  every request, so revocation applies to the next one.
- A token-like query parameter (`access_token`, `token`, `api_key`, `key`,
  `auth`, `authorization`), or `jly_agent_` anywhere in the query string, is
  refused with 400 before authentication, and only the parameter name is
  logged. In production behind `JANUSLY_TRUSTED_PROXY`, a request with `http`
  in any `X-Forwarded-Proto` hop is refused, so a token never travels in clear.
- A `Host` other than loopback, the `JANUSLY_WEB_BASE_URL` host or one in
  `JANUSLY_MCP_ALLOWED_HOSTS` is refused, which defeats DNS rebinding. This
  allowlist replaces the SDK's localhost check, which would refuse a reverse
  proxy on the same host. Browsers are not supported callers: any request
  carrying an `Origin` is refused, and `http.CrossOriginProtection` wraps the
  handler.
- Request bodies are capped at 256000 bytes (413 beyond), the same as the
  per-call request guard. Authenticated JSON-RPC batches are refused with 400,
  because one request would otherwise fan out into thousands of concurrent,
  audited calls. `subscriptions/listen` is refused, so no stream outlives the
  token check made when its request started.
- A tool's internal error is logged and answered with fixed text; database
  and connection details never reach the client.
- Audit rows record `transport: http`.

Failed authentications are not rate limited per address: tokens carry 256
random bits, a malformed one never reaches the database, an unknown one costs
one index lookup, and behind a proxy a shared limit would let one client lock
out every other.

Connect a client with:

```bash
claude mcp add --transport http janusly https://janusly.example.com/mcp --header "Authorization: Bearer $JANUSLY_AGENT_TOKEN"
```

## Catalog

The stable catalog contains 35 tools:

- agent: `agent.info`;
- publish gate: `drafts.save`, `drafts.get`, `drafts.list`, `workflows.test`,
  `workflows.qualify`, `qualifications.get`, `workflows.publish`,
  `publish.status`, `credentials.request`;
- authoring: `catalog.describe`, `workflows.validate`;
- workflow: `workflows.list`, `workflows.get`, `workflows.assure`,
  `workflows.propose`, `workflows.save`, `workflows.rollback`,
  `workflows.pause`, `workflows.resume`, `workflows.deactivate`,
  `workflows.reactivate`;
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
document had been sent. A `workflowVersionId` passed with it must be that
latest version; any other is refused, never run. `idempotencyKey` shares the HTTP start's per-tenant key
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

`workflows.rollback`, `workflows.pause`, `workflows.resume`,
`workflows.deactivate` and `workflows.reactivate` (`workflows.write`) and
`runs.cancel` (`runs.cancel`) call the same engine operations as the HTTP
rollback, pause, resume, trash, restore and cancel routes. They are
business writes, so they also need write consent, and deactivate and cancel are
annotated destructive. A pause reason over 500 characters is refused with
`invalid_argument` at `/reason`, as the HTTP route refuses it.

Never expose credential material, identity secrets, organization-wide security
settings, or unbounded raw evidence through MCP.
