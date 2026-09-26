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

Every manifest schema, request and response, is closed: objects set
`additionalProperties: false` or are typed maps, and every value names a
type. The legitimately open ones are named fragments listed with a reason in
`openSchemaAllowlist` in `internal/contract/manifest_test.go`: workflow
documents (strip-parsed on input and served as stored bytes, so version
reads never claim more than the persisted DAG), node configuration, relay
payloads, form and start input, and grouped opaque JSON such as run
payloads and dead-letter snapshots. Every route
has a wire-conformance row in `internal/httpapi/manifest_conformance_test.go`:
unit fixtures from the typed views and pure cores, or live PostgreSQL-backed
responses in the matching integration test, each also rejecting an
undeclared key.

A vocabulary the browser translates is a manifest `enum` built from one
exported Go list (`strEnum` in `internal/contract`): recovery case states,
actor and artifact kinds, detector actions, autonomy sources, unavailable
reasons and capabilities (`internal/domain`), rollout statuses
(`domain.WorkflowRolloutStatuses`), qualification failure datasets and reasons
(`internal/recovery`), and failure-cluster categories and owners
(`internal/signature`). `internal/contract/enum_sources_test.go` scans the
code and SQL that write those values and fails on a literal the list does not
declare, and pins the lists behind a database `CHECK` to that constraint. The
generated guard then rejects an unknown value, so readers keep only the
translation maps, which typecheck against the generated union.

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

Shared fragments are registered by name in `internal/contract/components.go`.
`cmd/contract` emits each once under `components/schemas` and references it with
`$ref` everywhere else, including a route whose whole payload is one component;
the Go tests keep validating the in-memory schemas, so references never need
resolving there. `web/scripts/generate-api-types.mjs` turns every component into
a named TypeScript type and fails on an unresolved reference or a reference
cycle instead of degrading to `unknown`.

Run `make generate` after contract changes and require a clean diff on a second
run.

## Browser validation

`web/scripts/generate-api-guards.mjs` renders `web/src/lib/api-guards/` from
the same document: one module per shared schema (`components/<Name>.ts`
exporting `is<Name>`) and one per operation with a 2xx payload
(`operations/<Stem>.ts` exporting `is<Stem>Response`, for example
`operations/GetRun.ts` with `isGetRunResponse` for `GET /run`). Guards are plain
functions composed from the primitives in `web/src/lib/guards.ts`; each module
imports only the primitives and component guards it references. There is no
schema library, no barrel, no aggregate map and no module state, so a guard
ships in the chunk of the call sites that import it: a guard used only by a lazy
panel stays in that panel's chunk. A guard the eager Home controller imports
ships eagerly: all eight `/recovery/home` section guards, including
`RecoveryMetrics` and `FailureClusters`, land in `app-workspace.js` even though
the lazy `HomeInsights` chunk renders them. The generator rewrites the whole
directory, so a removed schema leaves no orphan module.

A guard enforces shape: JSON types, nullability, `enum`/`const`, required keys,
closed key sets (`additionalProperties: false`), typed map values and integer
exactness. It deliberately does not enforce `maxItems`, `maxLength`,
`minLength`, `minItems`, `minimum` or `maximum`: those are server policy that
can change without a client release, and the browser validates shape, never
policy. `oneOf` is checked as "any branch matches" because manifest branches are
disjoint closed shapes. The generator throws, naming the schema path, on any
other keyword, and on an empty `enum`/`const` set or a literal that contradicts
the declared `type`, so a new manifest construct cannot be silently skipped or
compiled into a guard that rejects everything.

### The rule

The browser validates **shape** from the manifest and never re-encodes server
**policy**:

- Shape (types, nullability, enums, required and closed keys) is the generated
  guard's. A payload that fails it raises `MalformedResponseError`
  (`web/src/lib/malformed-response.ts`) with the `api.error.malformedResponse`
  copy; a panel that had its own unavailable copy catches that class and keeps
  it, while transport and HTTP errors pass through unchanged.
- The hand-written readers (`list-contract`, `run-status-contract`,
  `dead-letter-contract`, `recovery-patch-contract`, `recovery-case-contract`,
  `authoring-contract`, `health-delta`, `recovery-home-sections`,
  `ai-evidence-runtime` and the rollout and qualification parsers) keep only
  **UI invariants**: cross-field facts a component depends on, each commented
  with the component that needs it. Examples:
  echoed ids (`run.id === runId`, a rollout of this workflow), unique row ids,
  `eventsCursor` present exactly when `eventsHasMore`, a delta present exactly
  when `hasEnoughData`, fallback and playbook suggestions pinned to their fixed
  confidence, a validation bound to its candidate by SHA-256, a vocabulary the UI
  translates that the manifest leaves open (AI evidence kinds, patch approach
  labels), a date `Intl` must format. Extension JSON that the manifest keeps
  opaque is narrowed only as far as the component reads it.
- Policy never appears in the browser: maximum lengths, page sizes, item counts
  and numeric ranges copied from Go become a "malformed response" outage the day
  the server changes them. Form bounds for operator input (the rollout draft) are
  UX, not response validation, and carry a `// wire-policy:` marker naming their
  Go source. So do display bounds the browser truncates to (AI evidence chips)
  without ever rejecting a longer response.

