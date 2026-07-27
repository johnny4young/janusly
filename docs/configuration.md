# Configuration

Janusly reads environment variables from the repo root. `packages/db/src/env.ts`
loads `.env.example` first as safe defaults and then `.env` as developer or
deployment overrides. Do not put real secrets in `.env.example`.

Safe runtime choices can also be overridden per tenant in the `org_configs`
table. Environment variables remain the process-level defaults; tenant rows
win only for the cataloged keys listed below. Infrastructure settings and
deployment root keys stay process-owned. Tenant integration credentials default
to the encrypted Credential Secret Store described below; legacy
environment-backed references remain supported.

## Core Services

| Variable | Default | Used by | Purpose |
| --- | --- | --- | --- |
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/workflow` | `packages/db` | Postgres connection string for Drizzle, API, worker, and migrations. |
| `REDIS_URL` | `redis://localhost:6379` | API rate limiter, engine queue | Redis connection for shared rate-limit state and BullMQ. |
| `PORT` | `3001` | `apps/api` | API HTTP port. |
| `API_ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174` | `apps/api/src/http.ts` | Comma-separated CORS allowlist. `pnpm dev` uses strict `5173`; `5174` remains for legacy/manual development setups. |
| `JANUSLY_DEV_HOST` | `127.0.0.1` | `scripts/run-dev.mjs` | Validated Vite bind hostname/IP for `pnpm dev`. Loopback is the safe default; use `0.0.0.0` only for deliberate LAN/container exposure. |
| `API_MAX_JSON_BODY_BYTES` | `1048576` | `apps/api` | Maximum request JSON body size. |
| `API_SERVICE_TOKEN` | unset | `apps/api/src/auth.ts` | Optional Bearer token for service clients, including production MCP mode. |
| `JANUSLY_REQUIRE_SAVED_WORKFLOW` | `false` | `apps/api` | When `true`, rejects ad-hoc `POST /start` workflow payloads. |
| `JANUSLY_PRODUCTION_MODE` | `false` | `apps/api`, `packages/engine/src/workflow-readiness.ts` | When `true`, `POST /start` runs the deterministic readiness gate (`checkWorkflowReadiness` + DB-aware `checkRollbackAvailability`) and rejects fail-level workflows with HTTP 422. Dev mode (unset) preserves the old "anything structurally valid runs" behaviour. |
| `JANUSLY_REQUIRE_EVAL_COVERAGE` | `false` | `packages/engine/src/workflow-readiness.ts` | Opt-in addition to the readiness gate that warns when a workflow has no associated eval. Off by default so clean MVP workflows can reach `status: "pass"` without eval tracking. |
| `WORKER_CONCURRENCY` | `10` | `packages/engine/src/worker.ts` | BullMQ worker concurrency. |
| `MAINTENANCE_WORKER_CONCURRENCY` | `2` | `packages/engine/src/worker.ts` | Isolated BullMQ maintenance-worker concurrency. Closed range 1..4; invalid values use 2 so sweeps cannot consume customer execution capacity. |
| `JANUSLY_MAX_SUBWORKFLOW_DEPTH` | `5` | `packages/engine/src/subworkflow.ts` | Maximum nested subworkflow depth. |
| `JANUSLY_RESUME_TOKEN_SECRET` | unset in dev; required in production | `packages/engine/src/secrets.ts` | HMAC signing secret for `human_form` resume tokens, one-time SSO state, and opaque browser-session cookie envelopes, separated by signed `purpose`. Dev mode uses a local fallback; production fails closed without this dedicated secret. Do not reuse `API_SERVICE_TOKEN`. |
| `JANUSLY_SESSION_COOKIE_SECURE` | inferred from `JANUSLY_WEB_BASE_URL` | `apps/api/src/browser-session.ts` | Forces the WorkOS browser-session cookie's `Secure` attribute when `true`, or disables it for deliberate HTTP-only local development when `false`. Omit in production and use an HTTPS web base URL unless a trusted proxy topology requires an explicit override. |
| `JANUSLY_IDENTITY_RETENTION_CRON` | `0 3 * * *` | maintenance worker | Cron schedule for bounded cleanup of expired/revoked browser sessions and expired one-time SSO nonces. Invalid expressions fall back to the default. |
| `JANUSLY_IDENTITY_SESSION_RETENTION_DAYS` | `7` | maintenance worker | Days to retain expired sessions and old revoked sessions before deletion. Closed range 1..90. Does not delete users, memberships, audit rows, or run history. |
| `JANUSLY_PERSIST_MAX_BYTES` | `262144` (256 KiB) | `packages/engine/src/safe-persist.ts` | Default size cap for jsonb writes through the safe-persist chokepoint. Over-cap payloads are replaced with a `{ __truncated: true, ... }` sentinel. |
| `JANUSLY_HTTP_COMPRESSION` | `true` (on) | `apps/api/src/http.ts` | gzip for JSON responses in the `sendJson` chokepoint. Applied only when the client sent `Accept-Encoding: gzip` and the body clears ~1 KB; SSE streams are never compressed. Set `false` to disable. |
| `JANUSLY_ORG_CONFIG_CACHE_TTL_MS` | `30000` | `packages/data/src/orgConfigRepo.ts` | Process-local TTL (ms) for the resolved `org_configs` snapshot read on hot paths. Same-process writes invalidate immediately; other replicas converge within one TTL. `0` disables the cache. |
| `JANUSLY_RECOVERY_METRICS_CACHE_TTL_MS` | `30000` | `apps/api/src/metrics-cache.ts` | Process-local TTL (ms) for the composed `GET /recovery/metrics` envelope. Invalidated on DLQ replay/resolve; `0` disables. |

`docker-compose.yml` also sets Postgres container-internal values
(`POSTGRES_USER=postgres`, `POSTGRES_PASSWORD=postgres`,
`POSTGRES_DB=workflow`). Those are not read from `.env`; they just need to
match the local `DATABASE_URL` default.

## Credential Secret Store

Managed integration credentials are accepted once by the API, encrypted before
they enter PostgreSQL, and resolved only inside API/worker processes. The
`credentials` row holds an opaque `janusly-secret://<id>` reference;
`credential_secret_versions` holds AES-256-GCM ciphertext and a wrapped random
data key. One external 32-byte root key unwraps those data keys.

