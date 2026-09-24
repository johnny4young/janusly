# Environment reference

This is the classified reference for the application, its CLI/build inputs and
its local qualification boundaries. Read [Configuration](configuration.md) for
setup and production requirements. Values below are defaults and constraints
from source, **never values collected from a running process**.

## Reading the inventory

- **Process**: server/operator control. An environment change requires restarting
  the affected executable, even where a legacy helper reads it per operation.
  No tenant override exists unless the tenant table below explicitly lists one.
  Only entries marked *boot validation* (plus the four HTTP fallbacks) share the
  strict aggregated `config.Load` gate. Other rows state their actual fallback or
  feature-boundary behavior; this reference does not claim universal boot validation.
- **Tenant**: valid database row → environment fallback → catalog default. Tenant
  edits affect subsequent operations/claims without restart; in-flight snapshots
  remain unchanged. Deployment environment changes still require restart.
- **Secret**: authority-bearing material or its control/path; never log values,
  put them in `org_configs`, or forward them to browser builds. Inline master key
  wins over file, and the successful key is cached until restart. Rotation of a
  root encryption key requires a separate credential migration, not just an env edit.
- **Platform**, **Build**, **CLI**, **Harness** and **Unsupported** are separate
  owners, not extra business settings. Build inputs require a rebuild; CLI/harness
  inputs apply on the next invocation. Platform SDK configuration follows its SDK.

For numeric boot settings, empty/whitespace selects the default; invalid input
fails with a key/range-only error. A decimal range is inclusive. A string/path/URL
has no numeric range. Exact-`true` switches treat other values as false unless a
row explicitly says otherwise. Source paths abbreviated below are under
`internal/` unless they start with `cmd/`, `web/`, `website/` or `Dockerfile`.
Compose only forwards keys declared in its environment/build sections: adding a
key to the host `.env` does not automatically forward it into a container.

## Process, credentials, platform and command inputs