### Adding a route end to end

1. Describe the route in the Go manifest (`internal/contract`) with a closed
   response schema, and keep its wire-conformance test green.
2. Run `make generate`: it renders `contract/openapi.json`, the TypeScript
   types and `web/src/lib/api-guards/operations/<Stem>.ts`.
3. Import that one module and pass it to `contractApi` next to the call:

```ts
import { isGetRunResponse } from '../lib/api-guards/operations/GetRun'

const run = await contractApi('GET /run', path, undefined, { guard: isGetRunResponse })
```

4. Add a reader function only if the component needs a UI invariant the shape
   cannot express, and test that invariant plus one case proving shape is
   delegated to the guard.

The option is typed to the operation, so a guard for a structurally different
operation does not compile (type predicates are structural: two operations with
the same payload type accept each other's guard). `contractApi` runs it on the
unwrapped payload of a 2xx response only; non-2xx responses (including a 429
that carries a data envelope) still throw `ApiError` before any guard runs, and
the `/start`/`/resume` field-error envelope is passed through. Without a guard
the call behaves exactly as before.

Every manifest route has a wire-conformance row, so a guard checks what the
server is tested to send. Durable mutations follow one rule:

- Guarded when the receipt drives client state: `POST /workflows/save` from
  the editor, `POST /workflows/rollback`, rollout create
  (`POST /workflows/{workflowId}/rollout`), rollout decision
  (`POST /workflows/{workflowId}/rollout/{rolloutId}/{decision}`), rollout
  qualification (`POST /workflows/{workflowId}/rollout/qualification`),
  `POST /dlq/resolve` and `POST /recovery/playbooks/{id}/use`.
- Unguarded when the receipt is only a tolerated acknowledgement, so a
  committed mutation is never reported as a failure: the recovery-case ladder
  (`diagnose`, `candidates`, `validate`, `approve`, `apply`, each followed by a
  case reload), `POST /dlq/validate-fix`, the recovery dialog's
  `POST /workflows/save` and `POST /dlq/replay`.

`GET /recovery/home` is read without the whole-response guard because the
server settles each section independently. `recovery-home-snapshot` checks only
the envelope (`scope`, `generatedAt`, a `sections` object) and a malformed
envelope shows `recoveryCenter.invalidHomeResponse`. Each section reader in
`recovery-home-sections` runs that section's generated component guard
(`RecoveryLedger`, `RecoveryWins`, `RecoveryHomeQueue`, `RecoveryMetrics`,
`FailureClusters`, `RecoveryHeatmap`, `RecoveryHomeCases`,
`RecoveryValidationReport`); a section that fails it degrades alone, exactly
like a server-side `unavailable`, and a section key the manifest does not name
is ignored.

`GET /workflows/{workflowId}/rollout` is outside the manifest because it shares
a mux pattern with the versioned routes; its reader checks the envelope by hand
around the generated `isWorkflowRollout` component guard.

### Ratchets

`pnpm lint` enforces the rule:

- `scripts/check-wire-policy.mjs` fails on any numeric literal other than 0, 1
  and -1 in the hand-written readers unless its own line carries
  `// wire-policy: <reason>` or the line directly above is that marker alone
  (baseline zero).
- `scripts/check-duplicate-guards.mjs` owns the guard-like exports of
  `src/lib/guards.ts` (`is*`, `as*`, `has*`, including the primitives the
  generated guards import) and rejects a local re-declaration even with
  different casing. Combinators (`shape`, `literal`, `nullable`, `anyOf`,
  `isAny`, ...) are ordinary names elsewhere and are not checked.
- `scripts/check-raw-v1-reads.mjs` rejects a raw `api()` call on a v1 read path
  and on any manifest operation, reads and mutations, literal or templated
  paths, matched by method. A deliberate exception carries `// raw-api: <reason>`;
  calls that predate the check are listed in `RAW_OPERATION_BASELINE`, which may
  only shrink. Its test also pins the variable-path call sites that motivated the
  check to `contractApi`. Limitation: a variable or concatenated path, or a
  variable `method`, is not seen.

`make generate` regenerates the guards after the types; the drift gate covers
the generated directory, including new untracked modules;
`web/scripts/generate-api-guards.test.mjs` compiles and runs synthetic output
for every supported keyword, and `web/src/lib/api-guards.test.ts` samples every
operation from `contract/openapi.json` and checks acceptance, closed keys,
required keys, wrong types and that server bounds are not enforced.

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

The browser's shared detail boundary checks the generated shape and the row
identity before enabling recovery, and copies only the declared keys; an
incomplete or wrong-row response cannot become evidence. Extension workflow/node/error JSON is
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
Shape comes from the generated guards; the readers reject duplicate identities
and mismatched version ownership/cursors, and authoring uses the existing
workflow-definition guard. Page sizes stay server policy. A failed bootstrap
refresh retains previous lists and newer run-event patches. Version history does
not advance its cursor when an older page is rejected.