| Variable | Default | Used by | Purpose |
| --- | --- | --- | --- |
| `JANUSLY_CREDENTIAL_MASTER_KEY` | unset | API, worker | Inline root key encoded as standard base64 or 64 hexadecimal characters. Takes precedence over the file setting (the file is then silently ignored). Prefer a deployment secret manager rather than a checked-in env file. |
| `JANUSLY_CREDENTIAL_MASTER_KEY_FILE` | unset | API, worker | Path to a file containing the same 32-byte key encoding. Recommended for Docker/Kubernetes secret mounts. The persistent local stack generates an ignored mode-0600 file automatically. |

Generate a key once per deployment:

```bash
openssl rand -base64 32
```

(or `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`).
The value must decode to exactly 32 bytes: standard base64 (base64url `-`/`_`
characters are rejected) or exactly 64 hex characters. Both processes validate
a *configured* key at boot — a malformed value or unreadable file path fails
API/worker startup immediately; an unset key boots fine (legacy
environment-reference deployments) and logs
`no root key configured`. The key is cached in-process after first use, so
rotating a mounted key file only takes effect after an API/worker restart.

Operational rules:

- Configure the same root key in every API and worker replica before creating a
  managed credential. Replicas with different keys are the classic silent
  failure: creation succeeds on one, resolution fails closed on the other.
- Back up the root key in your secret manager, separately from PostgreSQL
  backups (a database dump alone can never decrypt managed credentials, and a
  root key stored next to the dump defeats the envelope). You need BOTH to
  restore: same database, same key.
- Treat the root key as immutable. Current managed rows use key version 1 and
  there is no rewrap tool yet — replacing the key in place makes every
  existing managed credential unreadable. Rotating a *credential's value*
  (`bulk-update`) is routine and unrelated to rotating the *root key*.
- If the root key is lost, the managed values are gone by design. Recovery is
  re-entry: list affected rows via `GET /credentials`
  (`storage: "managed"`) and `GET /credentials/health`
  (`secretRefPresent: false`), configure a fresh key, then rotate each
  credential with a new `newSecretValue` obtained from the upstream provider.
- `POST /credentials` accepts exactly one of `secretValue` (recommended,
  at most 64 KiB) or `secretRef` (legacy environment variable name). Rotation
  accepts exactly one of `newSecretValue` or `newSecretRef`.
- Migrating a legacy credential into the store is one rotation:
  `POST /credentials/:name/bulk-update` with `newSecretValue`, confirm
  `storage: "managed"` in `GET /credentials`, then remove the old env var from
  the deployment. Managed and environment credentials can coexist per row.
  Deleting a legacy credential never unsets its environment variable.
- Values and references are never returned. `GET /credentials` reports only
  `storage: "managed" | "environment"` with safe metadata.
- Credential health, readiness, Slack, PagerDuty, integration tools, and
  external PostgreSQL tools all use the same organization-aware resolver.
  Raw template secrets (`{{secret.X}}` / `{{env.X}}`) and MCP connection
  `envRefs` stay deployment-owned process environment values outside the
  store.

Troubleshooting:

| Symptom | Likely cause |
| --- | --- |
| API/worker exits at boot with `credential_secret_root_key_invalid` or a file read error | Key not standard base64/64-hex for 32 bytes, or the mounted key file path is wrong. Fix the value/mount — this is deliberate fail-fast. |
| `POST /credentials` or rotation returns 500 `credentials_secret_store_unavailable` | No root key configured in the API process. Set one of the two variables and restart. |
| `GET /credentials/health` shows `secretRefPresent: false` for a `managed` credential | The resolving process holds a different root key than the one that encrypted, the version was revoked, or its `keyVersion` is unsupported. Check process logs for `[credential-secret-store] managed secret failed closed` — the `reason` field distinguishes `root_key_unavailable` / `decrypt_failed` / `unsupported_key_version` (a missing/revoked row stays silent by design). |
| Credential creation works but runs fail with `credential secret missing for <name>` | Same diagnosis as above on the WORKER replica — typically the worker was deployed without the key or with a stale one. The worker logs the same warn line. |

## Tenant Runtime Config

`GET /org/config` returns the complete tenant-visible catalog for the current
org, including each key's `value`, `source` (`default`, `env`, or `tenant`),
category, type, description, and env fallback name. Admins can update one
tenant override with:

```http
POST /org/config
Content-Type: application/json

{ "key": "ai.provider", "value": "anthropic" }
```

The API validates values against a closed catalog before writing to
`org_configs`, so arbitrary env vars and secrets cannot be smuggled into the
tenant config table.

Guardrails:

- `org_configs` has no `is_secret` column and must not grow one.
- New keys are added only in `packages/data/src/orgConfigRepo.ts`, never by
  accepting arbitrary client-provided keys.
- Key names and env fallbacks are rejected at module load if they look like
  credentials (`secret`, `token`, `password`, API key, database URL, Redis URL,
  Supabase key, service token, authorization header, cookie, or private key).
- String values are rejected on write if they look like common credential
  formats such as provider keys, Slack tokens, GitHub tokens, Google OAuth
  tokens, AWS access keys, bearer tokens, JWTs, private keys, Postgres URLs, or
  Redis URLs.
- Values are primitives (`string`, `number`, or `boolean`) and are validated
  before insert/update.
- Every tenant write goes through `POST /org/config`, admin RBAC, and the API
  audit log.

> **MVP operating posture:** AGENTS.md locks runtime AI to **Anthropic only** (`claude-haiku-4-5-20251001`). The `openai` provider stays in the registry for future expansion but is unverified in production — do not switch a tenant's `ai.provider` away from `anthropic` unless a verification plan exists. Set `JANUSLY_LLM_PROVIDER=anthropic` in `.env` for deployment clarity; the tables below now match that default.

