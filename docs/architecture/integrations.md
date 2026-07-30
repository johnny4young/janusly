# Integrations (Secret Store, external runtime shadow, PagerDuty, tools, mailer, upstream health, trigger nodes)

> Operational deep-dive extracted from `AGENTS.md` (kept verbatim). `AGENTS.md` carries the one-line summary + a link here. Edit the invariants here; keep the `AGENTS.md` summary in sync.

## Upstream health awareness

**Upstream health awareness:** operator-declared status feeds live in `upstream_health_sources` (`(orgId, name)` unique, closed-enum `kind` = `statuspage_io` / `atlassian_statuspage` / `http_probe` / `custom_feed`, `url`, `expectedComponents` jsonb, `checkIntervalSeconds`, `enabled`, derived `lastStatus` / `lastDegraded` / `lastErrorReason`). A workflow opts in via the new optional `workflow_versions.upstreamHealthSources: string[]` column (jsonb, carried forward on save + rollback like `slo_json`; an explicit array in the save body overrides, `undefined` inherits). The background poller `packages/engine/src/upstream-health-poller.ts` is a `system:upstream-health-poll` BullMQ cron (default `* * * * *`, env `JANUSLY_UPSTREAM_HEALTH_CRON`, mirror of `memory-retention-scheduler.ts`, registered + dispatched from `worker.ts`); `pollOneSource` fetches each due source through `fetchHttpTarget` (the SAME SSRF / DNS-pin / body-cap / timeout chokepoint — no vendor SDK), parses via the PURE `parseUpstreamFeed` in `@janusly/shared/src/upstream-health.ts`, and on `degraded` pauses every workflow tagged with the source's name (`workflows.status` flips to `paused_upstream_degraded` via the idempotent CAS `pauseWorkflowsForUpstream`, audit `workflow.paused.upstream` once per actual flip) / on recovery resumes them (`workflow.resumed.upstream`). **FAIL-OPEN is load-bearing:** an unreachable / unparseable feed or a missing watched component records `lastErrorReason` but NEVER pauses (a down status page must not amplify an outage) — `pollOneSource` never throws; every fetch/parse failure returns `{ ok: false }` and the caller skips the pause. `POST /start` rejects a non-`active` saved workflow with HTTP 409 + `errorEnvelope("upstream_degraded")` unless the body carries `forceRunDuringPause: true` (audit `workflow.force_run_during_pause`); ad-hoc (unsaved) workflows are never gated. CRUD routes in `apps/api/src/routes/upstream-health-routes.ts` (`GET /upstream/sources` viewer/`upstream.read`; `POST` create + `POST :id` update (POST-as-update) + `DELETE :id` + `POST :id/check` immediate poll, admin/`upstream.write`). New permission category `upstream` (`upstream.read` viewer+, `upstream.write` admin); audit actions `upstream_health.source.{created,updated,deleted}`. The poller's `listSourcesToPoll` is the documented cross-org sweep exception (each derived pause is still org-scoped via the source's own `orgId`). Web surface is `UpstreamHealthPanel` in `OperationsPage` Reliability. Adding a provider means a new parser branch in `parseUpstreamFeed` + (if the wire shape differs) a new parse helper — don't bypass the fail-open contract.

## Event-driven trigger nodes

**Event-driven trigger nodes:** five trigger node types (`webhook_received`, `email_received`, `file_dropped`, `mcp_server_event`, `pagerduty_incident`) extend the runtime's trigger surface alongside `schedule`/`webhook`. Like `schedule` they are PASSTHROUGH executors (`packages/engine/src/triggers.ts`) — the executor validates the authored config (shared per-type Zod in `@janusly/shared/src/trigger-types`: `triggerNodeTypeValues`, the config schemas, the normalized inbound-payload schemas, the size caps `EMAIL_BODY_MAX_BYTES`/`ATTACHMENT_MAX_BYTES` 1 MiB + `MAX_ATTACHMENTS` 20 + `*_PAYLOAD_MAX_BYTES` 64 KiB, and the `resolveTriggerRateLimitPerMin` storm-guard clamp default 60/min) and succeeds with `{ triggeredBy, triggeredAt, event }`, reading the normalized inbound event from `runs.inputJson.input.event`. Generic ingestion lives in `apps/api/src/routes/trigger-ingest-routes.ts` (`POST /triggers/{webhook,email,file,mcp}/ingest`, editor + `triggers.ingest`): validate → resolve → persist a deduplicated `trigger_events` row before the run → storm guard → pause/buffer gate → `startRun` → audit. PagerDuty uses the provider-signed public callback described below and then enters this same durable pipeline. `POST /triggers/events/:id/replay` re-runs a persisted event's stored payload against the current latest version of its original workflow; `GET /triggers/events` is the recent-event feed. Generic trigger types remain operator-authored; recognized PagerDuty off-hours prompts are compiled locally into the canonical graph. `payloadJson` always goes through `safePersistPayload`. **Connector carve-out:** the generic JSON webhook and PagerDuty callback are directly usable today, but Janusly does not include a live SMTP relay, bucket-event listener, or MCP subscription client; those upstreams must send their normalized payload to the ingestion seam.

**Selector uniqueness is fail-closed.** `resolveTriggerNode` scans every matching latest active workflow version before returning. One match resolves normally, no matches return 404, and a second match raises `AmbiguousTriggerNodeError`; the ingestion routes translate that signal to 409 `trigger_selector_ambiguous` before writing a trigger event. This avoids nondeterministic first-match delivery when a pack is installed twice or two workflows reuse an alias, bucket selector, MCP selector, or endpoint key. Replay remains pinned to its persisted workflow and node identity.

## Credential Secret Store

`credentials` stores one operator-facing name per organization
(`UNIQUE(orgId,name)`), its kind, and an
opaque `secretRef`; it never stores plaintext. New credentials default to the
PostgreSQL-backed provider in `packages/data/src/credentialSecretStore.ts`.
Each version gets a random 256-bit data-encryption key and independent
AES-256-GCM nonces. The secret is encrypted with that data key, then the data
key is wrapped by one deployment root key. Authenticated data binds both
ciphertexts to the organization, credential, and version, so copied or altered
rows fail closed.

The external root key comes from
`JANUSLY_CREDENTIAL_MASTER_KEY` or
`JANUSLY_CREDENTIAL_MASTER_KEY_FILE`; when both are configured, the inline
value wins. It must decode to 32
bytes. The key never enters PostgreSQL, logs, API payloads, audits, or the
browser. A database backup without the matching root key cannot decrypt managed
credentials; back up and rotate that key using the deployment secret manager,
not tenant configuration. Current rows use key version 1, so changing the root
key without a rewrap migration makes existing managed credentials unreadable
(no rewrap tool exists yet — treat the root key as immutable; see
`docs/configuration.md` for the loss/recovery posture).

API and worker boot both run `assertCredentialRootKeyUsable()` right after the
migration probe: a malformed inline key or an unreadable key file fails the
process fast at deploy time instead of surfacing as the first credential
write's 500; an unset key stays legal (legacy environment-reference
deployments) and only logs the posture. At resolution time the store still
fails closed as null, but abnormal failures now warn once per process per
(version row, reason) with a stable reason code —
`root_key_unavailable` / `decrypt_failed` / `unsupported_key_version` — and
never any key material, so a replica holding a different root key than the one
that encrypted (creation works, runs fail) is diagnosable from logs.

