# Configuration

Janusly reads process configuration from environment variables. The application
validates core values before opening listeners. Tenant-adjustable behavior lives
in `org_configs`; secrets never do.

## Core runtime

| Variable | Default | Meaning |
| --- | --- | --- |
| `JANUSLY_DATABASE_URL` | local `janusly` PostgreSQL URL | PostgreSQL 18 connection string. |
| `JANUSLY_ENV` | development | Set to `production` to enable the production security and readiness posture. |
| `JANUSLY_PORT` | `3001` | Public API and React listener. |
| `JANUSLY_INTERNAL_HOST` | `127.0.0.1` | Internal metrics listener; only loopback (`127.0.0.1`, `::1`) or wildcard (`0.0.0.0`, `::`) is accepted. |
| `JANUSLY_INTERNAL_PORT` | `9464` | Internal metrics and diagnostics port. |
| `JANUSLY_BROWSER_CONNECT_ORIGINS` | empty | Comma-separated explicit loopback HTTP origins added to browser CSP for local identity labs; non-loopback and non-HTTP values are ignored. |
| `JANUSLY_WORKER_CONCURRENCY` | `8` | Concurrent workflow task limit, range 1–64. |
| `JANUSLY_API_POOL_SIZE` | `10` | Public-request PostgreSQL pool size. |
| `JANUSLY_WORKER_POOL_SIZE` | derived | Execution PostgreSQL pool size; `0` derives concurrency plus two. |
| `JANUSLY_POLL_MS` | `250` | Durable-queue fallback poll interval, range 50–5000 ms. |
| `JANUSLY_HTTP_TIMEOUT_MS` | `30000` | Default outbound HTTP timeout. |

`JANUSLY_PORT` and `JANUSLY_INTERNAL_PORT` must differ. There are no alternate
names for these settings.

## Production requirements

When `JANUSLY_ENV=production`:

- the binary must contain valid commit and tree provenance;
- `JANUSLY_RESUME_TOKEN_SECRET` must be set;
- development SSO bypass is refused;
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
| `JANUSLY_LLM_PROVIDER` | Completion provider; the supported default is `anthropic`. |
| `ANTHROPIC_API_KEY` | Anthropic completion credential. |
| `ANTHROPIC_MODEL` | Completion model identifier. |
| `JANUSLY_LLM_MAX_OUTPUT_UNITS` | Default output limit. |
| `JANUSLY_AI_GENERATION_MODE` | Workflow generation mode; default `free_json`. |
| `JANUSLY_AI_GENERATION_CANDIDATES` | Bounded candidate count for generation. |
| `JANUSLY_MEMORY_ENABLED` | Process-level memory gate. |
| `JANUSLY_EMBEDDING_PROVIDER` | Embedding provider; local default is Ollama. |
| `JANUSLY_EMBEDDING_MODEL` | Embedding model; local default is `bge-m3`. |
| `OLLAMA_BASE_URL` | Ollama endpoint. |

AI paths must degrade to deterministic fallback results when the provider is
missing or unavailable. Tenant model, budget, and behavior settings belong in
the closed `org_configs` catalog. The root Compose service explicitly forwards
the process memory gate and embedding provider/model variables; setting them in
`.env` therefore changes the application container rather than only the sibling
Ollama service.

## Integrations

Outbound safety and integration settings include:

- `ALLOW_PRIVATE_HTTP_TARGETS`
- `JANUSLY_HTTP_MAX_RESPONSE_BYTES`
- `JANUSLY_HTTP_MAX_REDIRECTS`
- `JANUSLY_HTTP_STREAM_PREVIEW_BYTES`
- `JANUSLY_MCP_WRITES_ENABLED` (server-side write tools) and
  `JANUSLY_MCP_CLIENT_WRITES_ENABLED` (`mcp_tool` steps against external
  servers)
- `JANUSLY_MCP_PERMISSIONS`, a comma/space-separated explicit permission
  ceiling for `cmd/mcp`; omission is read-only and write consent never expands
  this set
- `JANUSLY_PUBLIC_APP_URL` for shareable report links
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