| Variable | Category | Type, default, accepted values and behavior | Source / owner |
| --- | --- | --- | --- |
| `JANUSLY_ENV` | Process | string; `development`; trimmed case-insensitive `production` enables production posture | `internal/config/config.go`; boot validation |
| `JANUSLY_PORT` | Process | integer; `3001`; 1–65535; must differ from internal port | `internal/config/config.go`; boot validation |
| `JANUSLY_INTERNAL_PORT` | Process | integer; `9464`; 1–65535; must differ from public port | `internal/config/config.go`; boot validation |
| `JANUSLY_INTERNAL_HOST` | Process | string; `127.0.0.1`; only `127.0.0.1`, `::1`, `0.0.0.0`, `::` | `internal/config/config.go`; boot validation |
| `JANUSLY_WORKER_CONCURRENCY` | Process | integer; `8`; 1–64 | `internal/config/config.go`; boot validation |
| `JANUSLY_API_POOL_SIZE` | Process | integer; `10`; 1–100 | `internal/config/config.go`; boot validation |
| `JANUSLY_WORKER_POOL_SIZE` | Process | integer; `0`; 0–100; zero derives worker concurrency plus two | `internal/config/config.go`; boot validation |
| `JANUSLY_POLL_MS` | Process | integer milliseconds; `250`; 50–5000 | `internal/config/config.go`; boot validation |
| `JANUSLY_DB_TOOL_MAX_PROCESS_POOLS` | Process | integer; `25`; 1–500; separate external pool owner, including retired active leases | `internal/config/config.go`; boot validation |
| `JANUSLY_PERSIST_MAX_BYTES` | Process | integer bytes; `256000`; 2–maximum platform signed integer; explicit column caps still win | `internal/config/config.go`; boot validation |
| `JANUSLY_REAPER_INTERVAL_MS` | Process | integer milliseconds; `60000`; 1–9223372035854 | `internal/config/config.go`; boot validation |
| `JANUSLY_REAPER_THRESHOLD_MS` | Process | integer milliseconds; `3600000`; 1–9223372035854; effective age is max(threshold, floor) | `internal/config/config.go`; boot validation |
| `JANUSLY_REAPER_THRESHOLD_FLOOR_MS` | Process | integer milliseconds; `900000`; 1–9223372035854; explicit lowering is logged | `internal/config/config.go`; boot validation |
| `JANUSLY_FEEDBACK_MEMORY_WORKERS` | Process | integer; `4`; 1–32 | `internal/config/config.go`; boot validation |
| `JANUSLY_FEEDBACK_MEMORY_QUEUE_CAPACITY` | Process | integer; `256`; 1–4096 | `internal/config/config.go`; boot validation |
| `JANUSLY_FEEDBACK_MEMORY_TIMEOUT_MS` | Process | integer milliseconds; `15000`; 1000–300000 | `internal/config/config.go`; boot validation |
| `JANUSLY_LOG_LEVEL` | Process | enum; `info`; debug/info/warn/warning/error, case-insensitive; unknown → info | `boot/boot.go` |
| `JANUSLY_START_RATE_LIMIT_PER_MIN` | Process | positive integer; `30000`; invalid/nonpositive → default; explicit V1Server option wins | `httpapi/runroutes.go` |
| `JANUSLY_QUEUE_LAG_WARN_SECONDS` | Process | integer seconds; `60`; 1–86400; invalid → default | `httpapi/health.go` |
| `JANUSLY_MAINTENANCE_QUEUE_LAG_WARN_SECONDS` | Process | integer seconds; `300`; 1–86400; invalid → default | `httpapi/health.go` |
| `JANUSLY_MEMORY_PURGE_DELAY_HOURS` | Process | integer hours; `168`; 0–720; invalid → default; controls revocation grace, not per-kind retention | `engine/memorypurge.go` |
| `JANUSLY_SESSION_COOKIE_SECURE` | Process | boolean strings true/false; unset/other → HTTPS scheme of WEB_BASE_URL | `browsersession/browsersession.go` |
| `API_ALLOWED_ORIGINS` | Process | comma-separated exact origins; localhost and 127.0.0.1 ports 5173/5174; wildcard accepted only outside production | `httpapi/cors.go` |
| `JANUSLY_BROWSER_CONNECT_ORIGINS` | Process | comma-separated origins; empty; only explicit loopback HTTP origins extend browser CSP; others ignored | `httpapi/cors.go` |
| `JANUSLY_TRUSTED_PROXY` | Process | exact `true` enables first X-Forwarded-For hop; default false; only behind a header-overwriting proxy | `httpapi/cors.go` |
| `ALLOW_PRIVATE_HTTP_TARGETS` | Process | exact `true` permits private outbound targets; default false; does not disable other SSRF/redirect/DNS/byte guards | `executors/http.go` |
| `ALLOW_DEV_AUTH_HEADERS` | Process | exact `true` enables dev headers; unset/false still auto-allows them outside production when Supabase is absent; production with configured Supabase refuses true; without Supabase production requires explicit true | `auth/auth.go` |
| `ALLOW_DEV_SSO_BYPASS` | Process | exact `true`; default false; refused in production, including evaluator defense in depth | `authpolicy/policy.go; cmd/api/main.go` |
| `JANUSLY_REQUIRE_EVAL_COVERAGE` | Process | exact `true`; default false; adds readiness coverage checks | `workflowreadiness/readiness.go` |
| `JANUSLY_AGENT_WRITES_ENABLED` | Process | exact `true`; default false; also needs tenant consent, workflow opt-in and dominating approval | `engine/dispatch.go` |
| `JANUSLY_MCP_WRITES_ENABLED` | Process | exact `true`; default false; also needs tenant consent and explicit permission | `mcpserver/guard.go` |
| `JANUSLY_MCP_CLIENT_WRITES_ENABLED` | Process | exact `true`; default false; also needs tenant client-write consent | `mcpclient/mcpclient.go` |
| `JANUSLY_MEMORY_ENABLED` | Process | exact `true`; default false; also needs tenant memory consent | `memory/memory.go` |
| `JANUSLY_AUTO_HEALING_ENABLED` | Process | exact `true`; default false; also needs tenant auto-healing consent; proposals remain operator-applied | `engine/autohealing.go` |
| `JANUSLY_CIRCUIT_BREAKER_ENABLED` | Process | enabled unless exact `false`; workflow opt-out and workflow/tenant thresholds remain independent | `recovery/circuitbreaker.go` |
| `JANUSLY_MCP_PERMISSIONS` | Process | comma/whitespace-separated permission names; omitted → built-in read-only set; unknown entries reject MCP startup before database access/workers, without echoing input | `mcpserver/guard.go` |
| `JANUSLY_ORG` | Process | string; `default`; organization bound to the stdio MCP server | `cmd/mcp/main.go` |
| `JANUSLY_SSO_CALLBACK_URL` | Process | URL string; empty; required by WorkOS SSO flows; must match provider registration | `httpapi/sso.go` |
| `JANUSLY_WEB_BASE_URL` | Process | URL string; empty; browser-session secure-cookie fallback and SSO return origin | `httpapi/sso.go; browsersession/browsersession.go` |
| `JANUSLY_PUBLIC_APP_URL` | Process | URL string; empty; optional report-link prefix; no provider discovery or implicit deployment | `httpapi/reports.go` |
| `JANUSLY_OBJECT_STORE_BUCKET` | Process | string; empty; required to select S3 storage | `objectstore/objectstore.go; objectstore/sigv4.go` |
| `JANUSLY_OBJECT_STORE_REGION` | Process | string; `us-east-1`; SigV4 region | `objectstore/sigv4.go` |
| `JANUSLY_OBJECT_STORE_ENDPOINT` | Process | URL string; empty → AWS endpoint; explicit endpoint uses path-style addressing | `objectstore/sigv4.go` |
| `JANUSLY_OBJECT_STORE_PUBLIC_BASE_URL` | Process | URL string; empty → presigned GET; optional public/CDN prefix | `objectstore/sigv4.go` |
| `JANUSLY_OBJECT_STORE_LOCAL_DIR` | Process | directory path; empty; local provider requires it; paths remain tenant-scoped | `objectstore/objectstore.go` |
| `JANUSLY_OBJECT_STORE_PRESIGN_TTL_SECONDS` | Process | integer seconds; `3600`; 1–604800; invalid → default | `objectstore/sigv4.go` |
| `JANUSLY_LOCAL_STACK` | Process | exact `true`; default false; must be paired with integration simulator gate; rejected in production | `config/config.go; tools/integration.go` |
| `JANUSLY_LOCAL_INTEGRATION_SIMULATOR` | Process | exact `true`; default false; must be paired with LOCAL_STACK; rejected in production | `config/config.go; tools/integration.go` |
| `JANUSLY_LOCAL_INTEGRATION_SIMULATOR_URL` | Process | URL string; empty; only consulted behind both local gates | `tools/integration.go; tools/email.go; tools/pagerduty.go` |
| `JANUSLY_LLM_SIMULATED_PROVIDERS` | Process | comma-separated provider names; empty; only anthropic recognized, after both local gates | `aiconfig/aiconfig.go` |
| `JANUSLY_LLM_SIMULATOR_BASE_URL` | Process | HTTP(S) URL; empty; requested simulator with invalid URL disables provider rather than leaking a live key | `aiconfig/aiconfig.go` |
| `JANUSLY_ACCESS_LOG` | Process | enum; `errors`; all/errors/off; none aliases off; unknown → errors; includes slow requests >1s | `httpapi/requestmetrics.go` |
| `JANUSLY_DB_TRACING` | Process | on/true or off/false; other/unset follows nonempty non-none OTEL_EXPORTER | `boot/boot.go` |
| `JANUSLY_SHEET_RATE_LIMIT_PER_MIN` | Process | positive integer; `60`; invalid → default; no catalog tenant override | `engine/integrationdeps.go; tools/sheet.go` |
| `JANUSLY_PAGERDUTY_RATE_LIMIT_PER_MIN` | Process | positive integer; `120`; invalid → default; no catalog tenant override | `engine/integrationdeps.go; tools/pagerduty.go` |
| `JANUSLY_DATABASE_URL` | Secret | PostgreSQL18 DSN; local janusly DB on 127.0.0.1:15473; boot connects/probes; may contain a password | `internal/config/config.go; boot/boot.go` |
| `JANUSLY_RESUME_TOKEN_SECRET` | Secret | opaque signing secret; required in production; development fallback only; rotation invalidates old tokens | `internal/tokenhmac/tokenhmac.go` |
| `JANUSLY_CREDENTIAL_MASTER_KEY` | Secret | 32-byte key encoded as base64 or 64 hex digits; empty; inline wins over file; loaded key is cached | `internal/secretstore/secretstore.go` |
| `JANUSLY_CREDENTIAL_MASTER_KEY_FILE` | Secret | path to encoded 32-byte key; empty; only used without inline key; back up separately from database | `internal/secretstore/secretstore.go` |
| `JANUSLY_CREDENTIAL_ENV_ALLOWLIST` | Secret | comma-separated exact names/PREFIX_*; empty → reserved-namespace restriction only; reserved always wins | `internal/secretstore/envpolicy.go` |
| `JANUSLY_API_SERVICE_TOKEN` | Secret | opaque token; empty disables this service-token credential; never a browser build value | `internal/auth/auth.go` |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret | server key; empty; used with SUPABASE_URL; never expose to browser | `internal/auth/auth.go` |
| `WORKOS_API_KEY` | Secret | server API key; empty; WorkOS client requires its companion client ID | `internal/workos/client.go` |
| `WORKOS_WEBHOOK_SECRET` | Secret | signature secret; empty causes signed-directory events to fail verification | `internal/httpapi/scim/webhook.go` |
| `ANTHROPIC_API_KEY` | Secret | provider key; empty → deterministic AI fallback; local simulator never receives this value | `internal/aiconfig/aiconfig.go` |
| `RESEND_API_KEY` | Secret | provider key; empty leaves requested Resend provider unavailable/noop | `internal/tools/email.go` |
| `SENDGRID_API_KEY` | Secret | provider key; empty leaves requested SendGrid provider unavailable/noop | `internal/tools/email.go` |
| `AWS_ACCESS_KEY_ID` | Secret | S3 signing identifier; empty fails S3 credential check; treat as credential metadata | `internal/objectstore/sigv4.go` |
| `AWS_SECRET_ACCESS_KEY` | Secret | S3 signing key; empty fails S3 credential check | `internal/objectstore/sigv4.go` |
| `SUPABASE_URL` | Platform | URL string; empty; server identity-provider endpoint | `internal/auth/auth.go` |
| `WORKOS_CLIENT_ID` | Platform | string; empty; companion to WORKOS_API_KEY | `internal/workos/client.go` |
| `OTEL_EXPORTER` | Platform | enum; empty/none → no export; console or otlp; unknown rejects API initialization before database access, without echoing input; application selector, not SDK standard | `internal/observability/tracing.go` |
| `OTEL_SERVICE_INSTANCE_ID` | Platform | string; empty → HOSTNAME or generated identity; stable instance label | `internal/observability/tracing.go; cmd/api/main.go` |
| `HOSTNAME` | Platform | platform hostname; used only for instance identity fallback | `cmd/api/main.go`, `observability/tracing.go` |
| `PATH` | Platform | platform executable search path; the only inherited default environment entry of MCP children | `internal/mcpclient/mcpclient.go` |
| `JANUSLY_ADMIN_API` | CLI | URL; http://127.0.0.1:3001; applies on the next command invocation | `cmd/admin/main.go` or `cmd/seed/main.go`; not server aliases |
| `JANUSLY_ADMIN_ORG` | CLI | string; default; applies on the next command invocation | `cmd/admin/main.go` or `cmd/seed/main.go`; not server aliases |
| `JANUSLY_ADMIN_USER` | CLI | string; janusly-admin; applies on the next command invocation | `cmd/admin/main.go` or `cmd/seed/main.go`; not server aliases |
| `JANUSLY_ADMIN_TOKEN` | CLI | secret; fallback JANUSLY_API_SERVICE_TOKEN; applies on the next command invocation | `cmd/admin/main.go` or `cmd/seed/main.go`; not server aliases |
| `JANUSLY_SEED_API` | CLI | URL; http://127.0.0.1:3001; applies on the next command invocation | `cmd/admin/main.go` or `cmd/seed/main.go`; not server aliases |
| `JANUSLY_SEED_ORG` | CLI | string; demo-org; applies on the next command invocation | `cmd/admin/main.go` or `cmd/seed/main.go`; not server aliases |
| `JANUSLY_BUILD_ID` | Build | string; build-time display identity; omitted → date+Git shortSHA or dev | `web/vite.config.ts; Dockerfile`; rebuild, not restart |
| `JANUSLY_BUILD_COMMIT` | Build | 40-hex Git commit injected at build; production provenance gate | `Dockerfile`, `Makefile`, `internal/buildinfo/`; rebuild, not restart |
| `JANUSLY_BUILD_TREE` | Build | 40-hex Git tree injected at build; production provenance gate | `Dockerfile`, `Makefile`, `internal/buildinfo/`; rebuild, not restart |
| `VITE_SUPABASE_URL` | Build | public URL; empty → no browser Supabase client | `web/src/auth.ts; Dockerfile`; rebuild, not restart |
| `VITE_SUPABASE_ANON_KEY` | Build | public publishable/anon key; never use a server role key | `web/src/auth.ts; Dockerfile`; rebuild, not restart |
| `VITE_DOCS_URL` | Build | optional credential-free HTTP(S) docs URL; invalid/empty hides the link | `web/src/docs-link.ts`; rebuild, not restart |
| `PUBLIC_CF_ANALYTICS_TOKEN` | Build | optional public Cloudflare Web Analytics token, website only | `website/src/layouts/Base.astro`; rebuild, not restart |
| `JANUSLY_STALLED_NODE_THRESHOLD_MINUTES` | Unsupported | unsupported; boot rejects it; use REAPER_THRESHOLD_MS | Not an operator-tunable capability |
| `JANUSLY_MCP_STDIO_ALLOWED_COMMANDS` | Unsupported | unsupported legacy spelling; actual tenant fallback is JANUSLY_MCP_ALLOWED_COMMANDS | Not an operator-tunable capability |
| `JANUSLY_OLLAMA_TIMEOUT_MS` | Unsupported | unsupported; embedding call deadline is fixed at 10s | Not an operator-tunable capability |
| `JANUSLY_AUTO_HEALING_AUTO_APPLY` | Unsupported | unsupported; no process reader or automatic-apply implementation | Not an operator-tunable capability |
| `JANUSLY_RUNTIME_DRILL_MISSING_SECRET` | Unsupported | reserved negative-probe name; must remain unset, otherwise runtime drill refuses to run | Not an operator-tunable capability |