`POST /credentials` accepts exactly one `secretValue` (managed) or `secretRef`
(legacy environment-variable compatibility). Rotation uses the same exclusive
choice through `newSecretValue` / `newSecretRef`, serializes on the credential
row, inserts a new encrypted version, CAS-swaps the opaque reference, revokes
the prior managed version, and writes the audit in one transaction. Deleting a
credential revokes its managed version but keeps version metadata as forensic
history. `GET /credentials` returns only safe metadata plus
`storage: "managed" | "environment"`; no reference or value is exposed.

Every `credentials.secret_ref` consumer calls the async, organization-aware
resolver. Integration tools, external PostgreSQL tools, signed Slack
callbacks, PagerDuty, readiness, and credential health must not read
`process.env[credential.secretRef]` directly. A non-managed reference still
resolves from the process environment during migration. A reference that
claims the `janusly-secret://` provider but has a malformed identifier fails
closed and never falls through to the environment provider. `org_configs`,
workflow JSON, action history, and audit metadata are never secret stores.

Two secret surfaces are deliberately OUTSIDE the store: raw template secrets
(`{{secret.X}}` / `{{env.X}}` — the template renderer is synchronous and has
no tenant scope, so these stay deployment-owned process environment values;
there is no migration path into the store for them) and MCP connection
`envRefs` (runtime + discovery read `process.env[name]` directly — their
health check goes through the resolver, but as plain names they always take
the legacy branch). Don't cite "all consumers" when touching those paths.

## Integration tools

Registered-tool dispatch in `packages/engine/src/tool-execution.ts` is shared by ordinary `tool` nodes, agent planning, and `loop.mode='for_each'`; keep organization defaults, usage context, and dry-run write-side classification there instead of adding executor-specific forks. An ordinary tool node preserves the registry's never-throw envelope as output, while `for_each` deliberately interprets `{ ok: false }` as an item failure for its explicit batch budget. A timed-out or over-budget write-side batch is marked possibly committed, cooperatively stops dequeuing new items, and never whole-node retries automatically; operator-gated replay prevents duplicate external effects.

