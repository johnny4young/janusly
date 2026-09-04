# Configuration

Janusly reads process configuration from environment variables. The application
validates core values before opening listeners. Tenant-adjustable behavior lives
in `org_configs`; secrets never do.

## Core runtime

| Variable | Default | Meaning |
| --- | --- | --- |
| `JANUSLY_DATABASE_URL` | local `janusly` PostgreSQL URL on `127.0.0.1:15473` | PostgreSQL 18 connection string. Containers use the private `postgres:5432` endpoint. |
| `JANUSLY_ENV` | development | Set to `production` to enable the production security and readiness posture. |
| `JANUSLY_PORT` | `3001` | Public API and React listener. |
| `JANUSLY_INTERNAL_HOST` | `127.0.0.1` | Internal metrics listener; only loopback (`127.0.0.1`, `::1`) or wildcard (`0.0.0.0`, `::`) is accepted. |
| `JANUSLY_INTERNAL_PORT` | `9464` | Internal metrics and diagnostics port. |
| `JANUSLY_START_RATE_LIMIT_PER_MIN` | `30000` | Per-organization cap on `POST /v1/start` per minute; a runaway-client guard, not a quota. |
| `JANUSLY_TRUSTED_PROXY` | `false` | When `true`, per-IP rate limits key on the first `X-Forwarded-For` hop instead of the socket peer. Set it only behind a proxy that overwrites that header; otherwise a client can pick its own bucket. |
| `JANUSLY_BROWSER_CONNECT_ORIGINS` | empty | Comma-separated explicit loopback HTTP origins added to browser CSP for local identity labs; non-loopback and non-HTTP values are ignored. |
| `JANUSLY_WORKER_CONCURRENCY` | `8` | Concurrent workflow task limit, range 1–64. |
| `JANUSLY_API_POOL_SIZE` | `10` | Public-request PostgreSQL pool size. |
| `JANUSLY_WORKER_POOL_SIZE` | derived | Execution PostgreSQL pool size; `0` derives concurrency plus two. |
| `JANUSLY_POLL_MS` | `250` | Durable-queue fallback poll interval, range 50–5000 ms. |
| `JANUSLY_HTTP_TIMEOUT_MS` | `30000` | Default outbound HTTP timeout; integer range 1..600000 ms. |
| `JANUSLY_FEEDBACK_MEMORY_WORKERS` | `4` | Fixed workers for optional feedback-derived memory commits, range 1–32. |
| `JANUSLY_FEEDBACK_MEMORY_QUEUE_CAPACITY` | `256` | Waiting-task bound for optional feedback-derived memory, range 1–4096; saturation never rejects durable feedback. |
| `JANUSLY_FEEDBACK_MEMORY_TIMEOUT_MS` | `15000` | Per-task deadline for feedback-derived memory, range 1000–300000 ms. |

`JANUSLY_PORT` and `JANUSLY_INTERNAL_PORT` must differ. There are no alternate
names for these settings.

## Production requirements

When `JANUSLY_ENV=production`:

- the binary must contain valid commit and tree provenance;
- `JANUSLY_RESUME_TOKEN_SECRET` must be set;
- development SSO bypass is refused;
- local-stack and integration-simulator gates are refused;
- development auth headers require explicit `ALLOW_DEV_AUTH_HEADERS=true` when
  no identity provider is configured, and are refused outright when Supabase
  is configured;
- fail-level workflow readiness issues reject a run before it is created.

Use `JANUSLY_CREDENTIAL_MASTER_KEY` or
`JANUSLY_CREDENTIAL_MASTER_KEY_FILE` to enable encrypted tenant credentials.
The key must decode to exactly 32 bytes and must be backed up separately from
the database.

