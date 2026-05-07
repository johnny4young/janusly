# Configuration

Janusly reads environment variables from the repo root. `packages/db/src/env.ts`
loads `.env.example` first as safe defaults and then `.env` as developer or
deployment overrides. Do not put real secrets in `.env.example`.

Safe runtime choices can also be overridden per tenant in the `org_configs`
table. Environment variables remain the process-level defaults; tenant rows
win only for the cataloged keys listed below. Infrastructure settings and
secret values stay env-only.

## Core Services

| Variable | Default | Used by | Purpose |
| --- | --- | --- | --- |
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/workflow` | `packages/db` | Postgres connection string for Drizzle, API, worker, and migrations. |
| `REDIS_URL` | `redis://localhost:6379` | API rate limiter, engine queue | Redis connection for shared rate-limit state and BullMQ. |
| `PORT` | `3001` | `apps/api` | API HTTP port. |
| `API_ALLOWED_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174` | `apps/api/src/http.ts` | Comma-separated CORS allowlist. Includes `5174` so dev still works when Vite falls back from `5173` due to a port collision. |
| `API_MAX_JSON_BODY_BYTES` | `1048576` | `apps/api` | Maximum request JSON body size. |
| `API_SERVICE_TOKEN` | unset | `apps/api/src/auth.ts` | Optional Bearer token for service clients, including production MCP mode. |
| `JANUSLY_REQUIRE_SAVED_WORKFLOW` | `false` | `apps/api` | When `true`, rejects ad-hoc `POST /start` workflow payloads. |
| `JANUSLY_PRODUCTION_MODE` | `false` | `apps/api`, `packages/engine/src/workflow-readiness.ts` | When `true`, `POST /start` runs the deterministic readiness gate (`checkWorkflowReadiness` + DB-aware `checkRollbackAvailability`) and rejects fail-level workflows with HTTP 422. Dev mode (unset) preserves the old "anything structurally valid runs" behaviour. |
| `JANUSLY_REQUIRE_EVAL_COVERAGE` | `false` | `packages/engine/src/workflow-readiness.ts` | Opt-in addition to the readiness gate that warns when a workflow has no associated eval. Off by default so clean MVP workflows can reach `status: "pass"` without eval tracking. |
| `WORKER_CONCURRENCY` | `10` | `packages/engine/src/worker.ts` | BullMQ worker concurrency. |
| `JANUSLY_MAX_SUBWORKFLOW_DEPTH` | `5` | `packages/engine/src/subworkflow.ts` | Maximum nested subworkflow depth. |
| `JANUSLY_PERSIST_MAX_BYTES` | `262144` (256 KiB) | `packages/engine/src/safe-persist.ts` | Default size cap for jsonb writes through the safe-persist chokepoint. Over-cap payloads are replaced with a `{ __truncated: true, ... }` sentinel. |

`docker-compose.yml` also sets Postgres container-internal values
(`POSTGRES_USER=postgres`, `POSTGRES_PASSWORD=postgres`,
`POSTGRES_DB=workflow`). Those are not read from `.env`; they just need to
match the local `DATABASE_URL` default.

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

> **MVP operating posture:** AGENTS.md locks runtime AI to **Anthropic only** (`claude-haiku-4-5-20251001`). The `openai` provider stays in the registry for future expansion but is unverified in production — do not switch a tenant's `ai.provider` away from `anthropic` unless a verification plan exists. Set `JANUSLY_LLM_PROVIDER=anthropic` in `.env`. Ignore the historical `openai` defaults below for any new deployment.

