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
