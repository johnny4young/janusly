# Agent platform

External agents (Claude Code, Codex, Cursor, or an organization's own) build,
test, publish and operate Janusly workflows through MCP. Janusly's job is the
gate between "an agent wrote it" and "it runs in production": it tests the
agent's work against contracts and fixtures, asks a person where the change
can write, and shows what is running so a person can decide.

This document is the target design. Each section says what exists today and
what is added. The MCP catalog itself is specified in `mcp-server.md`; the
run, approval and rerun rules it relies on are in `run-model.md`.

## Principles

- An agent is a principal of one organization. Nothing it holds names or
  reaches another organization, and a resource it cannot see answers exactly
  like one that does not exist.
- An agent never holds more authority than the person who created it, and
  never more than its own ceiling. Both are checked on every call.
- An agent proposes and tests freely, publishes through a gate, and never
  creates, renews or decides a human approval.
- Secrets travel by reference. MCP accepts no secret value and returns none.
- Every call is attributable: the audit row names the agent client, the person
  it acts for, the transport and the decision.
- Errors are for machines first: a closed code, the argument path, and the fix.

## 1. Agent identity

### Agent clients

An agent client is an organization-owned record that an authenticated person
creates in Settings or through `POST /agent-clients`:

| Field | Meaning |
|---|---|
| `name` | Shown in audit, approvals and the run map |
| `capabilities` | The ceiling: any of `read`, `propose`, `test`, `publish`, `operate`, `report` |
| `scope` | Optional workflow ids and workflow tags; empty means the whole organization |
| `expiresAt` | Required, at most 90 days (2160 hours) ahead; default 30 days |
| `rateLimitPerMinute` | Calls per minute across every tool; default 120, at most 600 |
| `createdBy` | The person the client acts for |
| `revokedAt` | Set by revoke; effective on the next request |

The token is 32 random bytes encoded as `jly_agent_<base64url>`. It is shown
once at creation or rotation. The database keeps only its SHA-256 digest and
last four characters; lookup is by digest, so no comparison runs on the
plaintext. The fixed prefix lets secret scanners recognise a leaked token.
Rotation replaces the token immediately and keeps the client id, so audit
history stays continuous. An expired client ends like a revoked one: rotating
it is refused with `agent_client_expired`, and the person creates a new
client. Only the creator rotates: the new token acts with
the creator's authority, so nobody else may hold it.

Managing clients needs two new catalog permissions: `agents.read` (viewer and
up) and `agents.write`. A person can only grant capabilities whose
permissions they hold, and can only edit or revoke their own clients unless
they hold `agents.write` as an admin, and then only to revoke. Agent tokens
can never call these routes.

### Capabilities

A capability is a fixed set of tools and the permissions they need. `read` is
implied by every other capability.

| Capability | Tools | Permissions |
|---|---|---|
| `read` | `agent.info`, `catalog.describe`, `workflows.list`, `workflows.get`, `workflows.assure`, `workflows.validate`, `runs.list`, `runs.status`, `runs.inspect`, `runs.output`, `dlq.list`, `operations.brief`, `recovery.cases.inspect`, draft and qualification reads | `workflows.read`, `runs.read`, `dlq.read`, `recovery.read`, `credentials.read` (names, kinds and status only) |
| `propose` | `drafts.save`, `credentials.request` | `workflows.write` |
| `test` | `workflows.test`, `workflows.qualify` | `runs.start` |
| `publish` | `workflows.publish` | `workflows.write` |
| `operate` | `runs.start`, `runs.cancel`, `dlq.redrive`, `workflows.rollback`, `workflows.pause`, `workflows.resume`, `workflows.deactivate`, `workflows.reactivate`, `recovery.cases.diagnose`, `recovery.cases.validate`, `recovery.cases.apply` | `runs.start`, `runs.cancel`, `dlq.replay`, `workflows.write`, `recovery.write` |
| `report` | Hook bridge ingest only (section 5) | none beyond the client itself |

`workflows.save` is not in any capability: an agent's saves go through drafts
and the publish gate. It stays available to the local stdio server's
operator-configured ceiling for development. `workflows.propose` needs
`ai.write`, which agents do not get, so it is in none either. `runs.start`
from an agent takes a saved `workflowId`, never a document, because an
unsaved document would run in production without publication.

Agent clients do not get `ai.write`. An agent brings its own model; Janusly's
AI calls spend the organization's budget, and the deterministic paths
(`recovery.cases.diagnose` included) work without it.

### Effective authority

On every call, before any business query:

1. Resolve the token digest to a live client: not revoked, not expired, its
   organization active.
2. Resolve the creator's current membership and effective permissions in
   that organization. A removed creator disables the client; a demoted
   creator shrinks it.
3. Effective permissions = capability permissions ∩ creator permissions.
4. The tool must belong to one of the client's capabilities. Permissions alone
   never admit a tool, because capabilities share permissions.
5. The tool's guard checks the effective set, the scope, the per-client rate
   limit, the existing per-organization per-tool limits, and, for business
   writes, `JANUSLY_MCP_WRITES_ENABLED` plus tenant `mcp.writeConsent`.

The same `guardTool` envelope serves stdio and HTTP. The actor travels in the
request (`req.Extra.TokenInfo` for HTTP, a fixed stdio actor otherwise), not
in the server instance, so one server serves every client.

### Scope

A scoped client sees only workflows whose id is listed or whose tags
(`workflow_metadata.tags`) intersect its tags, and the runs, dead letters and
recovery cases of those workflows, and the drafts, qualifications and publish
requests for them. `operations.brief` spans the organization, so a scoped
client is refused it. Lists filter; a direct read, write or start outside the
scope returns `not_found`, the same answer as for a missing id.
A scoped client may create a workflow only if its scope has a tag; the new
workflow receives the first tag, so it stays in scope.

### Audit

Every tool call writes one `mcp.tool.invoked` row in the client's
organization, allowed or denied. The actor is `agent:<clientId>`; metadata adds
the client name, the creator (`onBehalfOf`), the transport (`stdio` or
`http`), the effective permissions checked and the decision. Rows written by
the work the call causes (a saved version, a started run, a publish request)
carry the same actor through the `auth.Context`, which gains a `ModeAgent`
mode and an `AgentClientID` field. The client lifecycle writes
`agent_client.created`, `.updated`, `.rotated` and `.revoked`. Token values,
digests and request bodies never enter audit or logs.

For tool approvals, the creator counts as a requester of every call their
agent caused (a start, a redrive, a fix), so the person accountable for an
agent cannot approve its writes alone (see owner decision D4 for publish
approvals). The same holds for recovery approvals: the creator of the agent
that produced a candidate or its validation cannot approve it. Approval and
grant decisions accept only modes that prove a person.

### Isolation tests

Isolation is proved with negative tests against a second organization seeded
with the same shapes:

- every catalog tool, called with ids from the other organization, answers
  like a missing id; a completeness test fails when a new tool is not in the
  matrix;
- every list returns zero foreign rows;
- an `x-org-id` header, a body field or a cursor cannot move the call to
  another organization;
- revoked, expired, rotated-away and malformed tokens get the same 401;
- a client of a removed creator gets 401; a demoted creator's client loses the
  matching tools;
- rate-limit buckets and audit rows land only in the client's organization;
- a scoped client cannot read, start or publish outside its scope.

## 2. MCP catalog without ambiguity

What exists: 23 tools with input and output schemas, keyset pagination on
lists, `idempotencyKey` on `runs.start`, one-call validation reports, and
schema violations that name the tool and the violation.

### Contracts every tool keeps

- **Schemas.** Every tool declares `inputSchema` and `outputSchema`, and input
  objects reject unknown properties. A catalog test fails on a tool without
  both.
- **Errors.** An expected failure is an `isError` result whose text and
  `structuredContent` carry one envelope:

  ```json
  {
    "error": {
      "code": "validation_failed",
      "message": "2 issues block this draft.",
      "path": "/draft/nodes/2/config/url",
      "fix": "Set config.url to an absolute https URL.",
      "retryable": false,
      "issues": [
        {"code": "http_url_required", "path": "/draft/nodes/2/config/url",
         "message": "HTTP node requires config.url.",
         "fix": "Set config.url to an absolute https URL."}
      ],
      "next": {"tool": "catalog.describe", "arguments": {"section": "nodes"}}
    }
  }
  ```

  `code` is closed: `invalid_argument`, `not_found`, `permission_denied`,
  `consent_required`, `rate_limited` (with `retryAfterMs`), `conflict` (with
  the current revision), `validation_failed`, `qualification_failed`,
  `approval_required` (with `approvalUrl`), `secret_missing` (with the
  credential name and `setupUrl`), `secret_literal`, `idempotency_mismatch`,
  `response_too_large`, `unavailable`. `path` is a JSON Pointer into the
  tool's arguments. `fix` is one imperative sentence. URLs point at the
  Janusly UI and never carry a token.
- **Pagination.** Lists take `limit` (default 20, at most 100) and an opaque
  `cursor` from the previous `nextCursor`; a malformed cursor or limit is an
  error, never page one.
- **Idempotency.** Every write accepts `idempotencyKey`, keyed per
  organization, client and tool, so an agent's `runs.start` key does not
  share the HTTP start's per-organization key space. A retry returns the
  first result with `replayed: true`; the same key with different arguments is
  `idempotency_mismatch`. `drafts.save` of a document identical to the
  client's latest draft returns that draft with `unchanged: true`.
- **Secrets by reference.** Documents name credentials (`credential: NAME`,
  `{{secret.NAME}}`). A secret-shaped literal in a sensitive key fails with
  `secret_literal` and a fix naming the credential to create.
  `credentials.request` returns a setup link for a person; no tool accepts a
  secret value. Returned documents and outputs keep the existing shape-based
  scrubbing and 32000-byte value bound.
- **Human approvals are never created by an agent.** No tool creates, renews
  or decides an approval of any kind. Agents read approval status and consume
  a one-use grant a person issued, as `recovery.cases.apply` does today. A
  catalog test fails if a tool name or description offers to approve, and the
  HTTP decide routes refuse agent and service tokens.
- **Self-description.** `agent.info` returns the client's name, capabilities,
  effective tools, scope, expiry and rate limit, so an agent can plan within
  its ceiling instead of discovering it by failure.

### Tools added by this design

| Tool | Capability | Does |
|---|---|---|
| `agent.info` | `read` | Section above |
| `drafts.save` | `propose` | Stores an immutable draft for an existing workflow in scope, or for a new one; returns `draftId`, digest and the validation report |
| `drafts.get`, `drafts.list` | `read` | Read drafts within the client's scope |
| `credentials.request` | `propose` | Returns a setup link for a named credential; the value is entered by a person in Janusly |
| `workflows.test` | `test` | Runs a draft as a draft-test validation run (writes suppressed, stand-ins allowed); returns the run id |
| `workflows.qualify` | `test` | Starts the publish gate checks for a draft; returns a qualification id to poll |
| `qualifications.get` | `read` | Gate result: every check with code, path and fix |
| `workflows.publish` | `publish` | Publishes a qualified draft, or opens a publish request for a person |
| `publish.status` | `read` | Request state, reviewer, and the published version once done |

Dotted names stay the canonical form. The MCP specification allows them; the
cycle harness (section 6) checks that Claude Code, Codex and Cursor accept
them before anything else relies on it.

## 3. Remote MCP in the same executable

What exists: `cmd/mcp`, a stdio server with direct database access, an
operator-set permission ceiling and organization from the environment.

The `janusly` executable mounts the Streamable HTTP transport at `/mcp` on the
public listener, before `webdist`:

- **Transport.** The Go SDK's `StreamableHTTPHandler` in stateless JSON mode.
  The server keeps no session, so any instance answers any request and HA
  needs nothing new. Long work returns durable ids to poll, as today; `GET`
  and `DELETE` answer 405.
- **Off by default.** `JANUSLY_MCP_HTTP_ENABLED=true` turns it on. Production
  also requires an `https` `JANUSLY_WEB_BASE_URL`.
- **Authentication.** `Authorization: Bearer jly_agent_…` only. Browser
  sessions, Supabase tokens, the service token and development headers are
  refused on `/mcp`. A 401 carries `WWW-Authenticate: Bearer realm="janusly"`;
  a token store failure answers 500 with fixed text. Each rejected token
  writes an `mcp.auth.rejected` audit row with the reason (`malformed`,
  `unknown`, `revoked`, `expired`, `invalid_capabilities` or
  `creator_removed`), the transport and the client address, in the client's
  organization when the token matched one and in `system` otherwise; the
  token, its digest and its last characters are never recorded. After 20
  rejected tokens in a minute from one address (with `JANUSLY_TRUSTED_PROXY`,
  the last `X-Forwarded-For` hop), further rejections
  answer 429 with `Retry-After` and the standard `rate_limited` body, and are
  no longer audited one by one. A request without a bearer token gets the
  plain 401 challenge and is neither counted nor audited.
- **No tokens in URLs.** A request with `access_token`, `token`, `api_key`,
  `key`, `auth` or `authorization` in the query string, or `jly_agent_`
  anywhere in it, is refused with 400 before authentication; the parameter
  name is logged, never its value.
- **Rebinding and cross-origin.** Requests whose `Host` is not loopback, the
  host of `JANUSLY_WEB_BASE_URL` or one in `JANUSLY_MCP_ALLOWED_HOSTS` are
  refused. This allowlist replaces the SDK's localhost check, which would
  refuse a reverse proxy on the same host.
  Browsers are not supported callers: a request with an `Origin` header is
  refused (native clients send none), and `http.CrossOriginProtection` wraps
  the handler. Authenticated JSON-RPC batches and `subscriptions/listen`
  streams are refused.
- **Bounds.** 256000-byte request bodies (set on the SDK handler, matching
  the existing request guard), the existing 256000-byte response gate, and the
  per-client limit after authentication. Failed authentications are not
  limited per address: a malformed token never reaches the database, an
  unknown one costs one index lookup, and behind a proxy a shared limit would
  let one client lock out the rest.
- **No token forwarding.** The general resolver rejects any `jly_agent_`
  bearer without sending it to Supabase, so a misdirected agent token never
  reaches a third party.

OAuth comes after tokens and issues the same agent clients: Janusly as the
authorization server, authorization code with PKCE, a consent screen that
shows the capabilities and scope being granted, short access tokens with
rotating refresh, and Protected Resource Metadata at
`/.well-known/oauth-protected-resource/mcp`. Until then that path is not
served.

`cmd/mcp` stays for local use. It accepts `JANUSLY_AGENT_TOKEN` to act as an
agent client with full audit identity; without it, it keeps the operator
ceiling and organization from the environment.

Connecting a client:

```bash
claude mcp add --transport http janusly https://janusly.example.com/mcp \
  --header "Authorization: Bearer $JANUSLY_AGENT_TOKEN"
```

## 4. Publish gate

What exists: saving a version makes it the latest, and the latest version
takes production traffic unless a rollout routes it. An MCP `workflows.save`
is therefore a production change. Draft tests run an unsaved document as a
validation run with writes suppressed and optional stand-in step outputs;
`workflows.assure` reports contract and fixture evidence for saved versions.

The gate makes agent changes reach production only by publication (built as
described in `mcp-server.md`):

1. **Draft.** `drafts.save` stores an immutable, content-addressed draft in a
   new `workflow_drafts` table. A draft is not a version: nothing routes,
   schedules or triggers it.
2. **Test.** `workflows.test` runs the draft through the draft-test path,
   extended to drafts of workflows not yet saved. Writes stay suppressed.
3. **Qualify.** `workflows.qualify` records a receipt bound to the draft
   digest. It passes only when every check passes:
   - structural validation and production readiness with no errors;
   - an Intent Contract with declared outputs;
   - for a workflow with write effects (static capability metadata; an
     unknown tool or a subworkflow counts as a write), a Recovery Contract v2
     whose detector fixtures replay as expected;
   - the draft's behaviour fixtures pass: each fixture gives an input,
     stand-ins for the steps it mocks and the expected outputs, and runs as a
     draft test;
   - write steps use `resultPolicy: require_ok`, and write tools that accept
     an idempotency key receive one;
   - every credential the draft names exists, is active, and is visible to
     the client.

   Each failed check returns its code, path and fix in one result. Qualify is
   rate limited per client and workflow so an agent cannot spin on the gate.
4. **Publish.** `workflows.publish` takes the draft and a passing receipt,
   revalidates under the workflow's version lock, and then:
   - publishes directly when every step is pure (no write, no outbound
     call, no trigger), the workflow already has a published version, no
     other workflow calls it, and the draft only adds to the live version: a
     draft that removes, adds or changes a trigger, or removes a step or a
     declared output, waits for a person, so an agent cannot replace a
     production workflow with a no-op;
   - otherwise opens a publish request and returns `approval_required` with a
     link. A person with `workflows.write` reviews the diff against
     production, the receipt and the effect list, and approves or rejects.
     Approval publishes in that person's request; the agent polls
     `publish.status`. Requests expire after 24 hours.

   Publication calls the same canonical engine append as an HTTP save, so it
   joins the one ordered version history, reconciles schedules, and can start
   a rollout. Audit records the agent as requester and the person as
   approver.

A passing gate proves the contracts and fixtures held, not that production
will behave. Product copy says "qualified", never "verified"; verification
remains the job of outcome qualification, rollout guardrails and semantic
detectors after publication.

The gate is measured with a corpus of 20 defective workflows (no idempotency,
no result check, unpaged reads, invented nodes, secret literals) and 20 sound
ones: at least 90% of defects blocked and at most 10% of sound workflows
blocked.

## 5. Run map and agents view

What exists: `RunObservationWorkspace` overlays the run map on a read-only
canvas built from the run's snapshot; the editor canvas shows the same facts,
without actions, for the open run of the workflow on screen; the run stream
(`GET /runs/{runId}/stream`) pages by commit-ordered sequence with
`Last-Event-ID` resume and LISTEN/NOTIFY wake-ups; the Agents tab draws a lane
per `agent` and `multi_agent` step from the map; cost lives in `usage_events`
with the node id in metadata.

### Run map

One canvas, three questions answered at a glance: what is running, what is
stuck, what needs me. Per node: status, attempts, elapsed time and cost.

The read models exist: `GET /runs/{runId}/map` (`runs.read`) returns each
step's status, attempts, start, finish, elapsed time, AI cost and tokens from
`usage_events`, waiting kind, child run, a `stuck` flag (running three times
longer than the median of that step's successful executions in the
workflow's last 200 runs, never under 30 seconds, or ten minutes without
history) and `needsYou` (a person step or a tool approval a person with
editor rank may decide, never one they caused),
plus agent lanes from `agent.*` and `multi_agent.*` events and run totals.
`GET /needs-you` lists, for the signed-in person, tool approvals they did not
cause, approval and form steps (both with `runs.start` and `runs.read`) and agent publish
requests (with `workflows.write`, and not to the people a second-person rule
excludes). Both are in the versioned contract (`/v1/runs/{runId}/map`,
`/v1/needs-you`). A lane step carries only its type, time and the string or
integer fields `tool`, `status`, `agent` (a crew agent's `name`) and
`iteration`. A lane keeps its latest 200 events; `truncated` says it dropped
older ones, and the Agents tab says so.

The canvas reads the map through one shared feed per run
(`web/src/hooks/useRunMap.ts`): it refetches 400 ms after the run projection
changes (stream frames or the polling fallback) and every 15 seconds while
the run is open, so elapsed time and the stuck signal advance; it stops
ticking once the run is terminal, and a failed read keeps the last map. Node
status stays with the live run projection. Elapsed time counts on in the
browser from the moment the map arrived. A decision is offered only while the
live step still waits and its binding is complete, and always through a
confirm dialog showing the tool and its parameters: a tool approval posts the
approval id and parameter digest read when the dialog opened to
`POST /runs/tool-approvals/decide` (a request that changed meanwhile is
refused, refreshed and shown again), an
approval step resumes through `POST /resume` (there is no reject route for an
approval step), and a form opens the existing form dialog bound to the
step's resume token: the dialog closes when the step stops waiting or its
token changes, and never reopens by itself. Rerun uses the
existing preview and side-effect acknowledgement. The Agents tab reads the
same feed. Not built yet: expanding a child run inline (the node links to
it), the MCP activity lane, and recovery approvals and publish requests on
the canvas.

- **Agent and subworkflow lanes.** An `agent` or `multi_agent` node expands
  into a lane of its steps and tool calls from its `agent.*` events. A
  subworkflow node links to its child run and can expand it inline.
- **Stuck.** A node is stuck when it has run longer than its historical p95
  for that workflow, or past three quarters of the reaper threshold, without
  progress events. Stuck uses a dashed full border and a clock icon, never a
  leading bar.
- **Cost.** The stream gains a per-node cost delta from `usage_events`; the
  map shows per-node and run totals.
- **Needs you.** A waiting node whose kind a person decides (tool approval,
  approval, human form, recovery approval, publish request) is marked when the
  viewer is an eligible decider. Approve, deny and submit act in place with
  the existing routes, digest checks and requester rules.
- **Rerun.** From a finished node, the existing rerun preview and side-effect
  acknowledgement.
- **MCP activity.** A lane per agent client from `mcp.tool.invoked` audit
  rows that touched the workflow or run.

### External agents through a signed hooks bridge

`janusly hook` is a subcommand of the same executable, configured as a
`command` hook in Claude Code or Codex. It reduces the hook payload on the
user's machine and sends one CloudEvents 1.0 event to
`POST /agent-sessions/events`. The route exists only with remote MCP enabled
and shares its transport rules: no credentials in the URL, `https` behind a
proxy, an allowed `Host`, no browser `Origin`.

**Authentication.** The agent token is the bearer and resolves like `/mcp`:
revoked, expired or orphaned clients get `401`, failures are counted per
address and audited as `mcp.auth.rejected` with `transport: hooks`. The client
needs the `report` capability (`403 agent_capability_missing`).

**Signature.** `x-janusly-signature: t=<unix>,v1=<hex>` is HMAC-SHA256 over
`"<t>.<raw body>"`, ±300 seconds, compared in constant time
(`internal/signedingest`, shared with external runtimes). The key is
`HKDF-SHA256(ikm = SHA-256(token), info = "janusly/hook-sign/v1")`: the bridge
derives it from the token, the server from the digest it already stores. The
signature adds body integrity and a replay window, not a second factor; the
bearer still has to be the token itself.

**Event contract** (`internal/hookwire`). Strict: an unknown envelope or data
field, or a field of another type, rejects the event. Types:
`io.janusly.agent.{session.started, prompt.submitted, tool.requested,
tool.completed, subagent.started, subagent.stopped, turn.stopped,
session.ended}`; the source names the runtime (`janusly-hook/1/claude-code`,
`janusly-hook/1/codex`). The event id is a SHA-256 of its content, so a retried
hook carries the same id. `project` is a single path segment. Identity fields
and `januslyRefs` that look like secrets, and names with control or invisible
format characters, reject the event. `content` is not accepted.

**Storage.** `agent_sessions` and `agent_session_events`, both with `org_id`
and `agent_client_id`. Each event is one receipt per `(client, event id)`: a
duplicate answers `200` with `duplicate: true` and changes nothing. The server
assigns the order (`seq`) under the session row lock. Session ids are
namespaced per client: another client, even in the same organization, that
reports the same id gets a session of its own and can neither end nor detect
the first one. Never stored: transcripts or their path, full
paths, user or host names, environment, the token, its digest or the
signature, or the raw body.

| Limit | Value | Past it |
|---|---|---|
| Events per client | 100 per 10 s, 600 per minute, own buckets (the client's MCP `rateLimitPerMinute` does not apply) | `429` with `Retry-After` |
| Events per organization | 3000 per minute | `429` |
| Body | 32 000 bytes | `413` |
| Live sessions per client | 50 (silent 30 minutes counts as idle) | `429 agent_session_limit` |
| Events per session | 5000 | truncated; only closing events, else `409` |
| Stored receipts per session | 5050, stale and closing included | `409` |
| Late events | session ended over an hour ago | stored as `stale`, not projected |
| Retention | 14 days after the last event | the retention sweep deletes it |

**The command** (`internal/hookbridge`). `janusly hook claude-code` or
`janusly hook codex` reads one hook payload from stdin. It keeps only the
fields it maps (session, agent, tool name and id, MCP server, status,
duration, model, the last segment of `cwd`) and drops the rest before any
network call: transcript paths, tool inputs and responses, prompts, messages
and errors never leave the machine. From a successful `mcp__janusly__*` call
it keeps only well-formed `workflowId`, `draftId` and `runId` values. It
prints nothing on stdout, sends once with a 2-second budget, never retries,
refuses plain `http` to anything but a loopback IP literal, and always exits 0.
Secret-shaped refs and invisible format characters are dropped before sending.

| Native hook | Event |
|---|---|
| `SessionStart` | `session.started` |
| `UserPromptSubmit` | `prompt.submitted` |
| `PreToolUse` | `tool.requested` |
| `PostToolUse` / `PostToolUseFailure` / `PermissionDenied` | `tool.completed` with `ok` / `error` / `denied` |
| `SubagentStart` / `SubagentStop` | `subagent.started` / `subagent.stopped` |
| `Stop` | `turn.stopped` |
| `SessionEnd` | `session.ended` |

Other hooks are ignored. The event id hashes the session, hook, tool use,
agent and turn (`turn_id` in Codex, `prompt_id` in Claude Code), so a retried
hook is a duplicate and the next turn is not.

Setup. Use a dedicated agent client with only the `report` capability: the
hook runs as the same OS user as the agent, so the agent's own shell tools can
read its token. Put the token in a file and point `JANUSLY_AGENT_TOKEN_FILE` at
it (or set `JANUSLY_AGENT_TOKEN`), and set `JANUSLY_URL`:

```bash
janusly hook doctor                 # token, capability and signature, nothing stored
janusly hook config claude-code     # merge into .claude/settings.json
janusly hook config codex           # merge into .codex/hooks.json
```

**Session map.** `GET /v1/agent-sessions` lists the organization's sessions,
newest first, by cursor; `GET /v1/agent-sessions/{id}/map` returns the session,
one lane per agent shaped like run map lanes (`external_agent` for the main
agent, `external_subagent` with `parentId` for each subagent, the latest 200
steps each), totals, live subagents and the Janusly runs its calls named.
Both need `runs.read` and `agents.read` (sessions name agent clients); another
organization's session answers `404`; agent tokens are refused like on every
people route. Janusly references are what the agent reported, so a run counts
as linked only when an agent client of the same creator started it. A session reads `idle` after 30 silent
minutes and `ended` only on `session.ended`: a stopped turn with a live
subagent is still running. The run map lists those linked sessions (empty
without `agents.read`), and the session links back to the run. In the web app the sessions
live in the Agent activity tab (`#/multiAgent/sessions/<id>`), loaded on
demand; a running session refreshes every 5 seconds by polling, since no run
stream carries it.

**Gate from the map.** An agent client lists `gateTools`: exact tool names or
prefixes ending in `*` (`mcp__stripe__*`), at most 20, with the `report`
capability.

1. The ingest answers a matching `tool.requested` with `gate: true`.
2. The bridge opens a gate with `POST /agent-sessions/gates` (same bearer and
   signature) and long-polls `GET /agent-sessions/gates/{id}/decision?wait=25`
   (the signature covers the path) until its wait runs out
   (`JANUSLY_HOOK_GATE_SECONDS`, 120 by default).
3. A person decides with `POST /v1/agent-sessions/gates/{id}/decide` from the
   session map; `/needs-you` lists the gate as `agent_gate`.
4. The bridge prints the runtime's `PreToolUse` decision.

Rules:

- **Who decides.** A signed-in person with editor rank and `agents.write`;
  agent and service tokens never. The client's creator may decide (it is their
  agent on their machine), unless the organization sets
  `agents.publishRequiresSecondPerson`; then the route refuses them and
  `/needs-you` does not offer it.
- **No answer is `ask`.** A gate lives 10 minutes. Expired, unanswered within
  the bridge's wait, refused, unreachable, or past 20 open gates per client:
  the bridge prints `ask` and the person decides in their terminal. Nothing
  defaults to `allow`.
- **Codex.** Its hooks have no `ask` and no documented plain `allow`, so the
  bridge prints only denials there; an approval or an unanswered gate leaves
  the call to Codex's own approval policy.
- **Content.** Without `captureContent` the decider sees the tool, server,
  agent and session, not the arguments, and the card says so.
  `captureContent` applies only to `gateTools`: the bridge then sends the
  gated call's input, scrubbed on both sides and cut to 8000 bytes; a client
  without it that sends content is refused. Only people of the deciding role
  read the captured input; a viewer sees that it exists. It is cleared after 7
  days and never enters audit rows (`agent_gate.decided` records the tool,
  session, client and decision).
- A gate belongs to its client: another client, or another organization, gets
  `404` reading or opening it. The poll holds nothing beyond its own request.

- **Save as workflow.** An observed session converts into a draft: subagents
  become `agent` nodes, overlapping ones run in parallel. It enters the
  publish gate like any agent draft; it is a starting point, not a replay.

The run map is measured with five people answering what runs, what is stuck,
what needs them and what it has cost, each within 30 seconds.

## 6. Delivery order

Each stage is one pull request with its security review and the test that
measures its goal; this document is updated with what shipped.

1. Agent identity, capabilities, scope, audit and isolation tests, on stdio.
2. Remote MCP at `/mcp`.
3. Publish gate: drafts, test, qualify, publish, publish requests.
4. Run map and agents view, then the hooks bridge.
5. The cycle harness: ten tasks in English and Spanish, each from a blank
   Claude Code or Codex session against `/mcp`, scored on the 30-step cycle.
   The goal is 8 of 10 completed with no person except to enter a secret and
   approve.

Identity comes first because every later stage records and limits by client.
The gate comes before the map because the map's "save as workflow" ends in
the gate.

## Threats

| Threat | Control |
|---|---|
| Stolen token | Expiry, revocation, rotation, per-client rate limit, scope; digest-only storage; prefix for secret scanning |
| Cross-organization access | Organization from the token only; foreign ids answer as missing; negative test matrix over every tool |
| Privilege escalation | Ceiling ∩ creator's live permissions on every call; grants limited to the creator's own permissions |
| Agent approving its own work | No approval tool; decide routes refuse agent and service tokens; creator counts as requester for tool and recovery approvals |
| Agent disarming production | Publishing a draft that removes or changes triggers, or removes steps or outputs, waits for a person; only a person lifts a circuit-breaker pause |
| Gate bypass through `workflows.save` | Not in any capability, and the guard admits only capability tools; production changes from agents only by publication |
| Prompt injection through workflow data | Documents and outputs are untrusted data for the agent; scrubbing and size bounds; writes still need the gate and consent |
| DNS rebinding and browser CSRF | Host allowlist, Origin refusal, cross-origin protection |
| Token in URLs, logs or third parties | Query tokens refused; Authorization never logged; agent bearers never sent to Supabase |
| Hook replay or forgery | HMAC with timestamp window and event-id deduplication |
| Resource exhaustion | Body and response bounds, rate limits on calls, failed auth, qualify and gates; gate polling without held goroutines |

## Owner decisions

The owner accepted each recommendation below on 2026-11-07.

**D1. Workflow ids per organization.** `workflows.id` is a global primary key.
Saving an id another organization uses answers "workflow id is already
taken", which confirms that the id exists elsewhere, and the public PagerDuty
callback and schedule, subworkflow and webhook paths find the organization
from the id. Options: (a) key workflows by organization and id and move public
callbacks to opaque per-trigger tokens, which changes every registered
callback URL; (b) keep global ids but let the server assign them for new
workflows, with a per-organization slug for people. *Decided: (b).*
Agents will never choose a global id, so the agent surface has no oracle, and
no public URL changes. Revisit (a) only if people need to choose ids.

**D2. Loopback by default with development headers.** When development
headers are active (no identity provider, not production) and
`JANUSLY_HTTP_HOST` is unset, the API listens on every interface, so anyone on
the network can act as any user. *Decided:* in that mode default to
`127.0.0.1`; Compose and E2E set `JANUSLY_HTTP_HOST=0.0.0.0` explicitly.
`/mcp` refuses development headers in every mode.

**D3. `CI gate` as a required check on `main`.** The workflow already computes
a stable `CI gate` result; making it required is a repository ruleset setting
only the owner can change. *Decided:* require it, with no bypass for
automation, before agents open pull requests here.

**D4. Who manages agent clients, and who approves an agent's publication.**
*Decided:* editors and admins may create clients within their own
permissions; only the creator rotates, and admins may revoke any. The creator may approve their own
client's publish request by default, because the person is the accountable
approver and the agent the requester; an organization setting requires a
second person.

**D5. Remote MCP in production.** *Decided:* off until enabled with
`JANUSLY_MCP_HTTP_ENABLED=true` and an `https` `JANUSLY_WEB_BASE_URL`, so upgrading never
opens a new surface by itself.

**D6. What the hooks bridge records.** *Decided:* tool names, status,
timing and agent structure by default; inputs, commands and prompts only when
a client enables `captureContent`, because they can carry customer data and
credentials that shape-based scrubbing misses.
