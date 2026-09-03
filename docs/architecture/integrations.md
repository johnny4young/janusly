# Integrations

Integration tools are registered in `internal/tools` with input/output schemas,
static write capability, and bounded execution. Workflow dispatch goes through
`internal/executors`.

Credentials are organization-scoped. Managed values are envelope-encrypted in
PostgreSQL with an external root key. Environment-backed references are limited
by reserved namespaces and an operator allowlist. API payloads never return
credential values or reference names.

Credential health and workflow readiness are conservative authority surfaces:
they share the MCP environment-reference parser with discovery and execution,
and fail rather than present an empty healthy projection when their
tenant-scoped persistence reads are unavailable. A malformed MCP reference row
is unhealthy and cannot authorize an execution.

All outbound HTTP uses the shared policy: scheme and target validation, DNS
pinning, redirect revalidation, timeout, and response byte limits. Streamed
responses must be consumed inside the same executor invocation.
Tenant defaults and per-node overrides share one strict integer grammar and
retain process ceilings of 600,000 ms, 64 MiB, and 20 redirects; malformed or
larger values fail before DNS/provider egress instead of overflowing an integer
or silently weakening the bound. HTTP header maps must retain string values,
and the body mode is the closed `buffer|stream` enum.
The same tenant-resolved bounds apply when an agent invokes `http.request`;
agent execution is not a path around organization timeout, byte, redirect, or
preview policy. Agent HTTP targets must also be exact literal URLs authored in
that node. A context-, input-, secret-, or environment-templated URL is not
delegable to a planner; use an explicit HTTP/tool node for that request.

Local provider simulators require the double opt-in
`JANUSLY_LOCAL_STACK=true` and
`JANUSLY_LOCAL_INTEGRATION_SIMULATOR=true`; either flag alone cannot redirect
provider traffic, and production configuration refuses both gates. Completion
simulation additionally requires `anthropic` in
`JANUSLY_LLM_SIMULATED_PROVIDERS` and a valid non-Anthropic HTTP(S)
`JANUSLY_LLM_SIMULATOR_BASE_URL`. Janusly replaces any live Anthropic key with
a fixed non-secret simulator credential before constructing that client; an
invalid fully requested binding degrades to the provider-free path.

Mail, object storage, Slack, GitHub, PagerDuty, webhooks, and external runtime
projections preserve idempotency and audit boundaries. Validation replay skips
write effects.