## Tenant environment fallbacks

The closed source of truth is `internal/orgconfig/catalog.go`; its JSON catalog
is also exposed through the authenticated organization configuration surface.
The table includes every `EnvKeys` entry, not all tenant keys. Permission/consent
keys without an environment fallback cannot be opted into globally.

New tenant writes use catalog validation; invalid stored rows fall through.
Non-HTTP numeric fallbacks accept finite numeric syntax and floor fractional
values unless the catalog permits fractions (`ai.budgetMonthlyUsd`). HTTP
fallbacks require whole numbers and reject invalid deployment values at boot.
Other invalid environment fallbacks revert to the catalog default; they are not
silently promoted to valid tenant writes. Boolean fallbacks accept exact
`true`/`false`. String validators and allowed values are catalog-owned.

| Variable | Category | Tenant key | Type | Catalog default | Inclusive range / allowed values |
| --- | --- | --- | --- | --- | --- |
| `JANUSLY_AI_GENERATION_CANDIDATES` | Tenant | `ai.generationCandidates` | number | `1` | 1..5 |
| `ANTHROPIC_MODEL` | Tenant | `ai.anthropic.model` | string | `"claude-haiku-4-5-20251001"` | catalog validator |
| `JANUSLY_LLM_TIMEOUT_MS` | Tenant | `ai.timeoutMs` | number | `30000` | 1..600000 |
| `JANUSLY_LLM_MAX_RETRIES` | Tenant | `ai.maxRetries` | number | `2` | 0..10 |
| `JANUSLY_LLM_MAX_OUTPUT_UNITS` | Tenant | `ai.maxOutputUnits` | number | `4096` | 256..16384 |
| `AI_PROMPT_MAX_CHARS` | Tenant | `ai.promptMaxChars` | number | `4000` | 1..65536 |
| `AI_RATE_LIMIT_PER_MIN` | Tenant | `ai.rateLimitPerMin` | number | `30` | 1..10000 |
| `JANUSLY_AI_BUDGET_MONTHLY_USD` | Tenant | `ai.budgetMonthlyUsd` | number | `0` | 0..unbounded |
| `JANUSLY_AI_BUDGET_WARN_PERCENT` | Tenant | `ai.budgetWarnPercent` | number | `80` | 0..100 |
| `JANUSLY_AI_BUDGET_EXCEEDED_POLICY` | Tenant | `ai.budgetExceededPolicy` | string | `"warn"` | warn, block |
| `JANUSLY_HTTP_TIMEOUT_MS` | Tenant | `http.timeoutMs` | number | `30000` | 1..600000 |
| `JANUSLY_HTTP_MAX_RESPONSE_BYTES` | Tenant | `http.maxResponseBytes` | number | `1000000` | 1..67108864 |
| `JANUSLY_HTTP_MAX_REDIRECTS` | Tenant | `http.maxRedirects` | number | `5` | 0..20 |
| `JANUSLY_HTTP_STREAM_PREVIEW_BYTES` | Tenant | `http.streamPreviewBytes` | number | `65536` | 1024..1048576 |
| `JANUSLY_MAILER_PROVIDER` | Tenant | `email.provider` | string | `"noop"` | resend, sendgrid, simulator, noop |
| `JANUSLY_MAILER_FROM` | Tenant | `email.from` | string | `"onboarding@resend.dev"` | catalog validator |
| `JANUSLY_EMAIL_RATE_LIMIT_PER_MIN` | Tenant | `email.rateLimitPerMin` | number | `100` | 1..unbounded |
| `JANUSLY_REQUIRE_SAVED_WORKFLOW` | Tenant | `runs.requireSavedWorkflow` | boolean | `false` | catalog validator |
| `JANUSLY_MAX_SUBWORKFLOW_DEPTH` | Tenant | `subworkflow.maxDepth` | number | `5` | 1..unbounded |
| `JANUSLY_STREAM_MAX_SUBSCRIPTIONS` | Tenant | `runs.streamMaxSubscriptions` | number | `50` | 1..1000 |
| `JANUSLY_MCP_CLIENT_RATE_LIMIT_PER_MIN` | Tenant | `mcp.clientRateLimitPerMin` | number | `60` | 1..unbounded |
| `JANUSLY_MCP_ALLOWED_COMMANDS` | Tenant | `mcp.clientCommandAllowlist` | string | `""` | catalog validator |
| `JANUSLY_MCP_STDIO_MAX_LIFETIME_MS` | Tenant | `mcp.stdioMaxLifetimeMs` | number | `600000` | 60000..3600000 |
| `JANUSLY_MCP_STDIO_MAX_STDERR_BYTES` | Tenant | `mcp.stdioMaxStderrBytes` | number | `65536` | 1024..1048576 |
| `JANUSLY_MCP_STDIO_MAX_VM_KB` | Tenant | `mcp.stdioMaxVmKb` | number | `524288` | 131072..4194304 |
| `JANUSLY_SLACK_RATE_LIMIT_PER_MIN` | Tenant | `slack.rateLimitPerMin` | number | `60` | 1..unbounded |
| `JANUSLY_GITHUB_RATE_LIMIT_PER_MIN` | Tenant | `github.rateLimitPerMin` | number | `60` | 1..unbounded |
| `JANUSLY_WEBHOOK_RATE_LIMIT_PER_MIN` | Tenant | `webhook.rateLimitPerMin` | number | `120` | 1..unbounded |
| `JANUSLY_PDF_RATE_LIMIT_PER_MIN` | Tenant | `pdf.rateLimitPerMin` | number | `30` | 1..unbounded |
| `JANUSLY_DB_TOOL_RATE_LIMIT_PER_MIN` | Tenant | `db.rateLimitPerMin` | number | `60` | 1..unbounded |
| `JANUSLY_OBJECT_STORE_PROVIDER` | Tenant | `objectstore.provider` | string | `"noop"` | s3, local, noop |
| `JANUSLY_EMBEDDING_MODEL` | Tenant | `memory.embeddingModel` | string | `""` | catalog validator |
| `OLLAMA_BASE_URL` | Tenant | `memory.embeddingBaseUrl` | string | `""` | catalog validator |
| `JANUSLY_RETENTION_RUN_EVENTS_DAYS` | Tenant | `retention.runEventsDays` | number | `90` | 7..365 |
| `JANUSLY_RETENTION_ARCHIVE_RUN_EVENTS` | Tenant | `retention.archiveRunEvents` | boolean | `false` | catalog validator |
| `JANUSLY_RETENTION_AUDIT_LOGS_DAYS` | Tenant | `retention.auditLogsDays` | number | `365` | 30..730 |
| `JANUSLY_RETENTION_USAGE_EVENTS_DAYS` | Tenant | `retention.usageEventsDays` | number | `90` | 30..365 |
| `JANUSLY_RETENTION_DEAD_LETTERS_DAYS` | Tenant | `retention.deadLettersDays` | number | `180` | 30..730 |
| `JANUSLY_RETENTION_RECOVERY_FEEDBACK_DAYS` | Tenant | `retention.recoveryFeedbackDays` | number | `180` | 30..365 |
| `JANUSLY_RETENTION_MEMORY_ENTRIES_DAYS` | Tenant | `retention.memoryEntriesDays` | number | `90` | 7..730 |
| `JANUSLY_RETENTION_DELETED_WORKFLOWS_DAYS` | Tenant | `retention.deletedWorkflowsDays` | number | `30` | 1..365 |