| Config key | Env fallback | Default | Used by | Purpose |
| --- | --- | --- | --- | --- |
| `ai.provider` | `JANUSLY_LLM_PROVIDER` | `anthropic` (matches the supported posture; explicit set still recommended) | API AI endpoints, engine AI/agent nodes | Default provider for tenant-level LLM calls. API keys still come from env or secret management. |
| `ai.openai.model` | `OPENAI_MODEL` | `gpt-4o-mini` | API AI endpoints, engine AI/agent nodes | Default OpenAI model for this tenant. Not a supported runtime target right now; tracked for future expansion. |
| `ai.anthropic.model` | `ANTHROPIC_MODEL` | `claude-haiku-4-5-20251001` | API AI endpoints, engine AI/agent nodes | Default Anthropic model for this tenant — the supported MVP target. |
| `ai.timeoutMs` | `OPENAI_TIMEOUT_MS` | `30000` | API AI endpoints, engine AI/agent nodes | LLM request timeout in milliseconds (env name is historical; applies to every registered provider). |
| `ai.maxRetries` | `OPENAI_MAX_RETRIES` | `2` | API AI endpoints, engine AI/agent nodes | AI SDK retry count for LLM calls (env name is historical; applies to every registered provider). |
| `ai.promptMaxChars` | `AI_PROMPT_MAX_CHARS` | `4000` | API AI endpoints | Prompt/question length cap. |
| `ai.rateLimitPerMin` | `AI_RATE_LIMIT_PER_MIN` | `30` | API AI endpoints | Per-org AI request limit per minute. |
| `ai.generationMode` | `JANUSLY_AI_GENERATION_MODE` | `free_json` | `POST /ai/generate-workflow` | Workflow-generation mechanism. `free_json` asks the model for JSON text and validates server-side; `constrained` keeps the legacy provider structured-output path. Both converge through noop promotion, `sanitizeAiWorkflow`, and bounded self-repair before fallback. |
| `ai.generationCandidates` | `JANUSLY_AI_GENERATION_CANDIDATES` | `1` | `POST /ai/generate-workflow` (free_json) | Best-of-N: candidates sampled per request, best kept by a deterministic `checkWorkflowReadiness` score (no LLM judge). `1` = single-shot (default, unchanged behavior); `2`–`5` lower per-prompt variance at extra generation cost. Ignored in `constrained` mode. |
| `ai.surfaceModels` | none | `""` | API AI endpoints (the six `/ai/*` surfaces) | JSON map of per-surface model overrides, e.g. `{"patch-workflow":"claude-sonnet-4-5","suggest-improvement":"anthropic/claude-sonnet-4-5"}`. Keys are surface slugs (`generate-workflow`, `explain-workflow`, `review-workflow`, `patch-workflow`, `suggest-improvement`, `explain-run`) validated against a closed enum; each value is a model id (bare id → configured provider, `"<provider>/<model>"` → provider override for that surface). A per-request `body.model` still wins. Empty means every surface uses the global default model. Stays Anthropic-only by posture. |
| `memory.enabled` | none | `false` | `packages/data/src/memoryConsent.ts` | Tenant master switch for persistent memory. Must be `true` alongside process env `JANUSLY_MEMORY_ENABLED=true`; no env fallback by design. |
| `memory.allowedKinds` | none | `""` | `packages/data/src/memoryEntriesRepo.ts` | CSV of writable memory kinds: `recovery_rationale`, `run_summary`, `runbook_fragment`, `patch_rationale`, `generated_workflow`, `workflow_vector`, `agent_episode`. Empty means memory is enabled but no kind is writable yet. |
| `memory.retentionDaysByKind` | none | `""` | memory retention helpers | JSON string of per-kind retention overrides. Empty uses the policy defaults; keys are validated against the closed memory-kind enum. |
| `memory.recallMaxEntries` | none | `8` | `recallMemory` | Hard cap on entries returned per recall (`1..32`). |
| `memory.recallMaxBytes` | none | `8192` | `recallMemory` | Hard cap on total recalled bytes (`1024..65536`). |
| `memory.embeddingProvider` | `JANUSLY_EMBEDDING_PROVIDER` | `""` (env default `ollama`) | `packages/ai/src/embeddings.ts` | Embedding provider recorded on each memory row. Catalog allows `ollama`, `voyage`, `openai`; v1 runtime is wired to Ollama. |
| `memory.embeddingModel` | `JANUSLY_EMBEDDING_MODEL` | `""` (env default `bge-m3`) | `packages/ai/src/embeddings.ts` | Embedding model recorded on each memory row for future re-embedding. |
| `memory.embeddingBaseUrl` | `OLLAMA_BASE_URL` | `""` (env/code default) | `packages/ai/src/embeddings.ts` | Operator-managed Ollama base URL. For `pnpm dev`, use `http://127.0.0.1:11434`; containerized API deployments can use `http://ollama:11434`. |
| `http.timeoutMs` | `JANUSLY_HTTP_TIMEOUT_MS` | `30000` | Engine `http` nodes and `http.request` tool | Default outbound HTTP timeout budget in milliseconds. |
| `http.maxResponseBytes` | `JANUSLY_HTTP_MAX_RESPONSE_BYTES` | `1000000` | Engine `http` nodes and `http.request` tool | Default maximum decoded body size. |
| `http.maxRedirects` | `JANUSLY_HTTP_MAX_REDIRECTS` | `5` | Engine `http` nodes and `http.request` tool | Default maximum redirect hops. |
| `http.streamPreviewBytes` | `JANUSLY_HTTP_STREAM_PREVIEW_BYTES` | `65536` | Engine `http` nodes and `http.request` tool | Bytes persisted as the JSON-safe preview for streamed HTTP bodies. The full stream still respects `http.maxResponseBytes`. |
| `email.provider` | `JANUSLY_MAILER_PROVIDER` | `noop` | `email.send` tool | Default mailer backend. Public providers are `resend` and `sendgrid`; `simulator` is accepted only behind the explicit local-stack process gate. Provider API keys stay in env or a vault. |
| `email.from` | `JANUSLY_MAILER_FROM` | `onboarding@resend.dev` | `email.send` tool | Default sender address when workflow input omits `from`. |
| `email.rateLimitPerMin` | `JANUSLY_EMAIL_RATE_LIMIT_PER_MIN` | `100` | `email.send` tool | Per-org email sends per minute. |
| `runs.requireSavedWorkflow` | `JANUSLY_REQUIRE_SAVED_WORKFLOW` | `false` | `POST /start` | Require runs to start from saved workflows instead of ad-hoc payloads. |
| `subworkflow.maxDepth` | `JANUSLY_MAX_SUBWORKFLOW_DEPTH` | `5` | Engine `subworkflow` nodes | Maximum nested subworkflow depth. |
| `runs.streamMaxSubscriptions` | `JANUSLY_STREAM_MAX_SUBSCRIPTIONS` | `50` | `GET /runs/:runId/stream` | Max live-run SSE subscribers per org per API replica. |
| `recovery.autoCreateItems` | none | `true` | recovery item hook | Automatically creates a `recovery_items` incident for new DLQ entries. Existing legacy tenants can opt out to avoid audit-row backfill surprises. |
| `recovery.debounceWindowSeconds` | none | `300` | recovery item hook | Failure-storm grouping window for attaching repeated DLQ occurrences to the same open incident. Range 0..3600 seconds; `0` disables grouping. |
| `recovery.slaPolicies` | none | `""` | recovery item hook | JSON map of per-severity resolve-by targets in minutes, keyed by `p1`..`p4`, e.g. `{"p1":30,"p2":120}`. Empty uses built-in defaults; partial maps keep omitted severities at their defaults; per-severity range is 1..43200 minutes. |
| `mcp.writeConsent` | none | `false` | MCP server write tools | Tenant half of the two-flag gate for MCP-source mutations such as `workflows.save`. Process env `JANUSLY_MCP_WRITES_ENABLED=true` is also required. |
| `mcp.clientWriteConsent` | none | `false` | `mcp_tool` node | Tenant half of the two-flag gate for invoking write-side tools on external MCP servers. Process env `JANUSLY_MCP_CLIENT_WRITES_ENABLED=true` is also required. |
| `mcp.clientRateLimitPerMin` | `JANUSLY_MCP_CLIENT_RATE_LIMIT_PER_MIN` | `60` | `mcp_tool` node | Per-org external MCP invocation budget per minute; per-descriptor overrides can narrow one tool. |
| `mcp.clientCommandAllowlist` | `JANUSLY_MCP_ALLOWED_COMMANDS` | `""` | stdio MCP connections | Comma-separated executable allowlist for stdio transports. Empty env and empty tenant override fail closed. |
| `mcp.stdioMaxLifetimeMs` | `JANUSLY_MCP_STDIO_MAX_LIFETIME_MS` | `600000` | stdio MCP sandbox | Max child-process lifetime before sandbox termination. |
| `mcp.stdioMaxStderrBytes` | `JANUSLY_MCP_STDIO_MAX_STDERR_BYTES` | `65536` | stdio MCP sandbox | Max captured stderr bytes before sandbox termination; captured text is secret-shape redacted. |
| `mcp.stdioMaxVmKb` | `JANUSLY_MCP_STDIO_MAX_VM_KB` | `524288` | stdio MCP sandbox | Linux `ulimit -v` virtual-memory cap for stdio children when enforcement is active. |
| `slack.rateLimitPerMin` | `JANUSLY_SLACK_RATE_LIMIT_PER_MIN` | `60` | `slack.post` tool | Per-org Slack tool calls per minute. |
| `github.rateLimitPerMin` | `JANUSLY_GITHUB_RATE_LIMIT_PER_MIN` | `60` | `github.create_issue` tool | Per-org GitHub tool calls per minute. |
| `webhook.rateLimitPerMin` | `JANUSLY_WEBHOOK_RATE_LIMIT_PER_MIN` | `120` | `webhook.send` tool | Per-org outbound webhook calls per minute. |
| `pdf.rateLimitPerMin` | `JANUSLY_PDF_RATE_LIMIT_PER_MIN` | `30` | `pdf.generate` tool | Per-org PDF renders per minute. |
| `objectstore.provider` | `JANUSLY_OBJECT_STORE_PROVIDER` | `noop` | `pdf.generate` tool | Object-store backend for generated PDFs. Bucket/directory credentials remain env-only. |
| `auth.allowedEmailDomains` | none | `""` | auth policy evaluator | CSV allow-list of email domains accepted for Supabase and post-callback SSO sessions. |
| `auth.mfaRequired` | none | `false` | auth policy evaluator | Policy marker only; Janusly records/warn-logs, while MFA enforcement stays at the IdP. |
| `auth.sessionTtlSeconds` | none | `28800` | WorkOS SSO callback | TTL for newly-created revocable WorkOS browser sessions, range 300..86400 seconds. Existing sessions keep their issued expiry. |
| `retention.runEventsDays` | `JANUSLY_RETENTION_RUN_EVENTS_DAYS` | `90` | retention sweep | Per-org `run_events` retention window, range 7..365 days. |
| `retention.auditLogsDays` | `JANUSLY_RETENTION_AUDIT_LOGS_DAYS` | `365` | retention sweep | Per-org `audit_logs` retention window, range 30..730 days. Separate global audit-log sweep defaults to 730 days. |
| `retention.usageEventsDays` | `JANUSLY_RETENTION_USAGE_EVENTS_DAYS` | `90` | retention sweep | Per-org `usage_events` retention window, range 30..365 days. |
| `retention.recoveryFeedbackDays` | `JANUSLY_RETENTION_RECOVERY_FEEDBACK_DAYS` | `180` | retention sweep | Per-org `recovery_feedback` retention window, range 30..365 days. |
| `retention.memoryEntriesDays` | `JANUSLY_RETENTION_MEMORY_ENTRIES_DAYS` | `90` | retention sweep | Per-org `memory_entries` retention window, range 7..730 days; applies in addition to per-kind memory expiry. |
| `retention.deletedWorkflowsDays` | `JANUSLY_RETENTION_DELETED_WORKFLOWS_DAYS` | `30` | retention sweep | Recovery window for a soft-deleted workflow (`DELETE /workflows/:id` sets `deletedAt`), range 1..365 days. Within it, `POST /workflows/:id/restore` brings it back; after it, the sweep hard-purges the workflow + its versions + metadata. |

