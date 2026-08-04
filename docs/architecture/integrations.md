# Integrations

Integration tools are registered in `internal/tools` with input/output schemas,
static write capability, and bounded execution. Workflow dispatch goes through
`internal/executors`.

Credentials are organization-scoped. Managed values are envelope-encrypted in
PostgreSQL with an external root key. Environment-backed references are limited
by reserved namespaces and an operator allowlist. API payloads never return
credential values or reference names.

All outbound HTTP uses the shared policy: scheme and target validation, DNS
pinning, redirect revalidation, timeout, and response byte limits. Streamed
responses must be consumed inside the same executor invocation.

Mail, object storage, Slack, GitHub, PagerDuty, webhooks, and external runtime
projections preserve idempotency and audit boundaries. Validation replay skips
write effects.