Important consumer distinctions:

- An explicit empty `mcp.clientCommandAllowlist` tenant value denies all stdio
  commands, even with a nonempty `JANUSLY_MCP_ALLOWED_COMMANDS`. Remove the tenant
  override to inherit the environment; an empty string is not inheritance.
- Empty `memory.embeddingModel` resolves to `bge-m3`; empty
  `memory.embeddingBaseUrl` resolves to `http://ollama:11434`. An explicit empty
  tenant string is valid and selects that built-in consumer default, rather than
  inheriting a nonempty environment value. Tenant URLs get outbound SSRF/DNS
  checks; operator infrastructure URLs are trusted separately. Embedding timeout
  is fixed at ten seconds, not configurable via `JANUSLY_OLLAMA_TIMEOUT_MS`.
- `mcp.stdioMaxVmKb` / `JANUSLY_MCP_STDIO_MAX_VM_KB` is reserved metadata, **not an
  enforced child memory limit**. Current controls are allowlisted command/env,
  lifetime, capped stderr and the container memory limit.
- `autoHealing.autoApply` is reserved and currently has no effect. Validated
  proposals still require explicit operator application. There is no active
  `JANUSLY_AUTO_HEALING_AUTO_APPLY` process gate.
- `subworkflow.maxDepth` has no catalog upper bound, but lineage walking has a
  separate 100-level safety bound. Raising the setting does not remove it.