The config table deliberately does not store `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, database URLs, Redis URLs, Supabase keys, service tokens,
or workflow secrets. Deployment-wide provider/infrastructure keys stay in the
environment or a vault. Tenant integration credentials belong in the encrypted
Credential Secret Store. Tenant config selects only safe behavior.

## Auth And Web

| Variable | Default | Used by | Purpose |
| --- | --- | --- | --- |
| `NODE_ENV` | unset | `apps/api/src/auth.ts` | Production guard. In `production`, dev headers require `ALLOW_DEV_AUTH_HEADERS=true` when Supabase is unset. |
| `ALLOW_DEV_AUTH_HEADERS` | `false` | `apps/api/src/auth.ts` | Allows `x-org-id` and `x-user-id` dev auth headers even when production would otherwise reject them. |
| `SUPABASE_URL` | unset | `apps/api/src/auth.ts` | Supabase project URL for JWT auth. |
| `SUPABASE_SERVICE_ROLE_KEY` | unset | `apps/api/src/auth.ts` | Supabase service role key used by the API to verify auth context. |
| `VITE_SUPABASE_URL` | unset | `apps/web/src/auth.ts` | Browser Supabase URL for the login UI. |
| `VITE_SUPABASE_ANON_KEY` | unset | `apps/web/src/auth.ts` | Browser Supabase anon key for the login UI. |
| `VITE_API_URL` | `http://localhost:3001` | `apps/web/src/api.ts` | API base URL compiled into the Vite web app. |
| `VITE_DOCS_URL` | unset | `apps/web/src/docs-link.ts` | Optional credential-free HTTPS documentation URL compiled into the web app. When unset or invalid, Docs controls are hidden. |
| `JANUSLY_PUBLIC_APP_URL` | unset | reports, recovery handoff, alerts | Public web base URL used in generated links. Falls back to `JANUSLY_WEB_BASE_URL` in handoff routes. |
| `WORKOS_CLIENT_ID` | unset | `apps/api/src/workos.ts` | WorkOS client id for SSO code exchange. |
| `WORKOS_API_KEY` | unset | `apps/api/src/workos.ts` | WorkOS API key for SSO profile exchange. Secret; keep in `.env` or vault only. |
| `WORKOS_WEBHOOK_SECRET` | unset | `apps/api/src/routes/scim-routes.ts` | HMAC secret for WorkOS Directory Sync webhooks. Empty/unset rejects every webhook. |
| `JANUSLY_SSO_CALLBACK_URL` | unset | `apps/api/src/routes/sso-routes.ts` | Exact callback URL registered in WorkOS. |
| `JANUSLY_WEB_BASE_URL` | unset | `apps/api/src/routes/sso-routes.ts`, recovery handoff | Web URL used by SSO callback redirect and as fallback for generated links. |
| `ALLOW_DEV_SSO_BYPASS` | `false` | `apps/api/src/auth-policy.ts` | Local-development escape hatch for enforced-SSO orgs. Must be explicitly `true`. |

