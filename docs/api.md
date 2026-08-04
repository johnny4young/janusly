# HTTP API

The canonical machine-readable contract is `contract/openapi.json`. Regenerate
it with:

```bash
go run ./cmd/contract
git diff -- contract/openapi.json
```

## Transport

The public server defaults to `http://127.0.0.1:3001`. Production React calls
are same-origin. JSON responses on contracted `/v1` routes use:

```json
{
  "apiVersion": "v1",
  "requestId": "request-id",
  "data": {}
}
```

Errors use the same envelope with `error.code` and `error.message`.
`X-Request-Id` is returned for correlation. Request and response bodies are
validated by the Go contract registry.

## Authentication

Development without an external identity provider may use:

```http
x-org-id: default
x-user-id: dev-user
```

Production resolves an authenticated principal through Supabase, a WorkOS
browser session, or a service token. The organization hint selects scope but
does not grant membership. Route authorization combines minimum role and
closed-catalog permissions.

## Main surfaces

| Area | Representative routes |
| --- | --- |
| Health | `GET /healthz`, `GET /health` |
| Identity | `/auth/session`, `/identity`, `/members`, `/roles` |
| Workflows | `/v1/workflows`, `/workflows/save`, `/workflows/readiness` |
| Runs | `/v1/start`, `/v1/run`, `/runs/:id/stream`, `/cancel`, `/resume` |
| Recovery | `/v1/dlq`, `/recovery/*`, `/ai/patch-workflow` |
| AI Studio | `/ai/generate-workflow`, `/ai/explain-workflow`, `/ai/explain-run` |
| Integrations | `/credentials`, `/mcp/*`, `/webhooks/*`, `/upstream/*` |
| Operations | `/audit`, `/reports/*`, `/system/*`, `/billing/*` |

Use the OpenAPI document for exact schemas and status codes.

## Streaming

Run events use server-sent events over authenticated `fetch` plus
`ReadableStream`. Clients reconnect using the run cursor and must treat event
payloads as operational summaries, not hidden model reasoning.

## CORS and limits

`API_ALLOWED_ORIGINS` controls development cross-origin access. Production does
not require cross-origin access for the bundled frontend. The server enforces
bounded JSON bodies, request timeouts, per-organization rate limits, and route
permissions.

## Contract changes

- Add or modify route metadata in `internal/contract` and `internal/httpapi`.
- Preserve tenant scoping and stable error codes.
- Run `make generate` and commit the OpenAPI result.
- Add unit and PostgreSQL 18 integration coverage.
- Update the React client and this documentation when operator behavior changes.