- `objectstore.provider=local` requires a directory; S3 requires bucket and keys.
  Missing capabilities degrade to unavailable/noop, not successful durable storage.
- Email's resolved catalog default is `noop`, with sender `onboarding@resend.dev`.
  An explicit tool input sender takes precedence. Provider selection still checks
  its credential and simulator gates; setting a provider name does not enable it.
- `pdf.rateLimitPerMin` has a catalog default of 30, despite the tool's defensive
  fallback of 60. The catalog wins in production. DB's fallback is explicitly
  `JANUSLY_DB_TOOL_RATE_LIMIT_PER_MIN`, not a generated `JANUSLY_DB_RATE_LIMIT_PER_MIN`.
- Retention works per organization. Deleted workflow fallback helpers do not
  replace the bounded catalog resolution; open DLQ rows never expire merely by age.

## Dynamic names and non-configuration literals

| Name family | Category | Resolution and limits | Source / owner |
| --- | --- | --- | --- |
| `JANUSLY_LLM_PRICE_<NORMALIZED_MODEL>` | Process | Optional positive finite USD-per-million rates; known model accepts input,output or four rates; unknown model requires all four including cache-write/cache-read. Invalid override falls back to static price if known, otherwise paid calls fail before egress. Never an automatic budget authorization. | `internal/ai/pricing.go` |
| `JANUSLY_CRED_*` and operator-approved secret references | Secret | Dynamic credential names, not a finite list of product knobs. Reserved namespaces always win; allowlist supports exact names and PREFIX_* globs. MCP child receives only PATH plus explicitly resolved references. | `internal/secretstore/envpolicy.go`, `internal/mcpclient/mcpclient.go` |
| `JANUSLY_<FAMILY>_RATE_LIMIT_PER_MIN` | Process | Dynamic fallback after missing catalog key. Current extra families are SHEET (60) and PAGERDUTY (120), positive integers. Catalogued families use their explicit table entries, not guessed aliases. | `internal/engine/integrationdeps.go`, tool call sites |
| `HOME`, `NODE_ENV`, `DATABASE_URL`, `REDIS_URL`, `OPENAI_API_KEY` | Platform | Reserved credential-reference names, not supported Janusly database/provider aliases. Their presence in a blocklist is not evidence that the application reads them as configuration. | `internal/secretstore/envpolicy.go` |
| `PG*`, `POSTGRES_*`, `OTEL_*`, hosting-provider variables | Platform | PostgreSQL/collector/library/hosting configuration, not tenant settings. This does not promise all SDK variables are implemented by Janusly adapters. In particular the direct S3 signer uses the two listed AWS keys, not an implicit AWS credential chain. | PostgreSQL18, OTLP HTTP SDK, deployment tooling |