## Authentication and identity

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL` | External Supabase project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side Supabase verification key. |
| `VITE_SUPABASE_URL` | Frontend build-time Supabase project URL. |
| `VITE_SUPABASE_ANON_KEY` | Frontend build-time public Supabase key. |
| `WORKOS_CLIENT_ID` | WorkOS project client identifier. |
| `WORKOS_API_KEY` | WorkOS server API key. |
| `WORKOS_WEBHOOK_SECRET` | WorkOS webhook verification secret. |
| `JANUSLY_SSO_CALLBACK_URL` | Registered WorkOS callback URL. |
| `JANUSLY_WEB_BASE_URL` | Public web origin used for SSO redirects and browser-session cookies. |
| `JANUSLY_SESSION_COOKIE_SECURE` | Force secure browser-session cookies. |
| `JANUSLY_API_SERVICE_TOKEN` | Service-to-service API token. |
| `JANUSLY_ADMIN_TOKEN` | Administrative command token. |

The frontend has no API URL variable. It calls the page origin in production.
`VITE_DOCS_URL` may provide an optional documentation link.

## AI and memory

| Variable | Purpose |
| --- | --- |
| `ANTHROPIC_API_KEY` | Anthropic completion credential. |
| `ANTHROPIC_MODEL` | Completion model identifier. |
| `JANUSLY_LLM_TIMEOUT_MS` | Timeout for one completion request. |
| `JANUSLY_LLM_MAX_RETRIES` | SDK retry count for ordinary completion requests. Evaluation runs force zero. |
| `JANUSLY_LLM_MAX_OUTPUT_UNITS` | Default output limit. |
| `JANUSLY_LLM_PRICE_<MODEL>` | Temporary positive finite USD-per-1M-token rates. A catalogued model accepts `input,output` and retains its known cache multipliers. A model absent from the catalog requires `input,output,cache_write_5m,cache_read`; incomplete pricing fails closed. The model token is uppercase with punctuation replaced by `_`. |
| `JANUSLY_AI_GENERATION_CANDIDATES` | Bounded candidate count for generation. |
| `JANUSLY_AGENT_WRITES_ENABLED` | Process kill switch for write-capable tools selected by `agent` or `multi_agent`. A write also requires tenant `ai.agentWriteConsent=true`, node `allowWriteTools=true`, and human approval on every incoming path. |
| `JANUSLY_LLM_SIMULATED_PROVIDERS` | Comma-separated completion providers routed to a simulator only after both local simulator gates are enabled. Currently the only recognized value is `anthropic`. |
| `JANUSLY_LLM_SIMULATOR_BASE_URL` | Explicit HTTP(S) endpoint for the Anthropic-compatible local simulator. A fully requested but invalid endpoint fails to the provider-free path; the simulator receives a fixed non-secret credential. |
| `JANUSLY_MEMORY_ENABLED` | Process-level memory gate. |
| `JANUSLY_FEEDBACK_MEMORY_WORKERS` | Bounded optional-memory worker count. |
| `JANUSLY_FEEDBACK_MEMORY_QUEUE_CAPACITY` | Bounded optional-memory waiting queue. |
| `JANUSLY_FEEDBACK_MEMORY_TIMEOUT_MS` | Deadline for one optional feedback-memory task. |
| `JANUSLY_EMBEDDING_MODEL` | Ollama embedding model; local default is `bge-m3`. |
| `OLLAMA_BASE_URL` | Ollama endpoint. |

AI paths must degrade to deterministic fallback results when the provider is
missing or unavailable. Tenant model, budget, and behavior settings belong in
the closed `org_configs` catalog. The root Compose service explicitly forwards
the process memory gate, bounded feedback-memory controls, and Ollama
model/endpoint variables; setting them in `.env` therefore changes the
application container rather than only the sibling Ollama service.
Real-provider calls fail closed before egress when the selected model has no
finite price in the static catalog or a server-only price override. This keeps
budget aggregation complete instead of treating unknown paid usage as zero;
measured cost includes uncached input, five-minute cache creation, cache reads,
and output tokens at their distinct rates.

`ai.budgetMonthlyUsd` is a pre-call guard over recorded completed usage, not an
atomic prepaid reservation. With policy `block`, Janusly stops admitting new
calls after recorded spend reaches the threshold; concurrent or already
in-flight calls may still settle above it. Use the separately bounded
qualification harness for an exact call/cost breaker during provider tests.

The catalog applies the same normalization to API writes and stored rows.
Operator guidance is capped at 8 KiB and rejects secret-like content;
`memory.allowedKinds`, `memory.retentionDaysByKind`, and
`recovery.slaPolicies` use closed identifiers and bounded numeric values.
Invalid legacy/direct-SQL rows fall through to the next safe configuration
layer instead of becoming effective. See [memory policy](memory-policy.md) for
the per-kind retention table.

## Integrations

Outbound safety and integration settings include:

- `JANUSLY_LOCAL_STACK=true` together with
  `JANUSLY_LOCAL_INTEGRATION_SIMULATOR=true` enables local provider simulators;
  either flag alone is inert, and both are refused in production
- `JANUSLY_LOCAL_INTEGRATION_SIMULATOR_URL`, the base URL used only after that
  double local gate
- `JANUSLY_LLM_SIMULATED_PROVIDERS=anthropic` plus
  `JANUSLY_LLM_SIMULATOR_BASE_URL`, the additional AI-specific binding. If
  Anthropic is not explicitly listed, the AI simulator configuration is inert;
  when it is listed, a missing/invalid URL fails closed without sending the
  real `ANTHROPIC_API_KEY`
- `ALLOW_PRIVATE_HTTP_TARGETS`
- `JANUSLY_HTTP_MAX_RESPONSE_BYTES`
- `JANUSLY_HTTP_MAX_REDIRECTS`
- `JANUSLY_HTTP_STREAM_PREVIEW_BYTES`

Outbound HTTP settings remain bounded even when configured per tenant or per
workflow node: response bodies are capped at 67,108,864 bytes (64 MiB), redirect
chains at 20 hops, and timeouts at 600,000 ms. Values outside those ranges fall
back when read from legacy/environment configuration and are rejected on new
tenant or workflow writes.
- `JANUSLY_MCP_WRITES_ENABLED` (server-side write tools) and
  `JANUSLY_MCP_CLIENT_WRITES_ENABLED` (`mcp_tool` steps against external
  servers)
- `JANUSLY_MCP_PERMISSIONS`, a comma/space-separated explicit permission
  ceiling for `cmd/mcp`; omission is read-only and write consent never expands
  this set
- `JANUSLY_PUBLIC_APP_URL` for shareable report links
- `JANUSLY_RETENTION_DEAD_LETTERS_DAYS` (org key `retention.deadLettersDays`,
  default 180, range 30..730) ages out settled dead letters (`replayed`,
  `resolved`) in the daily retention sweep; open dead letters never expire by
  age.
- `JANUSLY_RETENTION_ARCHIVE_RUN_EVENTS` exports expiring run events as
  JSONL to the object store before the retention sweep deletes them; rows
  are only deleted once their export is stored, so an unavailable store
  halts the drain instead of losing history
- `JANUSLY_MAILER_PROVIDER` and `JANUSLY_MAILER_FROM`
- `RESEND_API_KEY` or `SENDGRID_API_KEY`
- `JANUSLY_OBJECT_STORE_PROVIDER`
- `JANUSLY_OBJECT_STORE_BUCKET`, region, endpoint, and public base URL
- standard AWS credential variables for S3-compatible storage

Tenant credentials are created through the credential API. Environment-backed
credential references are restricted by the reserved namespace and optional
`JANUSLY_CREDENTIAL_ENV_ALLOWLIST`.

## Observability

| Variable | Meaning |
| --- | --- |
| `OTEL_EXPORTER` | `console`, `otlp`, or `none`. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | OTLP/HTTP trace destination. |
| `OTEL_SERVICE_INSTANCE_ID` | Stable process instance label. |
| `ALERTMANAGER_CONFIG` | Optional path mounted by the local observability Compose stack instead of its non-secret webhook receiver. Use an absolute path for a configuration kept outside the repository. |

Prometheus metrics are served on the internal listener. Keep it on loopback
unless a collector runs on a private service network. In that case a wildcard
bind is allowed only when port `9464` has no public route or host mapping; the
same listener includes build identity and pprof diagnostics.

See `.env.example` for a minimal copyable template and
[observability](observability.md) for collector configuration.