PagerDuty uses a signed V3 trigger and one fixed assurance ladder: read the
authoritative incident, capture current action time, evaluate assignment plus
service/urgency/time policy, then conditionally acknowledge and snooze, re-read
authoritative state, and match the receipt's exact incident identity,
acknowledged status, and pending unacknowledge deadline before recording bounded
verification evidence. A qualified V2 semantic detector observes a recovery
case when the provider accepted the requests but the incident does not verify
as acknowledged; post-effect detection cannot claim a pre-effect quarantine
guarantee.
Only the engine-owned V3 event allowlist `incident.triggered`,
`incident.reassigned`, `incident.escalated`, and `incident.reopened` may reach
the action policy. A workflow may narrow that set, but it cannot authorize an
unknown present or future `incident.*` event by editing configuration.
The authoritative incident itself must still be in `triggered` state.
`acknowledged` and `resolved` are explicit no-action outcomes, so a second
provider event cannot re-acknowledge an incident or extend an existing snooze.
The pure policy can act either inside or outside configured daily windows and
can additionally enforce an RFC3339 `[activeFrom, activeUntil)` campaign of at
most 31 local calendar days. Event, receipt, and actual evaluation/action
timestamps must all match, with valid chronology. A requested approval has a
bounded fail-closed deadline and, after approval, re-reads the incident,
refreshes the clock, and re-evaluates the complete policy before either write;
a changed assignment, state, campaign, or time window records no-action
evidence instead of consuming stale authority.
Invalid zones, windows, activation bounds, snooze duration, filters, timestamp
chronology, missing user identity, or malformed incident data fail closed and
never authorize a mutation. The policy always requires an explicit current
`evaluatedAt` produced immediately before the decision; it never substitutes
the provider receipt time, so a delayed queue or replay cannot reuse stale
time-window authority. Workflow proposals reference exact
`pagerduty_api_token` and `pagerduty_webhook_secret` catalog credentials; they
do not invent default tenant identities. Credential expiry is rechecked at the
runtime egress gate on every provider call, so a workflow saved while a token
was valid cannot keep using it after expiration. Signed delivery IDs map to
stable, tenant-scoped trigger IDs so retries keep one rollout assignment. A
rollout or concurrent save must retain the exact verified logical webhook
credential name;
matching only the workflow/node ID never transfers trigger authority to a
different version. If a process stops after persisting the trigger event but
before claiming its run, a retry reloads the event's captured payload, workflow
version, node, rollout metadata, and logical webhook credential binding rather
than executing today's latest snapshot. That binding is the tenant-scoped
credential kind and name, not frozen secret material: rotating it immediately
revokes the prior secret version, and an accepted-event retry must verify with
the binding's current live, non-expired secret. A differently named credential
still cannot inherit the event. Before authenticating such a retry, the
handler may extract only the bounded provider event ID from the untrusted body;
that value can select only the tenant/workflow/node-scoped dedupe row and never
enters policy, audit, persistence, or run input until the captured credential
verifies the raw body. Revoked or expired webhook secrets are never valid,
including for retries. Unknown/tombstoned triggers remain opaque `404` and
missing or invalid authority remains opaque `403`; workflow, current-snapshot,
credential-store, root-key, or decryption availability failures return an
opaque retryable `500` instead of masquerading as permanent provider errors.
An already accepted event may still use its captured immutable version when
only the mutable latest snapshot is unavailable. The accepted event's
storm-limit counter increment and
durable rate-admission marker commit in one PostgreSQL transaction, so a crash before
`StartRun` cannot make the same delivery consume the fixed-window budget twice.
Ordinary limiter store failures retain the platform's fail-open availability
posture, but an unobservable commit result fails that attempt closed: the
transaction may already have persisted `skipped`, so only a later retry may
re-read the durable row and continue or return the settled duplicate result.
PagerDuty API calls do not follow redirects, so bearer
tokens and PUT/POST bodies are never replayed away from the explicitly
configured regional provider endpoint.
An unsuccessful `require_ok` envelope from any write-capable tool is persisted
with `writeSide=true`, even when the provider response is ambiguous. Declared
whole-node retry policies cannot replay that effect automatically; it enters
the ordinary operator-gated dead-letter/recovery path instead.

Structured tools use the same closed input contract during authoring and
execution. JSON transforms accept at most 2 MiB and 64 nesting levels; paths
are bounded exact segments and reject JavaScript prototype keys so their output
is safe to feed back into the web/API contract. Buffered CSV is limited to
2 MiB, 10,000 data rows, 500 columns, and 256 KiB per cell. The streaming CSV
parser enforces the same quote and shape grammar across chunk boundaries and
reports a bounded terminal error instead of returning a partial success.

Database tools connect only through an organization-scoped `postgres`
credential. They accept parameterized, single-statement SQL from a closed
`SELECT|INSERT|UPDATE|DELETE` grammar, with contiguous placeholders and bounded
parameters, rows, statement count, and timeout. `db.schema.describe` and
`db.query.read` additionally execute inside a PostgreSQL read-only transaction;
the database, not the lexical classifier, is the final write-prevention
authority. External pools are bounded per organization and process, use one
connection each, and are replaced when the credential fingerprint changes.
Validation mode suppresses every write-capable database operation.

`sheet.append` serializes each tenant/object key with a PostgreSQL advisory
lock held across the bounded object read and atomic replacement. This is the
multi-replica correctness boundary for its read-modify-write CSV format. Header
shape is fail-closed and string cells that could execute as spreadsheet
formulas are emitted as literal text. The local object-store provider streams
bounded reads, rejects symlink escapes, and publishes writes by same-directory
atomic rename.