The public `listTools()` projection includes a required `writeSide` capability
bit derived from the same registered `ToolDefinition` as execution. It tells
the browser that some valid invocations can mutate external state; it does not
replace input-sensitive runtime classification. The workflow Inspector keeps
the current selection visible while searching, labels read-only versus
write-capable tools before execution, and replaces a previous tool's input with
the new tool's bounded example (or `{}`) when the contract changes. This avoids
silently carrying stale fields across schemas. `ToolPicker` is shared by
ordinary tool nodes and bounded `for_each` loops; `ToolConfigEditor` owns only
the ordinary-node composition and resilience disclosure.

### External runtime shadow mode

External runtime shadow mode is the first adapter boundary for workflows that
execute outside Janusly. It is observation-only: an administrator registers an
`external_runtime_signing_secret` credential and an observer under
`/integrations/external-runtimes`; the opaque callback is
`POST /webhooks/external-runtimes/:connectionId`. The callback verifies
`X-Janusly-Signature: t=<unix>,v1=<hex>` against the exact raw body with the
same HMAC-SHA256 scheme used by `webhook.send`, rejects timestamps outside five
minutes, and validates the bounded CloudEvents 1.0-compatible union in
`packages/shared/src/external-runtime.ts` before any write. The event
transaction rechecks that the same tenant connection is still enabled before
claiming its receipt, so a concurrent disable/delete closes the callback at the
durable authority boundary rather than only at the initial lookup.

Three event types are accepted: workflow, run, and step observations. Every
event has a stable source event id and a required non-negative source
`sequence`. `external_runtime_events` is the immutable replay-protection
receipt; `(connectionId, source, eventId)` converges exact retries. The
`external_workflows`, `external_runs`, and `external_run_steps` projections
advance only when `incoming.sequence > lastSequence`, so a late success cannot
rewrite a newer failure. Run/step events may arrive before their parents and
create bounded `unknown` placeholders; the later authoritative parent event
fills them without losing child history. Every free-form string is scrubbed
for known secret shapes and every JSON snapshot/evidence block passes through
`safePersistPayload` before PostgreSQL. Event/source/workflow/run/step identity
fields fail closed instead of being redacted, because redacting an identity
would collapse distinct upstream entities onto the same uniqueness key.

`external_recovery_cases` opens or reopens only from an observed `failed`
run/step and may move to `observed_recovered` after a newer `succeeded` event
for the exact subject. This is not `verifiedRecovery`: Janusly did not execute
the effect and receives no production recovery-impact credit. Settings →
Workspace → Integrations renders this boundary explicitly and exposes no retry,
resume, cancel, replay, or patch action. Connection deletion disables future
callback resolution but deliberately preserves orphan-tolerant receipts and
projections for forensic history.

New adapters should first emit this shared contract. Mutation capabilities are
a separate future boundary and must be explicit per adapter (for example,
`retry` or `cancel`), independently credentialed and audited; never infer
control authority merely because an observer can report lifecycle events.

### Signed Slack recovery actions

Alert policies can enrich `recovery_item.created` and `recovery_item.sla_breached` Slack messages with acknowledge, assign-to-me, and open-in-Janusly buttons. The optional channel parameter `interactionConnectionId` points to an enabled `slack_interaction_connections` row in the same organization; a missing, disabled, cross-tenant, or temporarily unreadable connection degrades to the existing text-only alert rather than blocking delivery. `packages/engine/src/alerts/slack-actions.ts` owns the bounded Block Kit projection and the stable action ids shared with the API parser. Outbound delivery still uses `slack.post`, its `slack_webhook` credential, and the normal integration-tool rate-limit and telemetry chokepoint.

The inbound callback is `POST /webhooks/slack/interactions/:connectionId`. The id is an opaque UUID, not authority. `apps/api/src/slack-interactions.ts` verifies Slack's `v0` HMAC over the exact raw URL-encoded body with a five-minute clock-skew limit before parsing; the signed team id must match the stored team and the Slack user id must map to a current Janusly organization member. The mapped member must pass both editor rank and `recovery.write`. The signing secret uses a distinct `slack_signing_secret` credential resolved through the central Secret Store; neither the value nor its opaque/legacy reference is returned by the connection routes. `JANUSLY_PUBLIC_API_URL` is optional and only makes the admin callback URL absolute.

`applySlackRecoveryInteraction` claims a SHA-256 callback receipt and applies the recovery-item CAS in one Postgres transaction. Concurrent Slack retries therefore produce one mutation across API replicas; repeated deliveries return success without a second audit or state change. Acknowledge and assignment write the same recovery audit actions as the web surface with Slack source metadata. Open-link callbacks are authenticated and audited but do not mutate recovery state. Connection CRUD lives under `/integrations/slack/interactions` (admin plus `credentials.write`), validates the signing credential and every mapped member, and deliberately deletes only its operationally meaningless receipts when a connection is removed.

### Prompt-generated PagerDuty off-hours workflow

