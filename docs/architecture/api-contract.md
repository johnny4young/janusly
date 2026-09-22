# API contract

`internal/contract` defines the stable route metadata and schemas used by the
Go HTTP server. `cmd/contract` generates `contract/openapi.json`.

Contracted `/v1` routes return a stable envelope with `apiVersion`,
`requestId`, and either `data` or `error`. Handlers validate their requests and
serialize response envelopes; the manifest is a schema description, not a
universal production response validator. Conformance tests compare supported
wire responses to those schemas, and high-risk browser boundaries validate the
received projection before applying it. `X-Request-Id` is always safe to expose.

Generic server failures are deliberately opaque at the public boundary. Every
`internal_error` response uses the stable `Internal error` message, omits
params and unversioned extras, and relies on `requestId` plus internal audit
and telemetry for correlation. Database, provider, credential, evidence, and
wrapped error details must never be reflected to a client. Both response
encoders enforce this invariant, and a package-wide source ratchet prevents a
handler from composing a more detailed generic error accidentally.

Route implementations live in `internal/httpapi`. The public React client may
continue using established unversioned routes where they are part of its
current contract; new public reads should prefer explicit `/v1` metadata.

Contract-first authoring mutations use the same dual lane as other stable
mutations: OpenAPI declares `POST /v1/ai/workflow-briefs/compile` and
`POST /v1/ai/workflow-proposals`, while the established unversioned
`/ai/...` aliases remain mounted for compatibility and return the legacy flat
payload. Both aliases execute the same core operation and the same `ai.write`
authorization gate. React uses generated `contractApi` operation keys, so the
static parity gate crosses the browser call, real Go route, central
authorization registry, OpenAPI, and generated request, response, and status
maps.

The manifest describes response envelopes exactly as the handlers serve them:
`GET /v1/dlq/clusters` is an object with `clusters`, `totalSamples`, and
`windowDays`, and `GET /v1/recovery/metrics` lists every metric key the
handler emits. Both are checked against live responses by an integration
test, so the generated TypeScript types stay trustworthy. On the browser side
`scripts/check-raw-v1-reads.mjs` (part of `pnpm lint`) rejects a raw `api()`
call on any `V1_READ_PATHS` entry outside the transport and `lib/` layers;
typed reads go through `contractApi`, and a component that needs a narrower
runtime shape than the contract type narrows it explicitly.

`GET /v1/workflows/versions` is a keyset page of one workflow's history,
newest first: `limit` (default 50, at most 200), `beforeVersion` as the
cursor below the oldest row shown, and `version` to pin one exact row. Rows
keep `dagJson`; the version panel restores, compares and diffs from the
list, and the recovery delta card pins the two versions it compares.

Dynamic contracted reads participate in the same `/v1` lane. The browser path
catalog matches `{parameter}` segments rather than only literal paths, and the
Go parity test mirrors that matcher. `GET /v1/workflows/versions/{versionId}`
requires the owning `workflowId` and returns one closed four-field immutable
snapshot (`id`, `workflowId`, `version`, `dagJson`). Recovery authoring uses it
instead of downloading the complete version history, and both identifiers are
tenant-bound before the canvas can be hydrated.

The optional `currentWorkflow` proposal field is a comparison snapshot, not an
executable workflow submission. It requires `nodes` and `edges` arrays of
objects because proposal diffing consumes node objects and edge cardinality;
save, validation, and execution continue to use their independent full
workflow contracts.

Proposal responses expose the canonical parsed workflow, not the raw provider
document. This matches workflow save: unknown carrier fields are stripped and
normalization happens before the workflow, intent/recovery contract projections,
qualification flags, bindings, and readiness leave the server.

`GET /v1/run` and `/v1/status` share an explicit required snapshot contract:
run identity/lifecycle, typed node and event rows, nullable persisted metadata,
and event pagination. Their unversioned aliases serialize the same typed Go
views. Timestamps retain the existing UTC millisecond format; absent columns
remain explicit nulls, while empty collections remain arrays. Event pages retain
the existing 500-row maximum; this does not impose a new graph-size limit.
Extensible input/output/state/error/event JSON remains a JSON value rather than
an invented closed business schema. Unit fixtures and actual PostgreSQL-backed
responses (including pagination and tenancy errors) protect the wire shape.

The browser uses the generated pagination types and one validated run display
projection for polling, history, Replay Lab and recovery validation. An unreadable,
malformed or wrong-run snapshot cannot replace the last known history, consume a
pagination cursor, start a comparison or authorize Apply. Recovery validation
uses the shared terminal-status set, including `timed_out`, rather than waiting
for a separate dialog timeout after the run has already terminated.

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