| Config key | Env fallback | Default | Used by | Purpose |
| --- | --- | --- | --- | --- |
| `ai.provider` | `JANUSLY_LLM_PROVIDER` | `openai` (registry default; **set to `anthropic`** for MVP) | API AI endpoints, engine AI/agent nodes | Default provider for tenant-level LLM calls. API keys still come from env or secret management. |
| `ai.openai.model` | `OPENAI_MODEL` | `gpt-4o-mini` | API AI endpoints, engine AI/agent nodes | Default OpenAI model for this tenant. Not a supported runtime target right now; tracked for future expansion. |
| `ai.anthropic.model` | `ANTHROPIC_MODEL` | `claude-haiku-4-5-20251001` | API AI endpoints, engine AI/agent nodes | Default Anthropic model for this tenant — the supported MVP target. |
| `ai.timeoutMs` | `OPENAI_TIMEOUT_MS` | `30000` | API AI endpoints, engine AI/agent nodes | LLM request timeout in milliseconds (env name is historical; applies to every registered provider). |
| `ai.maxRetries` | `OPENAI_MAX_RETRIES` | `2` | API AI endpoints, engine AI/agent nodes | AI SDK retry count for LLM calls (env name is historical; applies to every registered provider). |
| `ai.promptMaxChars` | `AI_PROMPT_MAX_CHARS` | `4000` | API AI endpoints | Prompt/question length cap. |
| `ai.rateLimitPerMin` | `AI_RATE_LIMIT_PER_MIN` | `30` | API AI endpoints | Per-org AI request limit per minute. |
| `http.timeoutMs` | `JANUSLY_HTTP_TIMEOUT_MS` | `30000` | Engine `http` nodes and `http.request` tool | Default outbound HTTP timeout budget in milliseconds. |
| `http.maxResponseBytes` | `JANUSLY_HTTP_MAX_RESPONSE_BYTES` | `1000000` | Engine `http` nodes and `http.request` tool | Default maximum decoded body size. |
| `http.maxRedirects` | `JANUSLY_HTTP_MAX_REDIRECTS` | `5` | Engine `http` nodes and `http.request` tool | Default maximum redirect hops. |
| `runs.requireSavedWorkflow` | `JANUSLY_REQUIRE_SAVED_WORKFLOW` | `false` | `POST /start` | Require runs to start from saved workflows instead of ad-hoc payloads. |
| `subworkflow.maxDepth` | `JANUSLY_MAX_SUBWORKFLOW_DEPTH` | `5` | Engine `subworkflow` nodes | Maximum nested subworkflow depth. |

The config table deliberately does not store `OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, database URLs, Redis URLs, Supabase keys, service tokens,
or workflow secrets. Store those in `.env` or a vault, then use tenant config
only to select the safe provider/model/limit behavior.

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

## Outbound HTTP Safety

| Variable | Default | Used by | Purpose |
| --- | --- | --- | --- |
| `ALLOW_PRIVATE_HTTP_TARGETS` | `false` | `packages/engine/src/http-policy.ts` | Allows localhost/private/link-local HTTP targets only when explicitly set to `true`. |
| `JANUSLY_HTTP_TIMEOUT_MS` | `30000` | `packages/engine/src/http-policy.ts` | Total timeout budget for outbound HTTP across redirects. |
| `JANUSLY_HTTP_MAX_RESPONSE_BYTES` | `1000000` | `packages/engine/src/http-policy.ts` | Maximum decoded response body size for `http` nodes and `http.request`. |
| `JANUSLY_HTTP_MAX_REDIRECTS` | `5` | `packages/engine/src/http-policy.ts` | Maximum redirect hops; each hop is revalidated through the SSRF policy. |

## AI Providers

| Variable | Default | Used by | Purpose |
| --- | --- | --- | --- |
| `OPENAI_API_KEY` | unset | `packages/ai` | Enables the registered OpenAI provider for future verification work. Not a supported MVP runtime target; without the selected provider key, callers stay in fallback mode. |
| `OPENAI_MODEL` | `gpt-4o-mini` | `packages/ai`, `apps/api` | Default OpenAI model for the compatibility registry. Not a supported MVP runtime target. |
| `OPENAI_TIMEOUT_MS` | `30000` | `packages/ai`, `apps/api` | LLM request timeout. Shared by registered providers for now. |
| `OPENAI_MAX_RETRIES` | `2` | `packages/ai`, `apps/api` | AI SDK retry count for LLM calls. |
| `AI_PROMPT_MAX_CHARS` | `4000` | `apps/api` | Prompt length cap for AI endpoints. |
| `AI_RATE_LIMIT_PER_MIN` | `30` | `apps/api` | Per-org AI rate limit window capacity. |
| `JANUSLY_LLM_PROVIDER` | `openai` (registry default; **set to `anthropic`** for MVP deployments) | `packages/ai`, `apps/api` | Default provider registry key. Registered values: `openai`, `anthropic`. The supported runtime target is `anthropic` — see AGENTS.md "AI integration" for the operating posture. |
| `ANTHROPIC_API_KEY` | unset | `packages/ai` | Enables Anthropic-backed AI calls and explicit `anthropic/model` overrides. |
| `ANTHROPIC_MODEL` | `claude-haiku-4-5-20251001` | `packages/ai`, `apps/api` | Default Anthropic model. |
| `JANUSLY_LLM_PRICE_<MODEL>` | built-in pricing table | `packages/ai/src/pricing.ts` | Optional cost override as `<inputUsdPer1M>,<outputUsdPer1M>`, for example `JANUSLY_LLM_PRICE_GPT_4O_MINI=0.15,0.60`. |

## MCP Server

| Variable | Default | Used by | Purpose |
| --- | --- | --- | --- |
| `JANUSLY_API_URL` | `http://127.0.0.1:3001` | `packages/mcp-server` | API base URL the MCP server proxies to. |
| `JANUSLY_API_ORG_ID` | `default` | `packages/mcp-server` | Org id sent as `x-org-id`. |
| `JANUSLY_API_USER_ID` | `mcp-user` | `packages/mcp-server` | User id sent as `x-user-id` and used in audit attribution. |
| `JANUSLY_API_SERVICE_TOKEN` | unset | `packages/mcp-server` | Optional Bearer token sent to the API; should match `API_SERVICE_TOKEN` server-side. |