## Outbound HTTP Safety

| Variable | Default | Used by | Purpose |
| --- | --- | --- | --- |
| `ALLOW_PRIVATE_HTTP_TARGETS` | `false` | `packages/engine/src/http-policy.ts` | Allows localhost/private/link-local HTTP targets only when explicitly set to `true`. |
| `JANUSLY_HTTP_TIMEOUT_MS` | `30000` | `packages/engine/src/http-policy.ts` | Total timeout budget for outbound HTTP across redirects. |
| `JANUSLY_HTTP_MAX_RESPONSE_BYTES` | `1000000` | `packages/engine/src/http-policy.ts` | Maximum decoded response body size for `http` nodes and `http.request`. |
| `JANUSLY_HTTP_MAX_REDIRECTS` | `5` | `packages/engine/src/http-policy.ts` | Maximum redirect hops; each hop is revalidated through the SSRF policy. |
| `JANUSLY_HTTP_STREAM_PREVIEW_BYTES` | `65536` | `packages/engine/src/tool-registry.ts`, `org_configs.http.streamPreviewBytes` | Preview bytes persisted for streaming HTTP bodies. Range 1024..1048576 through tenant config. |

## AI Providers

| Variable | Default | Used by | Purpose |
| --- | --- | --- | --- |
| `OPENAI_API_KEY` | unset | `packages/ai` | Enables the registered OpenAI provider for future verification work. Not a supported MVP runtime target; without the selected provider key, callers stay in fallback mode. |
| `OPENAI_MODEL` | `gpt-4o-mini` | `packages/ai`, `apps/api` | Default OpenAI model for the compatibility registry. Not a supported MVP runtime target. |
| `OPENAI_TIMEOUT_MS` | `30000` | `packages/ai`, `apps/api` | LLM request timeout. Shared by registered providers for now. |
| `OPENAI_MAX_RETRIES` | `2` | `packages/ai`, `apps/api` | AI SDK retry count for LLM calls. |
| `AI_PROMPT_MAX_CHARS` | `4000` | `apps/api` | Prompt length cap for AI endpoints. |
| `AI_RATE_LIMIT_PER_MIN` | `30` | `apps/api` | Per-org AI rate limit window capacity. |
| `JANUSLY_LLM_PROVIDER` | `anthropic` (matches the supported posture; explicit set still recommended) | `packages/ai`, `apps/api` | Default provider registry key. Registered values: `openai`, `anthropic`. The supported runtime target is `anthropic` — see AGENTS.md "AI integration" for the operating posture. |
| `ANTHROPIC_API_KEY` | unset | `packages/ai` | Enables Anthropic-backed AI calls and explicit `anthropic/model` overrides. |
| `ANTHROPIC_MODEL` | `claude-haiku-4-5-20251001` | `packages/ai`, `apps/api` | Default Anthropic model. |
| `ANTHROPIC_BASE_URL` | Anthropic SDK default | `packages/ai` | Optional Anthropic-compatible proxy endpoint. The canonical host is normalized to `/v1`; custom URLs are preserved without a trailing slash. The local Recovery Lab points this at its loopback simulator. |
| `JANUSLY_LLM_SIMULATED_PROVIDERS` | unset | local Recovery Lab only | Comma-separated provider names whose local-compatible calls must be labeled simulated and costed at zero. Ignored unless both `JANUSLY_LOCAL_STACK=true` and `JANUSLY_LOCAL_INTEGRATION_SIMULATOR=true`; never use it to describe live provider traffic. |
| `JANUSLY_LLM_PRICE_<MODEL>` | built-in pricing table | `packages/ai/src/pricing.ts` | Optional cost override as `<inputUsdPer1M>,<outputUsdPer1M>`, for example `JANUSLY_LLM_PRICE_GPT_4O_MINI=0.15,0.60` or `JANUSLY_LLM_PRICE_CLAUDE_HAIKU_4_5=1.00,5.00`. |

## Memory And Embeddings

Persistent memory is off by default and requires both the process flag and the
tenant flag:

```http
POST /org/config
Content-Type: application/json

{ "key": "memory.enabled", "value": true }
```

Then opt in at least one writable kind through `memory.allowedKinds`, for
example `recovery_rationale,patch_rationale`. See
[`docs/memory-policy.md`](memory-policy.md) for eligibility, retention,
deletion/export posture, and rollout approvals.