PagerDuty is a workflow capability, not a separate policy product. An
organization creates two protected credentials in Connections:
`pagerduty_api_token` and `pagerduty_webhook_secret`. The operator then asks AI
Studio for the automation in natural language. Recognized off-hours intent is
compiled locally by `apps/api/src/pagerduty-flow.ts`; no model, token budget, or
provider key is required. The prompt contributes only bounded configuration
such as credential names, requester email, PagerDuty user id, IANA time zone,
working hours, urgency, region, and snooze duration.

The canonical visible graph is:

1. `pagerduty_incident` receives a signed PagerDuty V3 event.
2. `pagerduty.incident.get` reads the authoritative incident.
3. `pagerduty.policy.evaluate` deterministically checks the event type,
   incident status, current assignment, optional service/urgency filters, and
   both occurrence and receipt time against the configured working window.
4. Only a matching decision reaches `pagerduty.incident.acknowledge`, followed
   by `pagerduty.incident.snooze`.
5. Transform nodes preserve action or no-action evidence in normal run history.

`POST /webhooks/pagerduty/:workflowId/:nodeId` is the public ingress. The path
selects an exact saved trigger but is never authority. The API resolves the
node's tenant-scoped `pagerduty_webhook_secret`, verifies a matching
comma-separated `v1=<hex>` HMAC-SHA256 signature over the exact raw body before
JSON parsing, projects bounded fields, and submits the event to the shared
durable trigger pipeline. The dedupe key contains workflow, node, and provider
event id, so relay retries converge on the original trigger event and run.

The evaluator fails safe: malformed time zones, unresolved runtime templates,
or invalid incident/timestamp data produce a no-action decision. Both the
provider occurrence time and Janusly receipt time must be outside working
hours, preventing a delayed webhook from mutating an incident during the day.
All provider calls use `fetchHttpTarget`, the tenant Secret Store, shared Redis
rate limiting, usage events, and never-throw envelopes. Acknowledge and snooze
are marked `writeSide`; validation/sandbox runs skip them. The generated graph
sets `resultPolicy="require_ok"` so an upstream failure enters the ordinary run
failure, DLQ, and recovery surfaces instead of being hidden.

There is deliberately no PagerDuty connection/policy screen and no parallel
PagerDuty action table or maintenance reconciler. Configuration remains
visible and versioned in the workflow Inspector, while secrets remain outside
the graph. An AI summary node is appended only when the prompt explicitly asks
for post-action enrichment, and it runs after deterministic evidence. PagerDuty
does not expose an idempotency key for snooze: a process crash after the
provider accepts snooze but before the run node commits may repeat that effect
and extend the interval. This at-least-once edge must remain explicit in
operator documentation. The local provider simulator implements incident read,
acknowledge, snooze, persistence, and controlled failure modes.