## Observability

| Variable | Default | Used by | Purpose |
| --- | --- | --- | --- |
| `OTEL_METRICS_PORT` | `9464` | `packages/engine/src/observability/prometheus.ts` | Prometheus exporter port. |
| `OTEL_SERVICE_INSTANCE_ID` | `HOSTNAME`, then `os.hostname()` | `packages/engine/src/observability/resource.ts` | Stable OpenTelemetry `service.instance.id`. |
| `HOSTNAME` | system-provided | `packages/engine/src/observability/resource.ts` | Fallback instance id in containerized environments. |
| `OTEL_EXPORTER` | unset | `packages/engine/src/observability/otel.ts` | Set to `jaeger` to enable the Jaeger trace exporter. |
| `OTEL_EXPORTER_JAEGER_ENDPOINT` | `http://localhost:14268/api/traces` | `packages/engine/src/observability/otel.ts` | Jaeger collector endpoint. |

## Local Test And Eval Helpers

| Variable | Default | Used by | Purpose |
| --- | --- | --- | --- |
| `JANUSLY_EVALS_API_URL` | `http://127.0.0.1:3001` | `scripts/run-evals.mjs` | API target for `pnpm evals`. |
| `PLAYWRIGHT_BASE_URL` | `http://127.0.0.1:5173` | `apps/web/playwright.config.ts` | Browser e2e base URL. |
| `PLAYWRIGHT_SKIP_WEB_SERVER` | unset | `apps/web/playwright.config.ts` | Set to `1` when an external web server is already running. |
| `CI` | unset | Playwright, scripts | CI mode switch for reporters and server reuse. |

## Dynamic Workflow Variables

Workflow authors can reference arbitrary environment variables at runtime:

| Pattern | Used by | Purpose |
| --- | --- | --- |
| `{{secret.NAME}}` | `packages/engine/src/secrets.ts` | Resolves `process.env.NAME`; missing values throw. Use for secrets registered by name in the UI. |
| `{{env.NAME}}` | `packages/engine/src/template.ts` | Resolves `process.env.NAME`; resolved values are added to the redaction list when long enough to redact safely. |

These names are intentionally open-ended, so they are not enumerated in
`.env.example`. Add deployment-specific entries to `.env` or your secret
manager.
