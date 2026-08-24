# API contract

`internal/contract` defines the stable route metadata and schemas used by the
Go HTTP server. `cmd/contract` generates `contract/openapi.json`.

Contracted `/v1` routes return a stable envelope with `apiVersion`,
`requestId`, and either `data` or `error`. Request and response payloads are
validated at runtime. `X-Request-Id` is always safe to expose.

Route implementations live in `internal/httpapi`. The public React client may
continue using established unversioned routes where they are part of its
current contract; new public reads should prefer explicit `/v1` metadata.

Run `make generate` after contract changes and require a clean diff on a second
run.

Public workflow status pages use a 256-bit bearer token at
`/public/status/{token}`. The token is revealed only by the enable/rotate
response; PostgreSQL stores its SHA-256 digest, so a later admin read can report
and revoke enablement but cannot reconstruct the public URL. Public payloads are
aggregate-only and intentionally omit tenant ids, run ids, and error bodies.