**Integration tools:** third-party API tools (`slack.post`, `github.create_issue`, `webhook.send`, future additions in `packages/engine/src/integration-tools.ts`) follow a single chokepoint pattern. (1) Credential resolution: `getCredentialByName(orgId, kind, name)` from `packages/data/src/credentialsRepo.ts` — multi-tenant scoped via `eq(credentials.orgId, orgId)`. The credential row's opaque `secretRef` resolves through `credentialSecretStore`: managed refs decrypt an org-scoped, non-revoked PostgreSQL row and legacy refs read the named environment variable. Workflow JSON carries only the operator-facing credential name; destination URLs such as `webhook.send.url` are ordinary tool input, not secrets. Neither values nor references are echoed in error envelopes (missing material returns `credential secret missing for <name>` — generic). (2) Outbound HTTP through `fetchHttpTarget` ONLY — no vendor SDKs (`@slack/web-api`, `@octokit/*`, `axios`, etc.). The SSRF / DNS-pin / body-cap / timeout / redirect guards apply uniformly. (3) Per-org rate limit via the shared Redis-backed limiter, bucket name `tool.<actionKey>` (e.g. `tool.slack.post`), per-tenant override via `org_configs.{slack,github,webhook}.rateLimitPerMin`, fail-open on Redis blips (existing posture). (4) Usage event via `setIntegrationUsageRecorder` (DI seam in `packages/engine/src/integration-usage.ts`, registered at api + worker boot to `packages/data/src/usageRepo.ts:recordIntegrationUsage`) — fires on success AND failure with `metric: "tool.<name>"` so cost / quota dashboards include the failed-call traffic. (5) `writeSide: true` on every integration tool so sandbox / validation-mode runs skip them via the existing `dryRun` path. (6) Return envelope is `{ ok, statusCode?, error?, latencyMs, ...result }`; tools NEVER throw on runtime failures (rate-limit, missing credential, upstream non-2xx) — the workflow run consumes the envelope and decides via downstream `condition` nodes. `webhook.send` signs the body with Stripe-style HMAC-SHA256: `X-Janusly-Signature: t=<unix-seconds>,v1=<hex>` where the signed payload is `<timestamp>.<body>` — receivers verify with a 5-line check using the same shared secret. Don't add a new integration tool by reaching for the vendor SDK; reuse the chokepoint. **First-party SDK verifiers** live at `packages/sdk-node/src/resources/webhooks.ts` (TypeScript, `client.webhooks.verifySignature` + standalone export) and `packages/sdk-python/src/janusly/webhooks.py` (Python, stdlib-only `from janusly.webhooks import verify_signature` — Lambda / Cloudflare Worker receivers reach the verifier without pulling in `httpx`). Both verifiers mirror the engine's `signWebhookPayload` byte-for-byte (HMAC-SHA256 over `${t}.${body}`, constant-time compare, default ±300s clock-skew tolerance, typed failure reasons `malformed_header` / `timestamp_skew` / `signature_mismatch`). Adding a new verifier in another language MUST mirror the same scheme exactly; reference test fixture is `secret="test-secret"`, body `{"event":"run.completed"}`, timestamp `1700000000`, signature `e9df1d6069fcd21baca8aa13029d247d5c588c3da74f2cff426e84eea2c1b426`. The Python SDK ships at `packages/sdk-python` with PyPI name `janusly` (Python 3.10+, single runtime dep `httpx`, hatchling build, `pytest` + `mypy src/janusly` — strict, configured in `pyproject.toml` `[tool.mypy]` — in a dedicated `test_sdk_python` CI lane; the `src/` surface is `mypy --strict`-clean); it ships BOTH a sync `JanuslyClient` and an async `JanuslyAsyncClient` (`async_client.py`). The async client is a 1:1 mirror — same four resources, same methods as `async def` + `await` (`runs.list` / `runs.stream_events` are async generators; `webhooks.verify_signature` stays sync HMAC). The only new transport is `async_request` in `_http.py` (over `httpx.AsyncClient`) sharing a factored `_raise_for_status` with the sync `request`, so both paths produce byte-identical errors; the pure helpers + header-injection guard + webhook verifier are reused verbatim, so the async client cannot drift from the sync one. Both clients are stateless per-call (a fresh `httpx` client per request, no shared pool), so neither has an `aclose()`/context-manager lifecycle. Both also accept an opt-in `RetryConfig` (`max_attempts=0` default = no retries; `backoff_ms=200`; `retry_on=(429,502,503,504)`) — a semantics-mirror of the TS SDK's `JanuslyRetryConfig`: a retryable `JanuslyApiError` (status ∈ `retry_on`) or an `httpx.HTTPError` (network/timeout) is retried with exponential backoff (`Retry-After` on a 429 that carries it, else `backoff_ms * 2**attempt`); 4xx validation errors are never retried; headers are composed ONCE before the retry loop so the deterministic injection-guard `ValueError` is never retried; `retry=None` runs the transport thunk exactly once (byte-for-byte the no-retry behavior). The retry layer is in `_http.py` (`_with_retries` sync / `_with_retries_async` async), shared by both clients. Adding a new SDK method means mirroring it in BOTH clients (sync + async) so they stay 1:1. The **TS SDK** (`packages/sdk-node/src/request.ts`) mirrors the same reserved-header contract: `buildHeaders` reserves the identical 6-header set (`RESERVED_HEADERS` = `authorization` / `accept` / `user-agent` / `x-org-id` / `x-user-id` / `content-type`) and throws `TypeError` — the JS-idiomatic mirror of Python's `ValueError` — on a caller-supplied collision (not a silent skip), composed ONCE in `sendApiRequest` before the retry loop so the deterministic guard is never retried. Changing the reserved-header set or the collision behavior means updating BOTH SDKs (Python `_RESERVED_HEADERS` + TS `RESERVED_HEADERS`) and their tests in lockstep. **Credential health preflight** rides on the same chokepoint: `getCredentialHealth(orgId, resolver)` in `packages/data/src/credentialHealthRepo.ts` returns per-credential `{ secretRefPresent, lastUsedAt, lastErrorAt, lastErrorMessage (scrubbed via scrubSecretShapes), usageCount30d, referencingWorkflowIds }` plus an MCP-connection block. `SecretRefResolver` is async and organization-aware; production wires the central managed/legacy provider through `productionSecretRefResolver` in `apps/api/src/readiness-helpers.ts`. `GET /credentials/health` (viewer, `credentials.read`) exposes the snapshot; the engine's `checkWorkflowReadiness` stays pure and the new `credential_missing` warn rule lives in the readiness sidecar (`getCredentialReadinessIssues`) wired into the four readiness call sites (`/workflows/readiness`, `/workflows/save`, `/workflows/health/delta`, `/start`). The secret reference is NEVER returned on any payload or readiness message — the response carries only the operator-chosen credential `name`, MCP `alias`, and (for MCP) the operator-chosen `envRefs` KEYS (not the names). New permission keys `credentials.read` (viewer-default) + `credentials.write` (admin-default) under a new `credentials` category; `POST /credentials` gains `credentials.write` alongside its existing `role: admin` (defense-in-depth). Operators see broken credentials in the searchable Connections inventory BEFORE a workflow trips over them at runtime; MCP discovery posture and rediscovery stay in the existing `McpConnectionsPanel`. **Bulk credential rotation** layers on top: `POST /credentials/:name/bulk-update` (admin, `credentials.write`) runs a preview→confirm flow — dry-run returns the affected-workflow list via `resolveCredentialReferences` (in `credentialHealthRepo.ts`, reusing the same `loadLatestWorkflowVersions` + `readCredentialNameFromConfig` the health snapshot uses, so the rotation preview and Connections inventory agree); commit flips `credentials.secretRef` through `rotateCredentialSecretRef` (`credentialsRepo.ts`), a CAS `UPDATE … WHERE orgId+name [+updatedAt]` guarded on the new `credentials.updatedAt` column (`timestamptz(3)` — millisecond precision on purpose so the `If-Match` token round-trips exactly against the JS `Date`; a stale token matches zero rows → HTTP 409 `credential_rotation_conflict`, an absent credential → 404). The secret stays off the wire: the response and `credential.bulk_updated` audit carry affected-workflow ids plus the new `updatedAt` token, never `secretRef`, `newSecretValue`, or `newSecretRef`. Managed rotation inserts a new encrypted version under a credential-row lock; legacy reference rotation remains available for migration. The web `CredentialRotateModal` (mounted in `ConnectionsPanel`) drives the two steps, sends the previewed `updatedAt` as `ifMatch`, re-previews on a 409, and `bumpPlatformVersion()`s on success — "readiness recompute" here is invalidate-and-refetch (Janusly readiness is on-demand, not cached, so a rotation needs no recompute job).

