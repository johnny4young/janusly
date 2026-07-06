# World-class audit — 2026-07-06

A full-project state assessment (functionality, usability, UX, performance,
architecture, scalability, testability, simplicity, maintainability,
libraries) plus an explicit, executable improvement backlog. Method: four
parallel audit passes (architecture/dependencies, web frontend/UX,
performance/scalability, testability/DX), load-bearing claims re-verified
against the actual code before being written here.

**Relationship to `20260702-deep-review.md`:** complements it, does not
duplicate it. Everything §3 of the deep-review already proposed stays there
(items #1/#18/#21/#25 already consumed as ENG-264/ENG-266/in-PR/billing CSV).
This document only contains NEW findings and NEW proposals.

**Baseline at audit time:** `main` clean at `56a8e11`; 5,569 tests across 321
files; roadmap §3b has only ENG-093 pickable; highest ticket id ENG-266 →
**next free id ENG-267**.

**How to execute (second iteration):** every proposal below is single-ticket
sized with acceptance criteria. Promote a proposal to a new `ENG-NNN` row in
ROADMAP §3b (per §4 "How to add a ticket") and ship via `janus-ship`. The
recommended pick order is §5.

---

## 1. State of the project — per-axis scorecard

| Axis | Grade | Evidence (verified) |
| --- | --- | --- |
| **Functionality** | Strong | Full recovery loop (DLQ → AI patch → sandbox validate → apply/cluster-apply → rollback), 24 node types, ~110 routes, SSO/SCIM, alerting, budgets, memory substrate, 2 SDKs, MCP both directions. |
| **Usability** | Good | Recovery Center as home; ~2–3 clicks failure→fix; command palette (⌘K), shortcuts overlay, dark mode, density, EN/ES. Gaps: no keyboard path for recovery actions, no bulk-progress feedback. |
| **UX polish / delight** | Fair | Functional, not delightful: numbers jump (no animated counters — `useAnimatedNumber` exists but is unused), no trend sparklines, no favorites/pinning, no live activity feel outside the run inspector. |
| **Innovation / originality** | Strong wedge, under-expressed | The recovery wedge (MTTR) is genuinely differentiated, but the UI shows *state* not *story*: MTTR is a number, not a lived experience (no downtime clock, no "minutes saved", no recovery streak). §2E closes that gap. |
| **Performance** | Good, 3 cheap wins left | July-2 pass fixed the hot engine paths. Remaining: **no HTTP compression anywhere in `apps/api`** (verified), **`listOrgConfig` unbounded + uncached per request** (`packages/data/src/orgConfigRepo.ts:158`), audit-log action-prefix filter has no supporting index. |
| **Architecture** | Excellent | Route registry (~110 routes, no strain), org-scoping 100% consistent across all 50 data repos, zero TODO/FIXME in src, chokepoints (safe-persist, audit-tx, errorEnvelope, LlmClient) hold. |
| **Scalability** | Good to ~100 orgs | First breakpoints in order: audit-log prefix scans, dashboard aggregations that materialize ≤10k rows per poll with no cache, retention sweep visiting all orgs, SSE synchronous fan-out to slow clients. All addressed in §2A. |
| **Testability** | Strong pyramid, 3 structural gaps | 5,569 tests, but: no integration lane (SQL correctness "verified in live smoke" per repo-test comments), no web↔route contract check, and the **core recovery loop is not covered end-to-end** (the F3 e2e stops at "landed in DLQ"). |
| **Simplicity** | Good | Two god-files left (`apps/api/src/templates.ts` 911 lines; `node-registry.ts` 939 but cohesive), 8 repos re-implement the same CAS outcome logic, 4 web components re-implement polling. |
| **Maintainability** | Excellent | Docs-first invariants (AGENTS.md + architecture docs), closed catalogs (permissions, org-config, error codes, audit actions), i18n parity gate. |
| **Libraries** | Excellent hygiene | Zero unused deps, zero version skew (zod/bullmq/ioredis/postgres uniform). One caveat: `drizzle-orm`/`drizzle-kit` pinned to RC **commit hashes** (`1.0.0-rc.4-5d5b77c` / `-ca0f029`) — intentional but undocumented. |

**North-star check:** the README holds Janusly to *MTTR from hours to minutes
to seconds*. The single biggest gap this audit found is that the product
**measures** MTTR but doesn't **dramatize** it — the operator never feels time
being saved. Section §2E exists to fix exactly that, on top of the existing
metrics plumbing (no new infrastructure).

---

## 2. Proposals

Each proposal: **Problem → Design → Files → DB → Acceptance criteria**.
Effort: S (≤½ day), M (1–2 days), L (3–5 days). All are buildable on existing
architecture; DB changes are listed inline and consolidated in §3.

### 2A. Performance & scalability

> **Batch 1 shipped (2026-07-06):** P-01 → ENG-267, P-02 → ENG-268,
> P-03 → ENG-269, P-05 → ENG-270. All green under `pnpm build`/`pnpm test`;
> ENG-269's migration + EXPLAIN verified against Compose Postgres. See
> ROADMAP §3c for closing evidence.

#### P-01 — HTTP response compression (S, high impact) — ✅ shipped ENG-267
**Problem.** No `gzip`/`Content-Encoding` handling exists anywhere in
`apps/api/src` (verified by grep). JSON payloads (recovery metrics, run
detail, clusters) ship uncompressed; 60–80% reduction is on the table.
**Design.** In the `sendJson` chokepoint (`apps/api/src/http.ts`): if the
request's `Accept-Encoding` includes `gzip` AND the serialized body is
> 1 KB, compress with `node:zlib` `gzipSync` and set
`Content-Encoding: gzip` + `Vary: Accept-Encoding`. Never touch the SSE
route (it doesn't use `sendJson`). Env kill-switch
`JANUSLY_HTTP_COMPRESSION=false`.
**Files.** `apps/api/src/http.ts`, `docs/configuration.md`.
**DB.** None.
**AC.** `GET /recovery/metrics` with `Accept-Encoding: gzip` returns a gzip
body that round-trips to identical JSON; a <1 KB response stays uncompressed;
SSE stream unaffected; unit tests for both branches; kill-switch honored.

#### P-02 — Org-config snapshot cache (S, high impact) — ✅ shipped ENG-268
**Problem.** `listOrgConfig` / `getOrgConfigSnapshot`
(`packages/data/src/orgConfigRepo.ts:158,224`) hit Postgres on every call with
no LIMIT and no cache, and they run on most authenticated hot paths (AI
routes, recovery metrics, engine boot-per-node config reads).
**Design.** In-process TTL cache keyed by `orgId` inside `orgConfigRepo.ts`:
`Map<orgId, { snapshot, expiresAt }>`, TTL default 30_000 ms
(`JANUSLY_ORG_CONFIG_CACHE_TTL_MS`, `0` disables), max 1,000 entries with
simple LRU eviction. Same-process writes (`setOrgConfig`/`deleteOrgConfig`)
invalidate the key synchronously. Cross-replica staleness is bounded by the
TTL — document that config changes propagate within 30 s to other replicas
(acceptable: the catalog is runtime *tuning*, not authz). Also add
`.limit(200)` to the base query as a safety bound (catalog is ~50 keys).
**Files.** `packages/data/src/orgConfigRepo.ts`, `docs/configuration.md`.
**DB.** None.
**AC.** Second `getOrgConfigSnapshot(org)` within TTL issues zero queries
(assert via mocked db call count); a write invalidates same-process cache
immediately; TTL=0 restores today's behavior byte-for-byte; tests for
eviction cap.

#### P-03 — `audit_logs` action-prefix index (S) — ✅ shipped ENG-269
**Problem.** `queryAuditLogs` filters with `LIKE 'prefix%'` on `action`
(`packages/data/src/auditLogsRepo.ts`) but the only index is
`(org_id, created_at)` — per-org seq-scan once audit volume grows.
**Design.** Add index `audit_logs_org_action_created_idx` on
`(org_id, action varchar_pattern_ops, created_at DESC)`. Follow the two-file
hot-path pattern (plain `CREATE INDEX IF NOT EXISTS` in `migration.sql` +
`production-rollout.sql` with `CONCURRENTLY`); the opclass needs the same
hand-edit precedent as GIN (drizzle builder can't emit it).
**Files.** `packages/db/src/schema.ts`, new migration pair.
**DB.** One index.
**AC.** `EXPLAIN` for `org_id = $1 AND action LIKE 'org.scim%' ORDER BY
created_at DESC LIMIT 50` uses the new index on a seeded table; migration
applies cleanly from zero; `production-rollout.sql` present.

#### P-04 — Consolidated home bootstrap endpoint (M)
**Problem.** First paint of the Recovery Center fans out to ~15 sequentialish
requests (`/recovery/metrics`, `/dlq/clusters`, `/dlq/counts`, budget,
workflows list, …), each paying auth + org-config + HTTP overhead.
**Design.** New route `GET /home/bootstrap` (permission `runs.read`) in a new
`apps/api/src/routes/home-routes.ts`: runs the underlying repo calls via
`Promise.all` and returns
`{ recoveryMetrics, dlqCounts, clusters, budget, workflowsSummary }` — reusing
the exact repo functions the individual routes call (no logic duplication;
individual endpoints stay for panel-level refetch). Web: `RecoveryCenterPanel`
consumes the bootstrap on mount + `platformVersion` bump; per-tile refetch
paths unchanged.
**Files.** `apps/api/src/routes/home-routes.ts` (new), `apps/api/src/index.ts`
(spread), `apps/web/src/components/RecoveryCenterPanel.tsx`, `docs/api.md`.
**DB.** None.
**AC.** Home tab initial load issues ≤5 API requests (was ~15); response
shape unit-tested; route registered with correct permission; panels still
refetch independently on their own actions.

#### P-05 — `/recovery/metrics` response micro-cache (S) — ✅ shipped ENG-270
**Problem.** Every dashboard poll re-runs the 8-query fan-out in
`queryRecoveryMetricsSignals`, materializing up to 10k rows per signal — with
multiple viewers this multiplies linearly for identical results.
**Design.** In-process cache of the composed metrics envelope keyed by
`(orgId, windowDays)`, TTL 30 s (`JANUSLY_RECOVERY_METRICS_CACHE_TTL_MS`,
`0` disables). Invalidate on the same-process DLQ replay/resolve mutations
(cheap: clear org key in the route handlers). This is the cheap step; a
`recovery_metrics_daily` rollup table remains the documented scale path
(deferred — see §3 note).
**Files.** `apps/api/src/routes/recovery-routes.ts` (or a small
`apps/api/src/metrics-cache.ts`), `docs/configuration.md`.
**DB.** None.
**AC.** Two GETs within TTL run the repo fan-out once (mock call count);
replay/resolve clears the org's entry; TTL=0 disables.

#### P-06 — `scim_processed_events` TTL sweep (S)
**Problem.** The idempotency table `scim_processed_events` has a schema
comment promising a "future TTL job" that doesn't exist — unbounded growth at
enterprise SCIM volume.
**Design.** Extend the existing retention scheduler (same `system:` cron, no
new cron) with a step deleting rows `processed_at < now() - N days`,
`N = retention.scimProcessedEventsDays` org-config key (typed number, default
30, category following the existing retention keys), batched like the other
sweeps.
**Files.** the retention scheduler in `packages/engine/src`,
`packages/data/src/orgConfigCatalog.ts`, retention repo, docs.
**DB.** One org-config catalog key (no migration).
**AC.** Sweep deletes only rows older than the cutoff; batching respected;
config key validated in catalog tests; a replayed webhook inside the window
still dedupes.

#### P-07 — Retention sweep org pre-filter (S)
**Problem.** The retention sweep iterates all orgs even when only a few have
expired data — O(orgs) queries per tick.
**Design.** Replace the org enumeration with one query:
`SELECT DISTINCT org_id FROM (UNION of the swept tables filtered by
created_at < cutoff)` — only orgs with eligible rows enter the loop.
**Files.** retention scheduler + its repo function.
**DB.** None.
**AC.** With 10 orgs where only 2 have expired rows, per-table DELETEs run
only for those 2 (assert via query spy); sweep results unchanged.

#### P-08 — SSE fan-out slow-client guard (M)
**Problem.** `apps/api/src/run-stream.ts:105` fans out with a synchronous
`res.write` per subscriber; one slow client degrades delivery for every other
subscriber of that run.
**Design.** Check the `res.write()` return value; on `false` (backpressure),
increment a per-subscriber strike counter; after 3 consecutive strikes,
disconnect that subscriber with a terminal SSE comment
(`: slow-consumer-disconnect`) — the web client already reconnects and
re-syncs via refetch. Emit an OTel counter for disconnects.
**Files.** `apps/api/src/run-stream.ts`, test.
**DB.** None.
**AC.** A mocked subscriber whose `write` returns `false` 3× gets closed;
healthy subscribers keep receiving; reconnect path exercised in an existing
web test remains green.

#### P-09 — pgvector HNSW verification + worker concurrency tuning (S)
**Problem.** (a) The `memory_entries` HNSW index is "hand-patched" per repo
comments — if absent in an environment, recall degrades to seq-scan
similarity. (b) `WORKER_CONCURRENCY ?? 10`
(`packages/engine/src/worker.ts:404`) is conservative and undocumented.
**Design.** (a) Add a `packages/db` test that asserts `pg_indexes` contains
the HNSW index on `memory_entries` after migrations (runs wherever a real DB
is available — pairs with P-31's integration lane); document the check in the
production-rollout runbook. (b) Document `WORKER_CONCURRENCY` in
`docs/configuration.md` with guidance (10 default; 30–50 measured safe once
pool headroom is confirmed) — raising the default waits for a load test.
**Files.** `packages/db` test, `docs/configuration.md`.
**DB.** None (verification only).
**AC.** DB test fails if the HNSW index is missing; configuration doc lists
the env var with sizing guidance.

### 2B. Architecture & maintainability

#### P-10 — Split `apps/api/src/templates.ts` (911 lines) (M)
**Problem.** ~40 message templates (Slack/GitHub/recovery/report bodies) live
as string literals in one file — hard to locate, untestable per-template,
blocks future i18n of outbound copy.
**Design.** Create `apps/api/src/templates/` with one module per surface
(`slack.ts`, `github.ts`, `recovery.ts`, `reports.ts`, …), each exporting pure
`(params) => string` functions; `templates.ts` becomes a re-export shim so no
caller changes. One test file per module (snapshot the rendered strings).
Cross-package move to `@janusly/shared` is explicitly NOT part of this ticket
(the shared barrel ships to the browser; revisit only if the web ever needs a
template).
**Files.** `apps/api/src/templates/*` (new), `apps/api/src/templates.ts`
(shim), tests.
**DB.** None.
**AC.** Byte-identical output for every template (snapshot tests written
BEFORE the move, green after); no import-site changes; file ≤150 lines each.

#### P-11 — Shared CAS outcome helper (S)
**Problem.** Eight data repos re-implement the same compare-and-swap
"empty UPDATE → re-select → `not_found` vs `conflict`" logic (~7 lines each;
e.g. `credentialsRepo.ts` rotation, `recoveryItemsRepo` transitions,
`autoHealingRepo.recordDecision`).
**Design.** `packages/data/src/cas-helper.ts` exporting
`applyCasUpdate(updated: T[], existsCheck: () => Promise<boolean>) :
{ ok: true, row: T } | { ok: false, reason: "not_found" | "conflict" }`.
Mechanical adoption in the 8 repos; sibling-relative imports (barrel rule);
no behavior change.
**Files.** new helper + 8 repo edits + helper test.
**DB.** None.
**AC.** All existing repo tests green unchanged; helper unit-tested for both
failure reasons; grep shows no remaining hand-rolled duplicate of the
pattern.

#### P-12 — Error-envelope completion for the 13 known free-form sites (M)
**Problem.** The deliberate `error-codes.ts` staging left free-form
`sendJson(res, { error: … })` sites; 13 concrete ones remain in
`workflows-routes.ts` (~189, 201), `recovery-items-routes.ts` (~217, 240,
263, 294, 339, 390, 425, 456), `solution-packs-routes.ts` (~133).
**Design.** Add 3 catalog codes (`workflow_validation_failed`,
`recovery_item_invalid_body`, `solution_pack_invalid_sample_run`) with EN/ES
i18n (parity gate), convert the 13 sites to
`sendError(res, code, message, status, { issues })`. This is the scoped,
product-copy-sized slice of the known staging — not the full ~150-site sweep.
**Files.** `apps/api/src/error-codes.ts`, the 3 route files, web i18n locales.
**DB.** None.
**AC.** The 13 sites emit coded envelopes; i18n parity test green; existing
route tests updated to assert the code.

#### P-13 — Extract `node-execution-utils.ts` (S)
**Problem.** `fallbackAiResponse`, `previewText`, `withTimeout`,
`createTenantLlmClient` are general-purpose helpers trapped inside
`packages/engine/src/node-registry.ts` (939 lines) — unimportable without the
whole registry.
**Design.** Move the four helpers to
`packages/engine/src/node-execution-utils.ts`; registry imports them. Pure
file move, no signature changes.
**Files.** 2 engine files + test move.
**DB.** None.
**AC.** `pnpm build` + engine tests green with zero behavior change; helpers
importable standalone.

#### P-14 — `usePoll` hook for the web (S)
**Problem.** ~4 components (App run-polling aside, RecoveryDialog,
ReplayLabDialog, UsageSummaryCard) re-implement interval-fetch + cleanup.
**Design.** `apps/web/src/hooks/usePoll.ts`:
`usePoll(fetcher, intervalMs, { enabled })` → `{ data, error, refresh }`,
interval cleared on unmount/disable. Adopt in the 3 dialog/card components;
the main run-polling hook (`useRunPolling`) stays as-is (it has SSE-aware
semantics).
**Files.** new hook + hook test + 3 component edits.
**DB.** None.
**AC.** Components' existing tests green; hook test covers enable/disable +
cleanup (no timer leak via `vi.useFakeTimers`).

#### P-15 — Document the drizzle RC pin + registry health (S, docs-only)
**Problem.** `drizzle-orm 1.0.0-rc.4-5d5b77c` / `drizzle-kit 1.0.0-rc.4-ca0f029`
are commit-hash pins with no recorded rationale; upgrade path to 1.0.0 stable
is undefined.
**Design.** Add an AGENTS.md bullet: pins are intentional (migration
stability), upgrade both in lockstep when 1.0.0 stable ships, with a
migration-regeneration smoke as the gate. Also note the route registry is
healthy at ~110 routes (measured 2026-07-06) and a typed router is not
warranted below ~200.
**Files.** `AGENTS.md`.
**DB.** None.
**AC.** Bullet present; no code change.

### 2C. UX & stickiness (no new deps; hand-written CSS only)

#### P-16 — Animated metric counters (S) — ✅ already implemented (finding inaccurate)
> Verification during batch 2 found this ALREADY shipped: every Recovery
> Center / Runs tile passes `numericValue` into `VitalSignsStrip`, which drives
> the existing `useAnimatedNumber` count-up (reduced-motion-aware). No work
> needed — the audit's "hook is unused" note was wrong.

**Problem.** Recovery Center metric tiles jump between values on
`platformVersion` bumps; the existing `useAnimatedNumber` hook is unused.
**Design.** Wire `useAnimatedNumber` into the metric strip
(`VitalSignsStrip.tsx`): tween old→new over 400 ms, skip on first render,
respect `prefers-reduced-motion` (render final value directly).
**AC.** Value change animates; initial render doesn't; reduced-motion renders
statically; component test asserts final value.

#### P-17 — MTTR trend sparkline (M) — ✅ shipped ENG-271
**Problem.** MTTR is a snapshot number; operators can't see if recovery is
getting faster or slower — the north-star metric has no trend affordance.
**Design.** Extend `/recovery/metrics` with `mttrTrend: Array<{ day, seconds }>`
(last 14 days; derived in the existing signals query window — one extra
GROUP BY day on data already scanned). Render an inline SVG sparkline
(~80×12 px, hand-drawn `<polyline>`) in the MTTR tile, green when the last
point < mean, red otherwise; tooltip "MTTR ↓ 8% this week".
**Files.** `recoveryMetricsRepo.ts`, recovery route, `VitalSignsStrip.tsx`,
i18n EN/ES, sdk types.
**DB.** None.
**AC.** Envelope carries ≤14 points; sparkline renders both colors in tests;
empty data hides the sparkline (no NaN paths).

#### P-18 — Keyboard-first recovery triage (S)
**Problem.** Approve/Resolve/Replay on recovery items are mouse-only; a
high-volume triage session (50+ failures) is click-heavy.
**Design.** When the recovery drawer/row is focused: `R` = replay,
`⌘/Ctrl+Enter` = resolve/approve, `J/K` = next/prev row. `<kbd>` hints on the
buttons; shortcuts inert while any input/textarea has focus; registered
through the existing shortcut plumbing and listed in the `?` overlay.
**AC.** Shortcuts fire the same callbacks as the buttons (component tests);
disabled during text input; overlay lists them; i18n EN/ES.

#### P-19 — Bulk-action progress + confirmation (M)
**Problem.** Bulk replay/resolve of N dead letters gives no progress feedback
(looks frozen) and no confirmation of blast radius.
**Design.** (a) Selecting ≥3 rows and clicking a bulk action opens the
existing confirm-dialog pattern with "Replay N entries? Estimated ~Ns" (count
+ time only; cost estimate out of scope). (b) During execution, a persistent
toast updates "Replaying k of N…" per settled promise (the client already
issues per-row calls), replaced by the final success/partial-failure toast.
**AC.** Dialog appears at ≥3 selections; progress toast counts up; partial
failures reported ("18 replayed, 2 failed"); tests for both.

#### P-20 — Downtime clock on open failures + "minutes recovered" (M) ★wedge — ✅ shipped ENG-272 (a+b) + ENG-275 (c)
**Problem.** MTTR is the north star, but the operator never *feels* time:
open failures don't show elapsed downtime, and resolving one gives no sense
of time saved.
**Design.** (a) Each open DLQ/recovery row shows a live elapsed-since-failure
chip (`3h 12m`, ticking each minute via one shared interval), amber >1 h, red
> SLA target when known. (b) On resolve/replay-success, the success toast
says "Recovered after 3h 14m"; (c) the value dashboard gains a cumulative
"automation downtime ended: X h this month" figure — computed from existing
`createdAt→resolvedAt` deltas already scanned by the metrics signals (no new
table).
**Files.** DLQ/recovery row components, toasts, `recoveryMetricsRepo.ts`
(one aggregate), i18n.
**DB.** None.
**AC.** Chip ticks without per-row timers (one interval, fake-timer test);
thresholds colorize; toast shows the delta; dashboard figure matches a
hand-computed fixture.

#### P-21 — Recovery heatmap calendar (M) ★wedge — ✅ shipped ENG-273 + ENG-276 (click-to-filter)
**Problem.** No at-a-glance seasonal view of failure/recovery health; the
story "we used to fail a lot, now we recover fast" is invisible.
**Design.** New `GET /recovery/heatmap?days=90` → per-day
`{ day, failures, recovered, mttrSeconds }` (single GROUP BY over
`dead_letters`/runs within the window, capped 90 rows). Render a GitHub-style
contribution grid on the Recovery Center (pure CSS grid of `<button>` cells,
color by outcome: gray none, green recovered-fast, amber slow, red
unresolved); click a day → filters the recovery queue to that day (existing
filter plumbing). Keyboard-navigable cells (`aria-label` per day).
**Files.** new repo query + route, `RecoveryCenterPanel` sub-component, i18n,
`docs/api.md`.
**DB.** None (aggregate query; add index only if EXPLAIN demands — the
July-2 `dead_letters_org_created_idx` already covers the window scan).
**AC.** 90 cells max; day click filters the queue; colors match fixture
data; a11y labels per cell; SQL aggregates in one query (no JS loop over
rows-per-day queries).

#### P-22 — Weekly recovery digest (M) ★wedge
**Problem.** Nothing brings the operator back — the value Janusly created
this week (failures caught, MTTR trend, best save) is never pushed to them.
**Design.** Extend the existing alerts/report-delivery seam (no new cron:
ride the alerts-scanner daily tick, fire when `now` crosses the org's weekly
boundary) to send a digest via the existing `email.send` mailer: failures
count, MTTR vs last week, top failure cluster, biggest single save (longest
downtime ended). Opt-in via org-config `email.weeklyDigestEnabled` (boolean,
default false) + `email.weeklyDigestDay` (0–6, default 1). Template lives in
the P-10 `templates/reports.ts` module. Digest dedupe key
`digest:<orgId>:<isoWeek>` through the existing alert-dispatch dedupe table.
**Files.** alerts scanner, org-config catalog (2 keys), templates, docs.
**DB.** 2 org-config keys (no migration).
**AC.** Fires once per org-week (dedupe proven by double-tick test); respects
opt-in default-off; renders from a fixture snapshot; safe-email posture
honored (existing mailer chokepoint).

#### P-23 — Org pulse feed (M) ★wedge
**Problem.** Outside a single run's inspector, the product feels static —
there is no ambient sense that automations are alive and being protected.
**Design.** Publish lightweight org-level events (`run.started`,
`run.succeeded`, `run.failed`, `dlq.replayed`) onto one Redis channel per org
via the existing `publishRunEvent` hub (new channel name, same plumbing;
payloads already safe-persisted). New SSE route `GET /org/stream` (permission
`runs.read`, same per-org connection caps as the run stream). Web: a
collapsible "Pulse" ticker on the Recovery Center showing the last 20 events
with relative timestamps, fed by the existing `fetch`+`ReadableStream` SSE
consumer pattern (never `EventSource`).
**Files.** engine publish sites (guarded, fire-and-forget), run-stream hub,
new route, web ticker component, i18n.
**DB.** None.
**AC.** Events appear ≤2 s after a run transition in dev; ticker bounded at
20; org isolation asserted (event for org A never reaches org B's stream —
test mirrors the run-stream org re-check); collapse state persisted in
localStorage.

#### P-24 — Quick-copy error summary (S)
**Problem.** Escalating a failure to Slack/Linear means hand-copying from raw
error JSON.
**Design.** "Copy error" button on the recovery drawer/DLQ detail: writes
`workflow · node(type) · error message · timestamp · runId` one-liner via
`navigator.clipboard`, success toast. Fallback to a `<textarea>` select+copy
when the Clipboard API is unavailable.
**AC.** Copied string matches fixture; toast fires; fallback path unit-tested.

#### P-25 — Fuzzy matching in the command palette (S)
**Problem.** Palette workflow search is substring-only; 100+ workflows make
exact-name recall the bottleneck.
**Design.** Hand-written subsequence scorer (~40 lines, no dep): exact
substring ranks above fuzzy; fuzzy matches score by gap penalty; top 5 shown.
Applies to the palette's workflow + command lists.
**AC.** "rftx" matches "Refund triage Exploit"; exact beats fuzzy; case
insensitive; 5-case unit test.

#### P-26 — Readiness badge in the sidebar (S)
**Problem.** Workflow readiness state (the deterministic
`checkWorkflowReadiness` gates) is only visible inside AI Studio; operators
tab away and lose track of whether the current workflow is production-ready.
**Design.** Badge under the workflow name in `BuilderSidebar`: green "Ready" /
amber "N warnings" / red "N blockers", derived from the readiness issues
already fetched for the Studio badge (share state via the store; no new
endpoint). Click → navigates to the Studio readiness panel.
**AC.** Three states render from fixture issue lists; click navigates;
updates on save/validate; i18n EN/ES.

#### P-27 — Empty-state onboarding walkthrough on the Recovery Center (M) — ✅ shipped ENG-274 (fresh-trigger + dismiss) + ENG-277 (try-demo CTA)
**Problem.** A brand-new org sees an empty Recovery Center — the wedge is
invisible exactly when the first impression forms.
**Design.** When failures = approvals = runs = 0, render a 5-step CSS
diagram (run → failure → explain → patch → replay) with a CTA to install the
F3 demo pack (existing solution-packs install endpoint) so the user
experiences a real recovery in <2 minutes. Dismissible
(`localStorage janusly:recovery:hideIntro`); i18n EN/ES.
**AC.** Renders only in the triple-empty state; CTA installs the pack and
starts its sample run; dismiss persists; reduced-motion safe.

### 2D. Testability & DX

#### P-28 — Web↔route contract check (M) — ✅ shipped ENG-278
**Problem.** Nothing validates that the paths/methods the web calls exist in
the route registry — drift surfaces only in e2e (13 route files currently
have no tests at all).
**Design.** A pure test in `apps/api`: import the composed `routes` registry;
statically extract every `api(...)`/fetch path+method from
`apps/web/src` (regex over string literals — the api client uses literal
paths); assert every extracted (method, path-shape) matches a registered
route's matcher. Unmatchable dynamic paths get an explicit allowlist.
**AC.** Test fails when a web call targets an unregistered route (proven by
a fixture); allowlist starts empty or minimal; runs in `pnpm test`.

#### P-29 — Recovery-loop e2e journey (M) — ✅ shipped ENG-280 (sandbox gate + replay-accepted; replay-to-green pending a finding) ★critical
**Problem.** The product's core story — DLQ failure → suggest fix → sandbox
validate → apply → replay-to-green — has no end-to-end test; the F3 spec
stops at "landed in DLQ".
**Design.** Extend the Playwright suite: seed via `seed:recovery-matrix`,
drive the Recovery dialog through fallback-mode patch suggestion (no API key
needed — deterministic fallback envelope), sandbox validate, apply, replay,
assert the run terminates `succeeded` and the DLQ row resolves. Two variants:
accept-patch and reject-patch.
**AC.** New spec green in `pnpm test:e2e` in fallback mode ($0); journey
count grows by ≥2; failure of any loop stage fails the spec with a
screenshot artifact.

#### P-30 — Data-layer integration lane against real Postgres (L) — ✅ shipped ENG-279
**Problem.** Repo unit tests mock the query builder; SQL correctness (keyset
boundaries, window functions, tenant scoping, CAS conflicts) is "verified in
live smoke" per the repos' own comments — i.e., not gated.
**Design.** New file convention `packages/data/src/**/*.integration.test.ts`,
excluded from `pnpm test`, run by a new root script `pnpm test:integration`
that reuses the existing Compose lifecycle helper (same pattern as
`run-e2e.mjs`: compose up → `pnpm migrate` → vitest run → compose down). CI:
fold into the existing `test_e2e` job (Compose is already up there) as a step
before Playwright — no new job, no second Compose lifecycle. Initial scope:
15–20 tests covering keyset pagination cursors (runs, workflows trash, audit),
one CAS conflict (credentials rotation), org isolation on 3 hot repos, and
the P-09 HNSW index assertion.
**AC.** `pnpm test:integration` green locally from a fresh checkout; CI runs
it inside `test_e2e`; at least one test fails if org-scoping is removed from
a covered repo (mutation-tested once by hand during the ticket).

#### P-31 — Panel fixture factory (M)
**Problem.** 5 web panels (AuthPolicySettings, Inspector, Runs, Trash,
WorkflowSlo) have zero tests, largely because per-panel setup boilerplate
(store, auth, fetch mocks) is heavy.
**Design.** `apps/web/src/test/fixtures.ts`: `renderPanel(ui, { auth, store,
responses })` that pre-wires the store, a fetch mock keyed by URL pattern,
and i18n. Write the 5 missing panel smoke tests with it (render + primary
interaction + error state).
**AC.** All 5 panels have tests using the factory; per-test setup ≤5 lines;
existing tests untouched.

#### P-32 — Type-escape ratchet (S)
**Problem.** 23 `as any`/`as unknown as` casts in non-test src, legitimate
but undocumented and unguarded — the count can only silently grow.
**Design.** `scripts/check-type-escapes.mjs` (mirrors the evals-baseline
pattern; zero deps): counts escape occurrences per package in src (excluding
tests), compares against `scripts/type-escapes-baseline.json`, fails if any
package exceeds its floor, prints instructions to lower (never raise) the
baseline. Wire into `build_test` CI job. Document each existing escape with
a one-line comment stating why the cast is safe.
**AC.** Script green at current counts; adding an undocumented `as any`
fails CI; lowering counts allows updating the baseline via
`--update-baseline`.

#### P-33 — Fast single-package test loop docs + scripts (S)
**Problem.** The obvious dev loop (`pnpm test`) runs the whole workspace;
watch mode per package exists but is undocumented.
**Design.** Root scripts `test:api`, `test:web`, `test:engine`, `test:data`
(each `pnpm --filter <pkg> test -- --watch` capable); a "Testing loops"
subsection in README Testing table documenting them + the browser/e2e/evals
lanes.
**AC.** Scripts work; README updated; no CI change.

#### P-34 — Playwright flake visibility (S)
**Problem.** E2E failures don't distinguish flake from regression; no retry
policy or trend visibility.
**Design.** Set `retries: 2` in CI only (config reads `process.env.CI`),
upload the Playwright JSON report + traces-on-retry as workflow artifacts,
and print a "flaky (passed on retry): N" summary line in the job.
**AC.** A test that fails once then passes is reported flaky, not red; report
artifact downloadable; local runs keep `retries: 0`.

#### P-35 — Panel seed script (S)
**Problem.** Manually populating non-demo panels (Runs history, Trash, SLO,
alerts, audit) for UI work requires clicking through the app.
**Design.** `pnpm seed:panels` (idempotent, extends the existing seeder
family): 20 workflows across folders/tags, 2 trashed, 30 runs mixed-status,
5 recovery items in different states, 3 alert policies, SLO targets on 2
workflows.
**AC.** Fresh `pnpm dev` + `pnpm seed:panels` shows non-empty states on
every main panel; running twice doesn't duplicate.

---

## 3. DB / schema change summary

Deliberately minimal — the audit found the schema fundamentally sound:

| Change | Proposal | Migration |
| --- | --- | --- |
| Index `audit_logs (org_id, action varchar_pattern_ops, created_at DESC)` | P-03 | Two-file hot-path pattern (+ `production-rollout.sql`) |
| Org-config keys: `retention.scimProcessedEventsDays`, `email.weeklyDigestEnabled`, `email.weeklyDigestDay` | P-06, P-22 | None (catalog entries) |
| **Deferred**: `recovery_metrics_daily` rollup table | noted in P-05 | Only when P-05's cache stops being enough (≈500 orgs / 2M runs-window); design lives in the perf audit notes |

Everything else in §2 is code-only. No FK changes, no backfills.

---

## 4. What was checked and found healthy (no ticket needed)

- Org-scoping: 100% of the 50 data repos filter `eq(orgId, …)`; no bypass
  helper exists.
- Dependency hygiene: zero unused deps, zero cross-package version skew.
- Route dispatcher: ~110 routes, no shadowing, no framework strain.
- Cron sweeps: retention/reaper/calibration/alerts all batched and indexed
  (post July-2).
- i18n: parity-tested EN/ES, no hardcoded UI strings found (one cosmetic
  `orgId ?? 'default'` breadcrumb literal).
- A11y: dialogs trap focus, live regions announced, icons aria-hidden.
- Zero TODO/FIXME/HACK markers in production source.

---

## 5. Suggested sequencing (second iteration)

Order chosen so each batch is independently shippable and the wedge items
land early enough to compound:

1. ~~**Perf quick wins (½–1 day each):** P-01 gzip → P-02 org-config cache →
   P-03 audit index → P-05 metrics micro-cache.~~ **✅ Shipped 2026-07-06 as
   ENG-267..270.** Measurable wins, zero product risk.
2. **Wedge UX (the reason-for-being amplifiers):** P-20 downtime clock →
   P-16 animated counters → P-17 MTTR sparkline → P-21 heatmap → P-27
   empty-state onboarding. After these, the Recovery Center *tells the MTTR
   story* instead of listing numbers.
3. **Trust the loop:** P-29 recovery-loop e2e (protects everything batch 2
   sells) → P-28 contract check → P-30 integration lane (+P-09 inside it).
4. **Triage ergonomics:** P-18 keyboard triage → P-19 bulk progress →
   P-24 copy error → P-25 fuzzy palette → P-26 readiness badge.
5. **Retention & pull:** P-22 weekly digest → P-23 org pulse feed.
6. **Hygiene (parallelizable anytime):** P-10 templates split → P-11 CAS
   helper → P-12 error envelopes → P-13/P-14 extractions → P-15 docs →
   P-06/P-07/P-08 remaining perf → P-31..P-35 DX.

Promotion protocol: one proposal → one `ENG-NNN` row (next free: **ENG-267**)
in ROADMAP §3b with the AC copied from here, then `janus-ship`.
