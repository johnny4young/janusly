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

## Text-search query boundary

The `q` workflow filter and `search` recovery-queue filter share one boundary.
Empty input means no filter. After boundary whitespace is trimmed, a non-empty
value must be valid UTF-8, contain no control characters, contain at most 100
Unicode code points, and include a contiguous run of at least three Unicode
letters or numbers. Invalid values
return `400` with `search_query_too_short`, `search_query_too_long`,
`search_query_invalid_characters`, or `search_query_invalid_utf8`; they are
never silently turned into an unfiltered scan.

LIKE metacharacters `%`, `_`, and `\` remain literal after escaping. They may
appear in a query that also has an indexable letter/number run, but a
punctuation-only term is rejected because PostgreSQL cannot extract a selective
trigram from it.

Structured request bodies are strict: `decodeBody` refuses unknown fields.
This prevents a client rename from silently decoding to a zero value and then
persisting an unintended empty update. Routes that must distinguish an absent
field from an explicit empty value use a pointer in their request contract.

Public workflow status pages use a 256-bit bearer token at
`/public/status/{token}`. The token is revealed only by the enable/rotate
response; PostgreSQL stores its SHA-256 digest, so a later admin read can report
and revoke enablement but cannot reconstruct the public URL. Public payloads are
aggregate-only and intentionally omit tenant ids, run ids, and error bodies.