## Buffered HTTP JSON and template trust

Buffered `http` nodes and `http.request` keep the existing decoded `body` contract. `projectHttpJson` (`packages/engine/src/http-json.ts`) adds `json` only when the final response explicitly declares `application/json` or `application/*+json`, the body is at most 64 KiB, and `JSON.parse` succeeds. Invalid declared JSON sets `jsonParseError: true`; larger declared JSON sets `jsonParseSkipped: "body_too_large"`; non-JSON media types are never guessed from content. Streaming responses are consumed into their existing preview envelope and are never projected because a preview may be truncated. The 64 KiB cap keeps raw text plus its native projection comfortably below the default 256 KiB safe-persistence bound. Operators who intentionally need another parse step use the read-side `json.parse` tool, whose invalid-input error never echoes the supplied string.

Workflow template trust is an immutable snapshot policy, not an organization config. A missing ordinary `context.*` / `inputs.*` path preserves the legacy empty-value substitution and emits a deduplicated `template.unresolved_path` event for that resolution phase; every event carries at most 20 paths, each capped at 160 characters. Missing `env.*` references persist only the normalized `env.*` marker, and missing `secret.*` references still fail immediately through `getSecret`. The optional top-level `templatePolicy` defaults to lenient by absence; `"strict"` records the same evidence and throws `UnresolvedTemplatePathError` before the missing value is consumed. Ordinary config paths fail before config validation or executor invocation. Executor-owned scopes are deliberate deferred exceptions: loop `mapping` and `for_each.input` keep `item.*` / `index` literal until the loop binds them, and sequential `multi_agent` goals keep `previousAgents.*` literal until the earlier agent results exist; parallel agents never defer `previousAgents`. A `for_each` loop renders every item's input before invoking any tool, so strict policy cannot produce a partially processed batch. All immediate context/env/secret references still resolve at dispatch and participate in strict/redaction handling; each late-bound scope applies the same bounded event and strict failure contract at its actual binding point. `getRunMetadata` reads the policy from `runs.inputJson.workflow`, preserving the exact policy that started the run even if a newer workflow version is saved. Full-workflow AI improvement strips the policy from its prompt and restores only the original operator-authored value; the model cannot invent, erase, or change it.

## Postgres DB query tools

**Postgres DB query tools:** `db.schema.describe`, `db.query.read`, `db.query.write`, and `db.query.transaction` live in `packages/engine/src/db-query-tools.ts` and reuse the integration-tool telemetry/rate-limit posture without routing through `fetchHttpTarget`. Credential resolution is still the tenant boundary: each call requires `executionContext.orgId`, resolves only `getCredentialByName(orgId, "postgres", input.credential)`, and resolves the DSN through the central managed/legacy Secret Store. Workflow JSON stores only the operator-friendly credential name. Tool envelopes, usage rows, readiness messages, and missing-secret errors must never echo the connection URL, password, `secretRef`, or secret-shaped upstream error text. There is **no SQL tenant-predicate injection**: external database isolation is the customer's DSN / database role / schema / RLS / view boundary. Because `db.query.read` runs operator-authored `SELECT`s verbatim, any SELECT-callable side-effecting function the supplied role can reach (`pg_read_file`, `lo_import`, `dblink` / `postgres_fdw`) is in scope — provision a least-privilege, read-only Postgres role/DSN, never a superuser one.