| Variable | Default | Used by | Purpose |
| --- | --- | --- | --- |
| `JANUSLY_MEMORY_ENABLED` | unset / false | `packages/data/src/memoryConsent.ts` | Process-level kill switch. Must be exactly `true` for memory commit/recall to run. |
| `JANUSLY_EMBEDDING_PROVIDER` | `ollama` | `packages/ai/src/embeddings.ts` | Process default embedding provider. Only `ollama` is wired in v1; other catalog values fail closed until implemented. |
| `JANUSLY_EMBEDDING_MODEL` | `bge-m3` | `packages/ai/src/embeddings.ts` | Process default embedding model. `bge-m3` produces the 1024-dim vector expected by `memory_entries.embedding`. |
| `OLLAMA_BASE_URL` | `http://ollama:11434` in code | `packages/ai/src/embeddings.ts` | Ollama endpoint. `scripts/run-dev.mjs` supplies `http://127.0.0.1:11434` to host-side API/worker children unless the caller overrides it. |
| `JANUSLY_OLLAMA_TIMEOUT_MS` | `30000` | `packages/ai/src/embeddings.ts` | Embedding HTTP timeout. Failures return a stable error envelope and do not persist a memory row. |
| `JANUSLY_MEMORY_RETENTION_CRON` | `0 3 * * *` | `packages/engine/src/memory-retention-scheduler.ts` | UTC cron for the global expired-memory sweep. Invalid values warn and fall back to the default. |
| `JANUSLY_MEMORY_PURGE_DELAY_MS` | `604800000` (7 days) | `packages/engine/src/memory-purge-scheduler.ts` | Delay before consent-revocation bulk purge. Positive integer milliseconds; invalid values warn and fall back to 7 days. |

## MCP Server

| Variable | Default | Used by | Purpose |
| --- | --- | --- | --- |
| `JANUSLY_API_URL` | `http://127.0.0.1:3001` | `packages/mcp-server` | API base URL the MCP server proxies to. |
| `JANUSLY_API_ORG_ID` | `default` | `packages/mcp-server` | Org id sent as `x-org-id`. |
| `JANUSLY_API_USER_ID` | `mcp-user` | `packages/mcp-server` | User id sent as `x-user-id` and used in audit attribution. |
| `JANUSLY_API_SERVICE_TOKEN` | unset | `packages/mcp-server` | Optional Bearer token sent to the API; should match `API_SERVICE_TOKEN` server-side. |
| `JANUSLY_MCP_WRITES_ENABLED` | `false` | `packages/mcp-server`, API MCP-write gate | Process-wide half of the MCP-server write gate. Tenant `mcp.writeConsent=true` is also required. |

## MCP Client

These env vars apply to Janusly's `mcp_tool` workflow node, which calls
external MCP servers. URL transports still use the HTTP SSRF guard; stdio
transports additionally use the sandbox settings below.

| Variable | Default | Used by | Purpose |
| --- | --- | --- | --- |
| `JANUSLY_MCP_ALLOWED_COMMANDS` | unset / empty | `apps/api/src/routes/mcp-routes.ts`, `packages/engine/src/mcp-tool-executor.ts` | Process command allowlist for stdio MCP registration and spawn-time re-check. Empty env plus empty tenant allowlist fails closed. |
| `JANUSLY_MCP_CLIENT_WRITES_ENABLED` | `false` | `packages/engine/src/mcp-tool-executor.ts` | Process-wide half of the external MCP write-tool gate. Tenant `mcp.clientWriteConsent=true` is also required. |
| `JANUSLY_MCP_CLIENT_RATE_LIMIT_PER_MIN` | `60` | `packages/engine/src/mcp-tool-executor.ts` | Env fallback for per-org external MCP tool rate limits. |
| `JANUSLY_MCP_STDIO_MAX_LIFETIME_MS` | `600000` | `org_configs.mcp.stdioMaxLifetimeMs` | Env fallback for stdio child lifetime cap. Range 60000..3600000. |
| `JANUSLY_MCP_STDIO_MAX_STDERR_BYTES` | `65536` | `org_configs.mcp.stdioMaxStderrBytes` | Env fallback for captured stderr cap. Range 1024..1048576. |
| `JANUSLY_MCP_STDIO_MAX_VM_KB` | `524288` | `org_configs.mcp.stdioMaxVmKb` | Env fallback for Linux virtual-memory cap. Range 131072..4194304. |
| `JANUSLY_MCP_SANDBOX_ENFORCE_LINUX` | auto | `packages/engine/src/mcp-tool-executor.ts` | `true`/`false` override for Linux `ulimit -v`. Default is enabled only on Linux production. |

## Email, Integrations, And Object Store

| Variable | Default | Used by | Purpose |
| --- | --- | --- | --- |
| `JANUSLY_MAILER_PROVIDER` | `noop` | `packages/engine/src/mailer.ts` | Mailer backend for `email.send`: `noop`, `resend`, `sendgrid`, or the explicitly gated local `simulator`. |
| `JANUSLY_MAILER_FROM` | `onboarding@resend.dev` | `packages/engine/src/tool-registry.ts` | Default sender address when the workflow/tool input omits `from`. |
| `JANUSLY_EMAIL_RATE_LIMIT_PER_MIN` | `100` | `org_configs.email.rateLimitPerMin` | Per-org `email.send` limit fallback. |
| `RESEND_API_KEY` | unset | `packages/engine/src/mailer.ts` | Resend API key. Required only when provider is `resend`. |
| `SENDGRID_API_KEY` | unset | `packages/engine/src/mailer.ts` | SendGrid API key. Required only when provider is `sendgrid`. |
| `JANUSLY_SLACK_RATE_LIMIT_PER_MIN` | `60` | integration tool rate limits | Env fallback for `slack.post`. |
| `JANUSLY_GITHUB_RATE_LIMIT_PER_MIN` | `60` | integration tool rate limits | Env fallback for `github.create_issue`. |
| `JANUSLY_WEBHOOK_RATE_LIMIT_PER_MIN` | `120` | integration tool rate limits | Env fallback for `webhook.send`. |
| `JANUSLY_PDF_RATE_LIMIT_PER_MIN` | `30` | integration tool rate limits | Env fallback for `pdf.generate`. |
| `JANUSLY_OBJECT_STORE_PROVIDER` | `noop` | `packages/engine/src/object-store.ts` | Object-store backend for PDF output: `noop`, `local`, or `s3`. |
| `JANUSLY_OBJECT_STORE_LOCAL_DIR` | unset | `packages/engine/src/object-store.ts` | Required when provider is `local`; generated objects are written under this directory. |
| `JANUSLY_OBJECT_STORE_BUCKET` | unset | `packages/engine/src/object-store.ts` | Required when provider is `s3`; AWS SDK env chain supplies credentials. |
| `JANUSLY_OBJECT_STORE_REGION` | SDK default | `packages/engine/src/object-store.ts` | Region passed to the S3-compatible client. |
| `JANUSLY_OBJECT_STORE_ENDPOINT` | unset | `packages/engine/src/object-store.ts` | Optional S3-compatible endpoint for MinIO/R2/Backblaze-style stores. |
| `JANUSLY_OBJECT_STORE_PUBLIC_BASE_URL` | unset | `packages/engine/src/object-store.ts` | Optional public URL prefix; when absent, S3 mode returns presigned URLs. |
| `JANUSLY_OBJECT_STORE_PRESIGNED_TTL_SEC` | `3600` | `packages/engine/src/object-store.ts` | Presigned URL TTL in seconds for S3 mode. |
| `JANUSLY_PUBLIC_API_URL` | unset | Slack interaction connection routes | Optional public API origin used to return absolute signed Slack callback URLs. It contains no credentials. PagerDuty callback URLs are derived in the workflow Inspector from the web app's configured API origin. |