The literal drift test is deliberately only a coverage alarm. It scans production
Go literals and checks that names are classified here; it does not infer active
readers from comments, declarations, examples or counts. Dynamic readers above
were checked at their callers. Catalog table defaults/ranges are tested against
the existing catalog. This reference does not introduce a second runtime registry.

## Harness and deployment-only inputs

These names control scripts or builds, not the deployed Go configuration object.
Their source scripts are authoritative for validation, defaults and destructive
operation gates; follow [Development](development.md) and the linked runbooks.
Never pass a harness switch as evidence that production is qualified.

| Input family / entry points | Category | Owner and operational boundary |
| --- | --- | --- |
| `COMPOSE_PROJECT_NAME`, `JANUSLY_POSTGRES_HOST_PORT`, `JANUSLY_HOST_PORT`, `PORT`, `IMAGE` | Harness | `Makefile`, `docker-compose.yml`, `scripts/dev.sh`; container/host wiring. Go still reads JANUSLY_PORT, not PORT. DB reset retains CONFIRM=reset and configured-project scope. |
| `JANUSLY_VERIFY_*`, `JANUSLY_SOURCE_ROOT` | Harness | `scripts/verify-isolated.sh`, `scripts/assert-clean-source.sh`; fresh owned DB, clean source, isolated ports/tool overrides. |
| `JANUSLY_E2E_*`, `E2E_*`, `PLAYWRIGHT_*`, `JANUSLY_SMOKE`, `JANUSLY_TEXT_SEARCH_E2E` | Harness | `scripts/test-e2e.sh`, `web/playwright.config.ts`, `web/e2e/`; owned stack, provider-free seed, browser/runtime targets. |
| `JANUSLY_QUALIFICATION_*`, `JANUSLY_EVIDENCE_DIR`, `JANUSLY_SUPABASE_HOME` | Harness | `scripts/qualification-local.sh`; explicit profiles/evidence paths, not product behavior flags. |
| `JANUSLY_LOAD_*` | Harness | `scripts/load-soak-local.sh`; warmup/measure/settle and target identity. Smoke durations do not establish full load qualification. |
| `JANUSLY_RECOVERY_*` | Harness | `scripts/postgres-local-recovery.sh`; backup/restore source/database selection and explicit reset gates. |
| `JANUSLY_OCI_*`, `JANUSLY_PRIVATE_METRICS_*` | Harness | `scripts/oci-railway-local.sh`, `scripts/private-metrics-local.sh`; local executable/container and privileged listener qualification only. |
| `JANUSLY_REAL_PROVIDER_*`, `PAGERDUTY_*` qualification inputs | Harness | `scripts/real-provider-local.sh`, `scripts/qualification-local.sh pagerduty`; explicit provider consent/call/cost limits and evidence. Setting a limit is not permission to spend or mutate a real provider. |
| `JANUSLY_BUILDKIT_SBOM_GENERATOR`, `JANUSLY_SYFT_IMAGE`, `JANUSLY_SUPPLY_CHAIN_SELFTEST`, `SUPPLY_CHAIN_DIR`, `ARTIFACT_DIR` | Build | `scripts/supply-chain-local.sh`, artifact/build targets; provenance and SBOM tooling, not tenant/runtime controls. |
| `PNPM`, `GOTOOLCHAIN`, `GOCACHE`, `CI`, `GITHUB_*`, `TZ` | Platform | Toolchain, CI and test process inputs. Test fixtures use synthetic values; they are not application settings. |
| `ALERTMANAGER_CONFIG`, collector `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Platform | `deploy/observability/`, OTLP HTTP SDK; operator-managed external configuration. Endpoints/configuration may contain sensitive material. |

The website is a standalone npm/Astro deployment. Its analytics/build inputs and
Cloudflare deploy credentials belong to that workflow, never the product pnpm
build or `make verify`. A public analytics token is not an API credential.