The SQL validator is intentionally conservative. All SQL tools reject semicolons, comments, DDL/session-control verbs, multi-statements, verb-class mismatches, and placeholder/parameter mismatches before opening a connection. `db.query.read` accepts only a `SELECT` and wraps it in a bounded outer `LIMIT`; `db.query.write` accepts exactly one `INSERT` / `UPDATE` / `DELETE`; `db.query.transaction` accepts up to 10 parameterized `SELECT`/DML statements and wraps read statements with the same result cap. `db.schema.describe` never runs caller-provided SQL; it reads `information_schema.columns` for non-system schemas and supports only simple identifier filters for `schema` / `tables`. The validator has no SQL parser — it scans raw text — so parameterize every value with `$1`-style placeholders: a reserved word inside an unparameterized text literal, or a read CTE (`WITH …`), is conservatively rejected rather than parsed. Every query path (including `db.schema.describe`) runs under a `SET LOCAL statement_timeout` so a slow or locked statement can't pin a worker.

Pooling, rate-limit, and usage attribution are keyed by org + credential. The engine keeps at most five external Postgres pools per org per process, one connection per pool, and evicts least-recently-used pools when an org exceeds the cap. The rate-limit bucket is `tool.<toolName>.<credentialNameHash>` (credential name is hashed so admin rate-limit snapshots do not leak operator labels) with per-org override `org_configs.integrations.db.rateLimitPerMin` / env `JANUSLY_DB_TOOL_RATE_LIMIT_PER_MIN` (default 60/min). Every success and failure records `usage_events.metric = "tool.<toolName>"` via `setIntegrationUsageRecorder`. `db.query.write` and `db.query.transaction` are `writeSide: true`, so sandbox / validation-mode runs skip them via the existing dry-run path; `db.schema.describe` and `db.query.read` still execute in validation because they are read-side. Readiness treats the write/transaction tools as sensitive actions and warns when there is no upstream approval gate.

## PDF generation + object store