### Local integration simulator

These variables are for the loopback-only profile in
[`docs/local-deployment.md`](local-deployment.md). They are not production
integration settings.

| Variable | Default | Used by | Purpose |
| --- | --- | --- | --- |
| `JANUSLY_LOCAL_INTEGRATION_SIMULATOR` | `false` | integration tools and mailer | Master process gate. Only the exact string `true` enables simulator routing. |
| `JANUSLY_LOCAL_INTEGRATION_SIMULATOR_URL` | unset | integration simulator routing | Process-owned simulator base URL. Credentials, query strings, and fragments are rejected. PagerDuty uses its `/pagerduty` API projection only when this gate is true. |
| `JANUSLY_LOCAL_STACK` | `false` | explicit smoke fixtures | Required marker before qualification-only credential/config fixtures can run. Normal startup never invokes them. |
| `JANUSLY_LOCAL_ORG_ID` | `default` | smoke scripts | Development organization exercised only by explicit provider qualification. |
| `JANUSLY_RECOVERY_LAB_ORG_ID` | `local-recovery-lab` | Real Recovery Lab scripts | Isolated organization used by `local:recovery-lab`; must begin with `local-recovery-lab` so cleanup cannot target an ordinary tenant. |

The Compose-specific `JANUSLY_LOCAL_*_PORT`, sender, and browser URL settings
are documented in the tracked `deploy/local/local.env.example`. The Supabase
CLI-generated `DB_URL` is transformed into the container-only
`JANUSLY_LOCAL_DATABASE_URL` in memory; it is never copied into that file.
Simulator delivery still requires normal credential rows. They can use managed
values or legacy environment references. Explicit smoke commands create only
the bounded references required for their own run.

Every persistent local profile starts the pinned `supabase/config.toml`
PostgreSQL database on host port `7432`; Supabase owns `auth` and Janusly owns
`public`. `pnpm local:auth:up` additionally injects the local API URL plus
anonymous/service credentials from `supabase status -o env` and forces
`ALLOW_DEV_AUTH_HEADERS=false`. Auth uses host port `7431`. Supabase CLI may
publish both ports on every host interface, so this is trusted-workstation
development infrastructure rather than a network-safe deployment. Generated
database/Auth credentials remain in process memory.

