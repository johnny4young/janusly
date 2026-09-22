# 2026-09 improvement program

Six waves of performance, correctness, architecture and refactoring work,
each landed as local commits on `main` after a green `make verify`. The plan
that drove it lists every finding by id (S/C/P/D/O/B/FB/F/FA/FR/FT/R/A/T).

| Wave | Commits | What changed |
|---|---|---|
| 0 — stop the bleeding | `d1fed9ca`..`c5fdce39` | `JANUSLY_ENV` read one way everywhere; one pinned SSRF redirect policy; sweep errors reach telemetry; subworkflow repair keeps its marker on failure; the SSE hub is supervised and drained; guarded recovery payloads; referentially stable run arrays; placeholder maintenance gauges removed; CI checks every generator. |
| 1 — contract truth | `7f074533`..`ec58df94` | OpenAPI describes `/dlq/clusters` and `/recovery/metrics` as served; 19 reads moved to `contractApi` with a ratchet; error boundary and focus trap fixes; route table frozen; clock injected into events; credentials no longer forwarded across redirects; node/edge caps on save; rate limits on start, SSO and public status; HSTS; tool registry built once. |
| 2 — engine hot path | `69038714`..`93e3845c` | Claim snapshot carried through completion and dispatch; post-commit work only on terminal completions; org config once per claim; narrowed queries; COPY at run start; pinned transports reused; wake-ups by count; scheduler version cache with a wall budget. |
| 3 — database | `62c839ae`..`bdf5c48e` | `schema.sql` generated from a fresh migration; one baseline edit (hot-path indexes, `runs.workflow_id`/`trigger_kind`, audit GIN dropped); dead-letter retention; session limits per pool role; purge cascades; EXPLAIN pins. |
| 4 — frontend, observability, CI | `4ba414b8`..`9ae591af` | Memoized shell; shared guards and models with a ratchet; polling assertions in e2e; HTTP RED metrics and access log; DLQ/AI/pool collectors; HTTP and pgx spans; CI path filters and Playwright cache; UTC-only scheduling documented. |
| Load qualification fixes | `b79cb9ea`, `bd7790bb`, `32156f0c`, `5f84ee56`, `cd17e77b` | Unset `OTEL_EXPORTER` exports nothing; claim as semi-join pinned to its index; idle-first wake fan-out; outcome transactions replayed after lock waits; execution pool lock timeout 30 s; compose PostgreSQL checkpoints tuned. |
| 5 — architecture | `80c0adf4`..`b91c5a34` | Registry and semantic recovery split; 42 fat closures to thin handlers; `internal/httpkit` leaf with `scim` and `externalruntime` feature packages; provider-call seam; `org_id` on run rows; AI Studio, RecoveryDialog, RecoveryCasePanel and RecoveryItemDrawer split into controllers and views; hash router with routed navigation buses; tagged invalidation; first CSS split; budgets raised once by the measured cost. |
| 6 — quality sweep | `e6b94d8d`.. | `unparam` in the lint gate with its fourteen findings fixed; every gated route through `s.route`; the workflow validator dispatches by node type (complexity 256 → 53), the parser decodes nodes and edges in their own functions (118 → 51), and the database tool, recovery contract validator, semantic contract validator, workflow binder, proposal binder, for-each loop, ai node, email tool and AI review sanitizer are each split into named steps (every function under 55, most under 30); 55 unused web exports removed; the duplicated blocks jscpd found folded; five modal dialogs close on Escape through `useDialogFocusTrap({ onEscape })` and seven components share `useAliveRef`; `AuthoringPanel` renders one `InspectorPanel`; `docs/development.md` written. |
| 7 — frontend refactor (2026-09-05/06) | `27ec80ab`, `eb0af008`, `1f37b00b`, `254a2656`, `da72b2c0` | Every lazy panel ships its own stylesheet (46 component-adjacent sheets; eager `index.css` 41.3 → 25.4 KiB gzip, new 27 KiB cap); AI Studio and the Inspector load lazily from `panel-loaders.ts` with hover/focus/destination preload and a pinned `authoring-workspace` chunk (eager `workflow-workspace` 43.4 → 14.1 KiB, cap 16); the tagged data layer replaces the `platformVersion` broadcast as the default (typed `ResourceTag`, `bumpPlatformVersion(tags)`, 26 subscribers, 18 same-domain mutation sites); `Button` is the only action button (136 legacy `small-command`/`icon-button` sites, pressed-state styling, loading states on the login, rollback and workspace forms). Budgets re-based around the cold path: artifact 605, single-locale 560, eager CSS 27, workflow-workspace 16. |