Structured request bodies are strict: `decodeBody` refuses unknown fields and
requires exactly one JSON value, with only whitespace allowed after it. This
prevents a client rename from silently decoding to a zero value, and prevents a
valid prefix plus ignored second document from creating different handler,
audit, or signing interpretations. Routes that must distinguish an absent field
from an explicit empty value use a pointer or preserve the field as
`json.RawMessage` in their request contract. The workflow SLO replacement route
requires an explicit `slo`; an object replaces the declaration and `null`
clears it, while omission is invalid. A declaration carries all six stable
keys; the five thresholds may be `null`, while `windowDays` is 7, 14, or 30.
Workflow-health reads revalidate that same closed six-field declaration from
the immutable latest version. Storage errors, malformed persisted policy, and
rollback-version query failures return an opaque internal error rather than a
false not-found response or a plausible score with silently missing policy.

The standard structured-body ceiling is 2 MiB. Workflow validation preserves
the uncapped graph cardinality of the original contract inside that byte
boundary, so its graph algorithms must remain payload-linear where practical:
router adjacency is built once, cycle detection is iterative, and semantic
dominance traverses once per detector rather than once per detector/effect
pair. Do not trade this compatibility for an undocumented node-count limit.
Recursive workflow input schemas are a separate amplification boundary and are
limited to 512 schema nodes consistently in Go and browser runtime guards;
unsupported type tags or an over-limit schema are invalid contracts.

Workflow save is strict at the top level and accepts only the workflow contract
plus the bounded `upstreamHealthSources` carrier. Reliability SLOs remain an
admin-owned resource and cannot be smuggled through the editor-level save
permission. Save persists a canonical parsed DAG, never the raw request object.
The snapshot includes generated `id`/`name`, `dslVersion: "1.0"`, defaulted
`metadata.tags`, normalized descriptive metadata, and finite editor positions.
Unknown keys inside the source contract's non-strict nested objects are stripped
as the source parser does; `upstreamHealthSources` remains in its dedicated
version column. Explicit `null` is not interchangeable with an omitted optional
workflow field. Inline workflow metadata is limited to
`description` and `tags`; owners, folders, runbooks, and AI guidance belong to
the separate workflow-metadata resource.

The canonical append operation lives in the engine and is shared by HTTP and
MCP. It locks the workflow parent, inherits reliability declarations from the
latest immutable version, excludes active rollouts, reconciles schedules, and
commits the version and schedule state atomically. A transport must not
reimplement version allocation with a read-then-insert sequence.

Public workflow status pages use a 256-bit bearer token at
`/public/status/{token}`. The token is revealed only by the enable/rotate
response; PostgreSQL stores its SHA-256 digest, so a later admin read can report
and revoke enablement but cannot reconstruct the public URL. Public payloads are
aggregate-only and intentionally omit tenant ids, run ids, and error bodies.

## Dead-letter snapshots and resolution

`GET /v1/dlq` remains a bounded summary array (at most 200 rows), with explicit
nullable ownership metadata and opaque error/comment JSON. It is not a detail
union. `GET /v1/dlq/entries/{deadLetterId}` returns the full tenant-bound failed
workflow/node snapshot and bounded drill provenance/outcome. The legacy
`GET /dlq?id=...` and unversioned entry path share the same core and wire keys.
Missing or foreign entries are indistinguishable 404 responses. Persisted absent
timestamps remain null; the browser must not invent recency or downtime.

The browser's shared detail boundary validates identity, lifecycle, required
snapshot keys and drill projections before enabling recovery; an incomplete or
wrong-row response cannot become evidence. Extension workflow/node/error JSON is
not redefined as a closed business schema. The explicit `entries` namespace also
keeps legacy `/dlq/queue`, `/dlq/counts` and `/dlq/cluster-members` out of the
versioned-path rewrite.

`POST /v1/dlq/resolve` and its existing unversioned alias require editor-level
`recovery.write`, accept `{id}`, and return `{ok: true}` only when an owned row
was updated. Missing/foreign ids return `dlq_not_found` without a success audit.
This is acceptance of loss, not verified recovery; the linked recovery item
retains `accepted_loss`. The browser checks the affirmative receipt before
showing success or refreshing projections.

### List and catalog projections

Runs, saved workflows and workflow versions have explicit row schemas and the
existing 200-row ceiling. Version history remains newest-first keyset pagination;
exact-version reads must return only that workflow and version. The latest-version
read may return `null` when the workflow has no version. Nullable metadata keeps
its explicit JSON nulls; DAGs and extension JSON are not redefined by the transport.

Tools expose the typed registry catalog directly, including its `array`, `object`
and `unknown` field kinds. The browser edits those kinds as JSON, without changing
the public kind values. Runtime callbacks and accepted-type internals never enter
the wire. Absent input examples remain omitted and explicit empty examples remain
objects. The typed template envelope preserves the embedded workflows and absent
versus empty credential requirements.

Browser readers validate entire pages before updating a projection: malformed
successful responses are errors, not empty lists or partially filtered success.
They reject duplicate identities, invalid consumed fields and mismatched version
ownership/cursors; authoring uses the existing workflow-definition guard. A failed
bootstrap refresh retains previous lists and newer run-event patches. Version
history does not advance its cursor when an older page is rejected.