The persistent stack loads its ignored `deploy/local/local.env` into the API
and worker only and mounts its independently ignored generated credential root
key read-only. With `JANUSLY_LOCAL_INTEGRATION_SIMULATOR=false`, create managed
credential rows manually from the UI (recommended), or deliberately choose
legacy references such as `GITHUB_TOKEN`, `SLACK_WEBHOOK_URL`, or
`WEBHOOK_SIGNING_SECRET`. Startup never creates or rewrites credential rows.
The web image receives neither the local env file nor the root key. See
[`docs/local-deployment.md`](local-deployment.md#opt-in-external-providers) for
the safe switching procedure and smoke-command boundary.

`.env.example` includes sample legacy credential env names such as
`SLACK_INCIDENTS_WEBHOOK_URL`, `GITHUB_BOT_TOKEN`, and
`WEBHOOK_SIGNING_SECRET`. Those are examples referenced by
`credentials.secret_ref` rows, not fixed platform config keys; deployments can
choose their own names.

## System Schedulers And Retention

Invalid cron values warn and fall back to the documented defaults; scheduler
registration failures log and do not block process boot.

| Variable | Default | Used by | Purpose |
| --- | --- | --- | --- |
| `JANUSLY_RETENTION_CRON` | `0 5 * * *` | `packages/engine/src/retention-scheduler.ts` | Daily per-org retention sweep across run events, audit logs, usage events, recovery feedback, and memory entries. |
| `JANUSLY_RETENTION_RUN_EVENTS_DAYS` | `90` | `org_configs.retention.runEventsDays` | Env fallback for per-org run-event retention. |
| `JANUSLY_RETENTION_AUDIT_LOGS_DAYS` | `365` | `org_configs.retention.auditLogsDays` | Env fallback for per-org audit-log retention. |
| `JANUSLY_RETENTION_USAGE_EVENTS_DAYS` | `90` | `org_configs.retention.usageEventsDays` | Env fallback for per-org usage-event retention. |
| `JANUSLY_RETENTION_RECOVERY_FEEDBACK_DAYS` | `180` | `org_configs.retention.recoveryFeedbackDays` | Env fallback for per-org recovery-feedback retention. |
| `JANUSLY_RETENTION_MEMORY_ENTRIES_DAYS` | `90` | `org_configs.retention.memoryEntriesDays` | Env fallback for per-org memory-entry retention. |
| `JANUSLY_RETENTION_DELETED_WORKFLOWS_DAYS` | `30` | `org_configs.retention.deletedWorkflowsDays` | Env fallback for the soft-deleted-workflow recovery window before the retention sweep hard-purges. |
| `JANUSLY_AUDIT_LOGS_RETENTION_CRON` | `0 2 * * *` | `packages/engine/src/audit-logs-retention-scheduler.ts` | Global audit-log retention scheduler. |
| `JANUSLY_AUDIT_LOGS_RETENTION_DAYS` | `730` | `packages/engine/src/audit-logs-retention-scheduler.ts` | Global audit-log retention window. Range 30..3650. |
| `JANUSLY_SCIM_EVENTS_RETENTION_CRON` | `0 4 * * *` | `packages/engine/src/scim-events-retention-scheduler.ts` | Global SCIM dedup-event retention scheduler. |
| `JANUSLY_SCIM_EVENTS_RETENTION_DAYS` | `90` | `packages/engine/src/scim-events-retention-scheduler.ts` | Global SCIM processed-event retention window. Range 7..365. |
| `JANUSLY_UPSTREAM_HEALTH_CRON` | `* * * * *` | `packages/engine/src/upstream-health-poller.ts` | Tick cadence for upstream source checks; each source's own interval still gates actual polling. |

## Auto-Healing And Alerts

Both optional queue Workers live in the API process. Environment changes are
read at process startup: restart the API after changing these values, but do
not restart Redis. BullMQ scheduler ids are deterministic, so the next boot
refreshes their cadence without duplicating them. See
[`observability.md`](observability.md#queue-topology-and-activation) for the
complete four-queue topology and operational recommendations.

| Variable | Default | Used by | Purpose |
| --- | --- | --- | --- |
| `JANUSLY_AUTO_HEALING_ENABLED` | `false` | API auto-healing scanner/watcher, engine consent | Process half of supervised auto-healing. The tenant must also set `autoHealing.enabled=true`; start with this enabled and auto-apply disabled. |
| `JANUSLY_AUTO_HEALING_AUTO_APPLY` | `false` | `packages/engine/src/auto-healing-consent.ts` | Process half of the auto-apply gate; tenant policy must also allow it. |
| `JANUSLY_AUTO_HEALING_SCAN_CRON` | `0 */6 * * *` | `apps/api/src/auto-healing-scanner.ts` | Recurring scan cadence for DLQ clusters eligible for AI repair proposals. |
| `JANUSLY_AUTO_HEALING_WATCH_CRON` | `* * * * *` | `apps/api/src/auto-healing-watcher.ts` | Watcher cadence for validation/proposal follow-up work. |
| `JANUSLY_ALERTS_ENABLED` | `false` | `apps/api/src/alerts-bootstrap.ts`, `apps/api/src/alerts/scanner.ts` | Enables the periodic state scanner and its queue Worker. Event-driven dispatch remains registered for matching policies when this is false. |
| `JANUSLY_ALERTS_SCAN_CRON` | `*/2 * * * *` | `apps/api/src/alerts/scanner.ts` | Alert policy scan cadence. |

## Observability

The ready-to-run local Grafana/Prometheus/Tempo/Alloy stack and the Grafana
Cloud forwarding profile are documented in [`observability.md`](observability.md).
Janusly process env changes require an API/worker restart; they never require a
Redis restart.

| Variable | Default | Used by | Purpose |
| --- | --- | --- | --- |
| `OTEL_METRICS_HOST` | `127.0.0.1` | `apps/api`, `packages/engine/src/worker.ts` | Process-local Prometheus bind host. Set a reachable interface such as `0.0.0.0` only when a remote scraper requires it and network policy protects the endpoint. |
| `OTEL_METRICS_PORT` | API `9464`; worker `9465` | `apps/api`, `packages/engine/src/worker.ts` | Per-process Prometheus exporter port. Override per service when multiple replicas share a host. Bind conflicts fail process startup instead of silently dropping telemetry. |
| `JANUSLY_QUEUE_LAG_WARN_SECONDS` | `60` | `apps/api/src/queue-health.ts` | Oldest-waiting-job age that marks queue pressure degraded. Integer range 1..86400; invalid values use the default. |
| `JANUSLY_MAINTENANCE_QUEUE_LAG_WARN_SECONDS` | `300` | `apps/api/src/queue-health.ts` | Independent oldest-waiting threshold for maintenance jobs. Integer range 1..86400; invalid values use the default. |
| `OTEL_SERVICE_INSTANCE_ID` | `HOSTNAME`, then `os.hostname()` | `packages/engine/src/observability/resource.ts` | Stable OpenTelemetry `service.instance.id`. |
| `HOSTNAME` | system-provided | `packages/engine/src/observability/resource.ts` | Fallback instance id in containerized environments. |
| `OTEL_EXPORTER` | `console` when unset | `packages/engine/src/observability/trace-exporter.ts` | Trace delivery mode: `console` for local development or `otlp` for batched OTLP/HTTP export. Any other value fails startup. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | `http://localhost:4318/v1/traces` | `packages/engine/src/observability/trace-exporter.ts` | Exact OTLP/HTTP traces endpoint. Takes precedence over the shared base endpoint. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | unset | `packages/engine/src/observability/trace-exporter.ts` | Shared OTLP base URL; Janusly appends `/v1/traces` when the trace-specific endpoint is absent. |

`OTEL_EXPORTER=jaeger` and `OTEL_EXPORTER_JAEGER_ENDPOINT` are no longer
supported. Point Jaeger deployments at a Collector or Jaeger's native OTLP
HTTP receiver and use `OTEL_EXPORTER=otlp`; Janusly deliberately does not
reinterpret the old `/api/traces` URL as an OTLP endpoint.

## Local Test And Eval Helpers

| Variable | Default | Used by | Purpose |
| --- | --- | --- | --- |
| `JANUSLY_EVALS_API_URL` | `http://127.0.0.1:3001` | `scripts/run-evals.mjs` | API target for `pnpm evals`. |
| `SMOKE` | unset | `scripts/model-eval-compare.ts` | Set to `1` to run the cheap one-prompt model comparison (`haiku` constrained vs `haiku-free`). |
| `SAMPLES` | `1` | `scripts/model-eval-compare.ts` | Number of samples per prompt/config for the manual model A/B harness. |
| `ONLY` | unset | `scripts/model-eval-compare.ts` | Comma-separated config keys to run, e.g. `haiku-free,sonnet`. |
| `PLAYWRIGHT_BASE_URL` | `http://127.0.0.1:5173` | `apps/web/playwright.config.ts` | Browser e2e base URL. |
| `PLAYWRIGHT_SKIP_WEB_SERVER` | unset | `apps/web/playwright.config.ts` | Set to `1` when an external web server is already running. |
| `CI` | unset | Playwright, scripts | CI mode switch for reporters and server reuse. |

## Dynamic Workflow Variables

Workflow authors can reference arbitrary environment variables at runtime:

| Pattern | Used by | Purpose |
| --- | --- | --- |
| `{{secret.NAME}}` | `packages/engine/src/secrets.ts` | Resolves `process.env.NAME` directly; missing values throw. Use for deploy-time secrets that do not need an operator-managed `credentials` row. |
| `{{env.NAME}}` | `packages/engine/src/template.ts` | Resolves `process.env.NAME`; resolved values are added to the redaction list when long enough to redact safely. |

These names are intentionally open-ended, so they are not enumerated in
`.env.example`. Add deployment-specific entries to `.env` or your secret
manager.