## Explicit external database pool ownership

- API and MCP share one validated immutable external pool budget across their
  producers and drain it before control-plane pools close. Removed the global
  cache/reset hook and per-acquisition environment parsing.
- Documented the default 25/range 1–500 process-only setting, restart semantics,
  fail-closed boot validation and Compose passthrough. Leases, tenant caps,
  physical one-connection pools and retirement accounting remain unchanged.
- Added independent-owner/metric, missing-owner, boot boundary and configuration
  snapshot tests; existing race/rotation/cancellation and executable drain
  regressions now use explicit owners. Real API SIGTERM and MCP stdio EOF
  tests check durable completion of an active query and zero remaining external
  sessions after teardown.

## Measured results

Load qualification, 20-minute measured phases, p95 / p99 ms:

| scenario | before (`7420403a`) | after (`cd17e77b`) |
|---|---|---|
| start (10 VUs) | 57 / 169 · 340k iterations | 30 / 48 · 447k |
| list (50 VUs) | 25 / 70 · 3.76M | 16 / 21 · 5.19M |
| diamond (10 VUs) | 123 / 280 · 192k | 128 / 219 · 235k |

Zero errors in every scenario; zero lock timeouts; eleven PostgreSQL
checkpoints in 73 minutes instead of one every ~25 seconds.

## Decisions worth remembering

- R3 (`SELECT *` → explicit columns) was dropped: all 79 are gets and lists
  on configuration tables consumed as model structs.
- Recovery governance stays in the API root package: it depends on effective
  permissions, clusters, metrics, readiness, text search, locale and the
  engine, and two root files call its cores. It is the hub, not a leaf.
- Action controls use `Button`; tabs, radios, menu items and rows retain
  their native buttons and component styles.
- Panel refreshes use resource tags only; untagged cross-domain mutations
  still request a full refresh. The duplicate destination-level authoring
  preload is removed; shared chunk dependencies can still load authoring code
  before its panel mounts.

## Completion persistence hardening

Automatic recovery ownership no longer acquires another worker-pool connection
while a completion transaction is holding its locks. Configuration, incident
writes and system audit receipts use that transaction, with nested savepoints
preserving the optional failure boundaries. Debounce child insertion and the
occurrence increment roll back together; a successful audit receipt cannot
survive a later completion rollback.

Validation includes a single-connection completion regression, real PostgreSQL
SQL-failure injection, nested savepoint recovery, tenant opt-out, system audit
identity/redaction, and the five two-instance HA tests with four connections per
pool. HA passes both without session timeouts and with the worker pool's
production-equivalent statement, lock and idle-transaction limits. This is
local engine evidence, not an executable deployment qualification.

## External database pool ownership

Database tools now lease cached pools for the whole operation. Credential
rotation retires a pool without blocking other tenants; final lease release
closes it outside the cache mutex. Retired pools remain counted against the
five-per-organization and configured process limits. Idle same-tenant LRU
replacement preserves capacity; all-busy capacity fails with the existing
`db_pool_exhausted` envelope rather than oversubscribing connections. The query
budget includes connection acquisition, and the runtime drains tool pools after
its workers. Real PostgreSQL race tests cover rotation, physical accounting,
eviction, cancellation, concurrent admission and shutdown. An executable-level
SIGTERM test verifies that an active external query completes before pool drain.

## Run-status response integrity

An interrupted successful response body can no longer masquerade as an empty
object. Body cancellation remains cancellation; unreadable error details do not
discard an authoritative HTTP error status. Run polling validates the complete
snapshot before touching summary, nodes, events or pagination, preserving the
last good projection when a proxy or interrupted response supplies malformed
content. Nullable persisted metadata is represented honestly, without invented
activity timestamps. Regression coverage includes failed body reads, malformed
and cross-run projections, stale request ownership, terminal polling shutdown,
history pagination, and real Chromium stream failure/cancellation followed by a
successful retry. The existing production bundle caps remain unchanged.

## Classified CI and bounded HA