**PDF generation + object store:** the `pdf.generate` tool routes Markdown OR HTML templates through the `pdfkit`-backed renderer in `packages/engine/src/pdf-renderer.ts` (no Chromium dep) and uploads via the pluggable object-store abstraction in `packages/engine/src/object-store.ts` — three providers (`S3Provider` using `@aws-sdk/client-s3` + presigned URL fallback / `LocalDirProvider` for dev/tests / `NoopProvider`) selected per org by the safe `org_configs` key `objectstore.provider`, with env fallback `JANUSLY_OBJECT_STORE_PROVIDER`. Bucket / region / endpoint / public base URL come from `JANUSLY_OBJECT_STORE_*` env (never `org_configs`); the S3 endpoint override supports MinIO / Cloudflare R2 / Backblaze without extra plumbing. The S3 provider intentionally bypasses `fetchHttpTarget` because the bucket endpoint is operator-supplied infrastructure config, not workflow-author input — don't try to "harden" the S3 SDK call by routing it through the SSRF chokepoint. Per-org key prefix `orgs/<orgId>/pdfs/<runId>/<nodeId>/<filename>` (assembled by the tool wrapper) is the only thing keeping tenants from reading each other's PDFs — never bypass `getObjectStore()` from outside the tool. Per-org rate limit via the shared limiter, bucket name `tool.pdf.generate`, default 30/min, override via `org_configs.integrations.pdf.rateLimitPerMin` or `JANUSLY_PDF_RATE_LIMIT_PER_MIN`. Render is gated BEFORE upload so over-limit calls don't waste CPU. Every call (success, render-fail, upload-fail, AND rate-limit-rejected) writes a `usage_events` row with `metric: "pdf.generated"` and `quantity` = produced PDF byte length via `packages/engine/src/pdf-usage.ts` + `setPdfUsageRecorder` (registered at both api + worker boot to `packages/data/src/usageRepo.ts:recordPdfUsage`). The provider's `put()` NEVER throws — all failures degrade to `{ ok: false, provider, error }` so write-side tools mirror the AI-fallback contract. **Template dialect** is selected by the optional `format: "markdown" | "html"` input field (defaults to `"markdown"` for back-compat — every pre-existing call site still works). Markdown supports heading levels 1-3, paragraphs with bold (`**`) / italic (`*`), bulleted + numbered lists, fenced code blocks, and `---` rules. HTML uses a sanitized subset parsed via `htmlparser2` (the only new runtime dep, ~50KB, zero native deps): closed whitelist (`<h1>`-`<h6>`, `<p>`, `<div>`, `<br>`, `<ul>`/`<ol>`/`<li>`, `<hr>`, `<pre>`, `<code>`, `<strong>`/`<b>`, `<em>`/`<i>`, `<span>`, `<a href>` http/https only, `<table>`/`<thead>`/`<tbody>`/`<tr>`/`<th>`/`<td>` with `colspan` capped at 16); closed deny-set drops both tag AND children for non-void tags (`<script>`, `<style>`, `<iframe>`, `<object>`, `<form>`, `<svg>`) and silently skips void tags (`<img>`, `<input>`, `<link>`, `<meta>`, `<base>`, `<embed>`); unknown tags pass children through (lenient on display markup, strict on executable / external-resource tags). All attributes dropped except validated `<a href>` (`javascript:` etc. rejected) and `<th>`/`<td>` `colspan`. Inline `<a href>` inside `<h1>`-`<h6>` is preserved as a clickable link annotation in the produced PDF. Variable substitution `{{name}}` is identical across both dialects and runs pre-parse. **Three defense-in-depth caps** all throw and degrade to `{ ok: false, error }` via the tool wrapper: 200KB template byte cap, 32-deep nesting cap (parser-bomb / billion-laughs guard), and `MAX_BLOCKS = 5000` + `MAX_TOKENS_PER_BLOCK = 2000` (CPU-bound DoS guard so a 200KB template with thousands of tiny tags can't stall the worker event loop). The Inspector / `listTools()` shape surfaces `format` as an optional field; the LLM prompt grammar continues to advertise the tool name only (operators or `/ai/patch-workflow` set `format` post-generation).

## Mailer

**Mailer:** the `email.send` tool routes through a pluggable mailer abstraction in `packages/engine/src/mailer.ts` — Resend, SendGrid, Noop, plus an explicit local-only Simulator provider selected per org by the safe `org_configs` keys `email.provider`, `email.from`, and `email.rateLimitPerMin`, with env fallbacks `JANUSLY_MAILER_PROVIDER`, `JANUSLY_MAILER_FROM`, and `JANUSLY_EMAIL_RATE_LIMIT_PER_MIN`. The Simulator is never selected implicitly and still requires `JANUSLY_LOCAL_INTEGRATION_SIMULATOR=true`; it exists only for the persistent local integration lab. Provider API keys still come only from env/vault (`RESEND_API_KEY` / `SENDGRID_API_KEY`), never `org_configs`; Resend's sandbox `onboarding@resend.dev` is the smoke-friendly default sender. Both real providers call out via `fetchHttpTarget` so the existing SSRF guards + bounded timeout / body / redirect apply (no Resend / SendGrid SDK dep). Provider `send()` NEVER throws — all failures (network, non-2xx, malformed body) degrade to `{ ok: false, provider, error }`. The per-org `"email.send"` bucket is enforced through `setEngineRateLimiter` in both API and worker processes, backed by the shared Redis limiter from `packages/data/src/rate-limit.ts`; default 100/min and fail-open on Redis blips. Every send (success, failure, AND rate-limit-rejected) writes a `usage_events` row with `metric: "email.sent"` via `packages/engine/src/email-usage.ts` + `setEmailUsageRecorder` (registered at both api + worker boot to `packages/data/src/usageRepo.ts:recordEmailUsage`). The metadata shape (provider, providerMessageId, ok/error, latencyMs, nodeId, workflowId) surfaces in the existing `?breakdown=workflow,provider` UI. Don't bypass the chokepoint by calling `getMailer().send` from outside the tool.

**Local provider simulation:** `packages/engine/src/local-integration-simulator.ts` is a process-owned routing gate used only by the dedicated local Docker profile. When and only when `JANUSLY_LOCAL_INTEGRATION_SIMULATOR=true`, the seeded GitHub and Slack credentials target the bundled simulator, `email.provider=simulator` resolves the simulator mailer, and `webhook.send` may rewrite RFC-reserved `*.example.com` placeholders. Arbitrary webhook destinations are never rewritten. The simulator records bounded request evidence and provides deterministic success, HTTP failure, and malformed-contract modes for GitHub, Slack, webhook, email, and PagerDuty. Webhook effects also have a bounded persistent idempotency ledger (`GET/DELETE /effects`). A successful delivery returns a closed `provider_simulation_receipt` carrying its scope, stable effect id, idempotency key, applied/duplicate disposition, and request id. Validation effects use a reserved engine-owned scope header so they never consume the production-scoped local idempotency record; workflow input cannot override that header. `webhook.send` exposes a receipt only when the final destination is the configured local simulator and the body passes the strict receipt parser. Keep this separate from production provider behavior; do not weaken normal SSRF or credential resolution to make a local test pass.