Documentation-only changes now emit a stable CI result instead of leaving a
path-filtered workflow absent. The aggregate gate requires every selected lane
to succeed and accepts only classifier-authorized skips. Complete, NUL-delimited
Git diffs account for deletion, rename and shared inputs; errors fail closed.
Web-only changes run browser/API/proxy parity. Two-instance HA now runs with four
connections per replica, drains every test loop, and has a dedicated PostgreSQL
service, timeout diagnostics and an isolated local target. Website PR validation
uses its own secret-free npm/Astro workflow; the product artifact never builds
for a website-only push. Wrangler is locked to an exact local dependency.
The retention countdown regression freezes its clock before mount and fixture
reads, with explicit millisecond-boundary tests rather than relaxed assertions
or retry-to-green. Repository protection settings remain owner-controlled.

## Typed run snapshots

Run/status now declare the full required response schema and serialize typed Go
snapshot, node and event views. Nullable metadata and millisecond timestamps keep
the established wire, with schema conformance checks against real responses.
Generated browser types replace generic run/node/event records; history, Replay
Lab and recovery validation reuse the snapshot guard instead of double casts.
Malformed or wrong-run success cannot authorize Apply or discard history. A
validation run that reaches `timed_out` is now handled as terminal failure.
This is a vertical contract change, not a universal response-validation layer;
extensible JSON payloads remain intentionally unconstrained.

### Typed dead-letter evidence

- Dead-letter summary and detail contracts now expose their actual nullable wire
  metadata, snapshots and drill outcomes. A dedicated versioned entry route
  shares the legacy detail operation without changing the list shape.
- Recovery selections validate the returned identity and complete snapshot
  envelope before enabling actions. Generated drill types replace duplicated
  browser definitions; null timestamps remain unknown rather than fabricated.
- Resolving a missing or foreign dead letter now returns an indistinguishable
  not-found response instead of a false success and audit. Owned resolutions
  remain acceptance of loss, with the same editor permission gate.

### List contract and catalog compatibility

- Explicit run, workflow, version, template and tool list contracts now generate
  their browser wire types from the route manifest. Actual typed views, embedded
  templates, tool registry and versioned/legacy HTTP responses are checked against
  those schemas.
- Shared page readers reject malformed or duplicate projections before updating
  lists or enabling version actions; failed refreshes retain existing data and
  version pagination cursors. Latest-version absence remains nullable.
- Removed the duplicate map-based tool catalog projection. JSON editors recognize
  the registry's array, object and unknown kinds and preserve literal quoting.

### Reaper configuration ownership

The periodic stalled-node sweep and scoped recovery drill now share validated,
constructor-injected process settings, including the stdio entry point. Invalid
cadence, threshold and floor values fail boot instead of silently falling back;
duration overflow is rejected. Long production thresholds are no longer shortened
by a separate drill-only cap. The undocumented minutes-only drill setting is
rejected with a replacement hint. Core configuration errors identify the setting
and accepted range without echoing its value; tenant overrides remain dynamic.

## Shared HTTP configuration semantics

The engine now resolves HTTP defaults through the same organization catalog as
the settings API. Removed the duplicated HTTP parser/specification and unused
process timeout field. Boot validates all four environment fallback bounds;
the timeout minimum matches the canonical 1 ms floor rather than an unrelated
1000 ms floor. HTTP fractions are rejected instead of rounded by the catalog,
while unrelated legacy numeric catalog semantics remain unchanged.

Tenant → environment → default precedence and per-claim tenant snapshots remain
intact. Compose forwards all four settings; malformed inputs reach redacted boot
validation instead of silently becoming defaults. Per-node ceilings, SSRF,
redirect validation and DNS pinning are unchanged.

## Recovery comparison ownership

Applied recovery evidence now belongs to one operator, organization, workflow,
canvas revision and permission scope. Context changes synchronously abort health
and exact-version reads, clear stale rollback intent and prevent a captured
before-snapshot from appearing under another workflow. Response projections fail
closed on invalid counts, scores, deltas, recurrence samples or immutable version
identity. Rollback remains a separate confirmed action and restores keyboard focus.

The UI counts terminal observations rather than in-flight runs, treats zero
recurrence as neutral monitoring evidence, and links recurrence through the
canonical activity route. Shared metric rendering and native progress replace
duplicated branches and custom progress markup. The pure health-delta guard ships
with the existing recovery-contract chunk, keeping the original artifact,
single-locale, route and RecoveryDialog budgets intact without rebaselining.
