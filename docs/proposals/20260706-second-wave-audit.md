# Second-wave audit — 2026-07-06 (post PR #16) · expanded implementation edition

A full re-assessment of the project after the world-class-audit batches
(ENG-267..283) merged to `main`, plus — in this expanded edition — a
**verified implementation spec** per proposal so the next iteration can
execute without re-investigation, ambiguity, or hallucinated APIs.

**Method.** Five parallel audit passes (api/data/db, engine/recovery, web
UX, AI/memory, testing/deps) → verification pass (every load-bearing claim
re-checked against code; refuted claims listed below) → four **fact-extraction
passes** that quoted the exact signatures, types, columns, i18n keys, and
line numbers each spec builds on. Everything in a `Spec` block below cites
code that was read this session; anything uncertain is marked as an explicit
verification step inside the acceptance criteria, never asserted.

**Relationship to previous docs:** complements, never duplicates.
`20260702-deep-review.md` §3 and `20260706-world-class-audit.md` §2 keep
their unshipped proposals; §4 below refines five of those with new evidence.

**Baseline:** `main` clean at `bcccbb5`. Unit lane **3,688 tests / 304
files** (api 1,095 · engine 956 · web 730 · data 364 · shared 363 · ai 152 ·
domain 24 · db 4) + integration lane 12 + browser lane + Playwright e2e +
Python SDK pytest. Next free ticket id **ENG-284**.

**Refuted during verification (kept for the record — do NOT implement):**
- Validation replay does NOT leak stale downstream context — non-ancestor
  nodes are seeded `status: "pending"` with empty state
  (`dlq-replay.ts` validation tx, `canCopyContext` requires
  `ancestorNodeIds.has(node.id)`).
- The stalled-node reaper has NO multi-worker thundering herd —
  `upsertJobScheduler(STALLED_NODE_REAPER_JOB_ID, …)` is deduped by job id
  in Redis: one scheduler exists regardless of replica count, each tick is
  one job consumed by one worker. No jitter needed.
- `bumpPlatformVersion` is ALREADY debounced — `store.ts:463-471` coalesces
  bumps on a 100 ms trailing edge (`BUMP_COALESCE_MS`). The remaining cost
  is the fan-out per bump, not bump bursts (see Q-17).
- CI pnpm-store caching already exists (`cache: pnpm` on setup-node);
  `sdk-node` already has devDependencies + engines; heatmap cells are real
  `<button>`s (Tab + Enter native — only roving tabindex missing, Q-20).

---

## 1. State of the project — per-axis scorecard (v2, with deltas)

| Axis | v1 → v2 | Evidence (verified) |
| --- | --- | --- |
| **Functionality** | Strong → **Strong, one dent** | Recovery loop genuinely replays-to-green (ENG-281). Dent: `config.timeoutMs` is declared, diff-tagged `timeout`, and **never enforced** — `core/timeout.ts`'s docstring claims `runtime.ts` uses it; zero references exist (Q-01). |
| **Usability** | Good → **Good+** | Day drill-in, walkthrough, demo CTA shipped. Remaining friction: one platform bump still fans out 4+ parallel refetches (Q-17). |
| **UX polish / delight** | Fair → **Good, ceiling visible** | Downtime clock, sparkline, heatmap, counters landed. The biggest recovery moment (cluster-apply) is the quietest — `{ replayed, failed, errors }` and a dry ribbon (Q-13). No streaks, no hero downtime, no all-clear celebration (Q-14/15/38). |
| **Innovation / originality** | Strong wedge, under-expressed → **Strong, flywheel next** | UI shows the story; the model doesn't learn it: calibration is global per approach (`confidence_calibrations` unique on `(org, approach)` only), exemplars ignore outcomes (Q-24/25). |
| **Performance** | Good → **Good** | gzip + 3 caches shipped. Next: DLQ list detoasts unbounded jsonbs per row (Q-10), no `statement_timeout` (client options today: `{ onnotice }` only — Q-03), CORS re-parses env per response (Q-12). |
| **Architecture** | Excellent → **Excellent, one seam** | Three process-local caches with no cross-replica invalidation — TTL doing correctness work it was meant to bound (Q-08). |
| **Scalability** | Good to ~100 orgs → **path clear** | Q-08 invalidation bus, Q-13 BRIN groundwork (Q-12), retention covered by refined P-07. |
| **Testability** | Strong pyramid → **breadth gaps named** | 5 data repos with zero direct tests; ~40 status-only route assertions (Q-32/33). |
| **Simplicity** | Good → **Good** | `http-policy.ts` (835 lines) mixes SSRF pinning and bounds (Q-34); three duration formatters disagree visually (Q-18). |
| **Maintainability** | Excellent → **minus one zero** | No linter/formatter anywhere in ~175k LOC (Q-31). |
| **Libraries** | Excellent → **one stale pin + one gap** | Drizzle RC commit-hash pins (Q-37); `engines` missing on all 8 core workspaces while both SDKs have it (Q-36). |

**North-star check:** v1's gap (dramatizing MTTR) is largely closed. This
pass closes two new ones: **platform trust** (the recovery product must be
more reliable than the workflows it recovers — Q-01/02/03) and **the
learning flywheel** (measure → learn per failure class — Q-24/25) — plus a
**love layer** (§2C-love) so operators don't just trust the product, they
feel it fighting for them.

---

## 2.0 Implementation contract conventions (read once, reuse everywhere)

Verified reference patterns every spec below builds on. Copy these shapes;
do not invent parallel ones.

- **Org-config key** (`packages/data/src/orgConfigCatalog.ts`): one entry in
  the closed catalog, e.g. the verified number entry
  `{ key: "ai.rateLimitPerMin", category: "ai", description, valueType:
  "number", defaultValue: 30, envKeys: ["AI_RATE_LIMIT_PER_MIN"], min: 1 }`
  — optional `fractional: true`, `allowEmpty: true`, `validate: fn`.
- **Audit action** (`apps/api/src/audit-helper.ts`): add one union member to
  `AuditAction` (closed union of snake/dot strings, grouped by comment) and
  call `auditAction(auth, action, { targetType?, targetId?, metadata? })`.
  System-actor writers use the lower-level
  `audit(orgId, "system:<name>", action, targetType, targetId, metadata)` —
  verified example at `auto-healing-watcher.ts:303-307`.
- **Error code** (`apps/api/src/error-codes.ts`): add one member to the
  `ApiErrorCode` union (snake_case), use via
  `sendError(res, code, message, status)`.
- **i18n** (`apps/web/src/i18n/locales/{en,es}/common.json`): flat
  dot-path keys; plurals via `_one` / `_other` suffixes (verified:
  `recoveryCenter.hero.recoveryTitle_one`). Components consume via
  `const { t } = useT()`. EN/ES parity is gated; Spanish copy must follow
  the no-Spanglish rule.
- **Toasts** (`apps/web/src/store.ts`): `addToast(message, tone?)` with
  `tone: 'success' | 'error' | 'info'`; store is `useWorkflowStore`.
- **Metric gauge** (`packages/engine/src/observability/metrics.ts`):
  `const meter = metrics.getMeter("janusly")` + `meter.createHistogram` /
  `createCounter` with `{ description }` — new gauges follow the same file
  and naming (`workflow_*` prefix).
- **Two-file migration** (hot-path index/column): `migration.sql` with
  `IF NOT EXISTS` (runs in drizzle-kit's tx) + sibling
  `production-rollout.sql` with `CONCURRENTLY` variants for ops.
- **Integration test**: `*.integration.test.ts` under
  `packages/data/src/integration/` or `apps/api/src/integration/`, unique
  org id per run (`` `it-<area>-${Date.now()}-${process.pid}` ``), cleanup in
  `afterAll`, run via `pnpm test:integration`.
- **Browser test**: copy the skeleton of
  `VitalSignsStrip.browser.test.tsx` (Testing Library `render`/`screen`
  against real Chromium; accessible-name assertions).

---

## 2A. Correctness & resilience — the platform must out-reliable the workflows it recovers

#### Q-01 — Enforce `config.timeoutMs` at the executor chokepoint (S) ★ critical

**Problem.** `core/timeout.ts` exports `withTimeout` + `getNodeTimeoutMs` +
`NodeTimeoutError` and its docstring claims runtime use — verified false.
`execute-node.ts:83` awaits the executor unwrapped; the only enforcement
anywhere is a *private duplicate* `withTimeout(promise, timeoutMs, label)`
at `node-registry.ts:115-124` (agent tool calls only, rejects with a plain
`Error`). An executor without internal timeouts hangs the worker until the
stalled-node reaper.

**Spec (verified).**
1. Extend the core helper with the label the agent loop needs
   (`packages/engine/src/core/timeout.ts`):
   ```ts
   export async function withTimeout<T>(
     promise: Promise<T>,
     timeoutMs?: number,
     label?: string,          // NEW — used in the error message when set
   ): Promise<T>
   ```
   `NodeTimeoutError` message becomes
   `` `${label ?? "Node"} timed out after ${timeoutMs}ms` `` (keep
   `code = "NODE_TIMEOUT"` and `readonly timeoutMs`). Fix the stale
   docstring to name the two real consumers.
2. Wrap the dispatch in `packages/engine/src/execute-node.ts` (inside the
   existing try, line 83):
   ```ts
   result = await withTimeout(
     executor({ runId, nodeId: node.id, orgId, workflowId,
                config: parsedConfig, context, redactedValues, dryRun }),
     getNodeTimeoutMs(node),
   );
   ```
   Imports: add `withTimeout, getNodeTimeoutMs` from `./core/timeout`.
   `NodeTimeoutError` rides the existing `catch (err) { throw
   redactError(err, redactedValues) }` → normal failure path → retry policy
   → DLQ. No default timeout when `timeoutMs` unset (`withTimeout` returns
   the promise unchanged — behavior-preserving).
3. Delete the private duplicate at `node-registry.ts:115-124`; its call
   site (line 288) switches to the core import with the same label arg
   `` `${agentConfig.name ?? "agent"}.${plan.tool}` ``. Note: the agent
   loop's error type changes from plain `Error` to `NodeTimeoutError` —
   update any test asserting the message shape (message text is preserved).

**Files.** `packages/engine/src/execute-node.ts`,
`packages/engine/src/core/timeout.ts`,
`packages/engine/src/node-registry.ts`, existing timeout tests. **DB.** None.
**AC.** (a) Node with `config.timeoutMs: 1000` + an executor stub sleeping
5s → fails in ~1s with an error whose message contains `timed out after
1000ms`, lands in DLQ, replayable. (b) Node without `timeoutMs` →
byte-for-byte today's behavior. (c) Agent tool timeout test still passes
with the label-bearing message. (d) Docstring names `execute-node.ts` +
`runAgentLoop` as the consumers.

#### Q-02 — Atomic replay transition + mid-retry guard (S/M)

**Problem.** `dlq-replay.ts:100-103` runs three separate awaits:
`resetRunForReplay(runId)` (verified: `UPDATE runs SET status='running'
WHERE id=$1 AND status='failed'`) → `markNodeQueued` (verified:
unconditional on node status) → `enqueueNode`. A cancel landing between
them leaves a `queued` node on a `cancelled` run — the runtime guard skips
it forever while the operator believes the replay started. Separately,
`/dlq/replay` accepts a node currently `queued` mid-engine-retry.

**Spec (verified).**
1. New `claimReplayTransition` in `packages/engine/src/persistence.ts`,
   replacing the two calls inside `replayDeadLetter`:
   ```ts
   export async function claimReplayTransition(
     runId: string, nodeId: string,
   ): Promise<{ ok: true } | { ok: false; reason: "run_not_replayable" | "node_mid_retry" }> {
     return db.transaction(async (tx) => {
       await tx.update(runs).set({ status: "running" })
         .where(and(eq(runs.id, runId), eq(runs.status, "failed")));
       const run = await tx.select({ status: runs.status })
         .from(runs).where(eq(runs.id, runId)).limit(1);
       if (run[0]?.status !== "running") return { ok: false, reason: "run_not_replayable" };
       const node = await tx.select({ status: runNodes.status })
         .from(runNodes)
         .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, nodeId))).limit(1);
       if (node[0]?.status === "queued") return { ok: false, reason: "node_mid_retry" };
       await tx.update(runNodes).set({ status: "queued", attempts: 1 })
         .where(and(eq(runNodes.runId, runId), eq(runNodes.nodeId, nodeId)));
       return { ok: true };
     });
   }
   ```
   `resetRunForReplay` stays exported (other callers unaffected).
2. `dlq-replay.ts` `replayDeadLetter`: call `claimReplayTransition`; on
   `ok: false` throw a typed error the route maps. `enqueueNode` stays
   AFTER the tx commits (queue write is not transactional with Postgres —
   an enqueue after a committed claim is safe; the claimed `queued` node is
   exactly what `markNodeRunning` expects).
3. Route mapping (`apps/api/src/routes/dlq-routes.ts` `/dlq/replay`):
   `run_not_replayable` → 409 `replay_conflict`; `node_mid_retry` → 409
   `node_mid_retry`. Add both to the `ApiErrorCode` union + EN/ES messages.

**Files.** `persistence.ts`, `adapters/dlq-replay.ts`, `dlq-routes.ts`,
`error-codes.ts`, i18n. **DB.** None.
**AC.** Integration test: cancel racing replay never yields a `queued` node
on a non-running run (assert node status after both orderings); replay of a
`queued` node → 409 `node_mid_retry`; happy-path replay regression e2e
(ENG-280 spec) stays green.

#### Q-03 — Postgres statement timeout + pool bounds (S)

**Problem.** Verified: `packages/db/src/index.ts:49-51` creates the client
with only `{ onnotice: () => undefined }` — no statement timeout, no
connect timeout, no documented pool max, on every replica.

**Spec (verified).**
```ts
// packages/db/src/index.ts — postgres-js passes `connection.*` to the
// server as session GUCs; numeric envs validated with Number.isFinite.
export const client = postgres(connectionString, {
  onnotice: () => undefined,
  max: envInt("JANUSLY_DB_POOL_MAX", 10),
  connect_timeout: envInt("JANUSLY_DB_CONNECT_TIMEOUT_S", 10),   // seconds (postgres-js unit)
  connection: {
    statement_timeout: envInt("JANUSLY_DB_STATEMENT_TIMEOUT_MS", 30_000), // ms (Postgres unit)
  },
});
```
Long-running writers override per-transaction with
`SET LOCAL statement_timeout` inside their existing tx — apply to the
retention sweep's purge transactions (the sweep files under
`packages/engine/src/` registered by the retention scheduler; list the
exact call sites in the PR). Document the three envs in
`docs/configuration.md`.

**Files.** `packages/db/src/index.ts`, retention sweep call sites,
`docs/configuration.md`. **DB.** None (session settings).
**AC.** Integration test: `SELECT pg_sleep(60)` through the client fails at
~30s with the Postgres 57014 error; a seeded 50k-row retention purge still
completes (its `SET LOCAL` override proven); all lanes green.

#### Q-04 — Schedule tick dedup table (M)

**Problem.** Verified: `schedule-scheduler.ts:263-268` documents that BullMQ
can emit duplicate ticks (broker reconnect / clock skew), each spawning a
run; the "future tightening" named there — a unique constraint on
`(scheduleEntryId, triggeredAtMinute)` — is exactly this proposal.

**Spec (verified).**
1. Schema (`packages/db/src/schema.ts`), plain migration:
   ```ts
   export const scheduleTicks = pgTable("schedule_ticks", {
     id: text("id").primaryKey(),
     orgId: text("org_id").notNull(),
     scheduleEntryId: text("schedule_entry_id").notNull(),
     triggeredAtMinute: timestamp("triggered_at_minute", { withTimezone: true }).notNull(),
     runId: text("run_id"),
     createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
   }, (t) => [
     uniqueIndex("schedule_ticks_entry_minute_idx").on(t.scheduleEntryId, t.triggeredAtMinute),
   ]);
   ```
2. In `handleScheduleTrigger` (before the verified `startRun` call at
   ~line 310): compute `triggeredAtMinute = new Date(Math.floor(Date.now()
   / 60_000) * 60_000)`; then
   ```ts
   const claimed = await db.insert(scheduleTicks)
     .values({ id: crypto.randomUUID(), orgId: entry.orgId,
               scheduleEntryId: entry.id, triggeredAtMinute })
     .onConflictDoNothing()
     .returning({ id: scheduleTicks.id });
   if (claimed.length === 0) { /* duplicate tick */ return; }
   ```
   After `startRun` resolves, best-effort `UPDATE schedule_ticks SET
   run_id = $runId WHERE id = $claimedId` (non-fatal on error).
3. Retention: add a purge of `schedule_ticks` older than 7 days to the
   existing `system:retention` sweep (same batched-delete pattern).

**Files.** `schema.ts` + migration, `schedule-scheduler.ts`, retention
sweep, tests. **DB.** New table + unique index.
**AC.** Integration test: two `handleScheduleTrigger` calls with the same
entry + frozen minute → exactly one run row; different minutes → two runs;
purge removes >7d rows; scheduler unit tests green.

#### Q-05 — Upstream-health poller backoff, DB-backed (M)

**Problem.** Verified: the poller is ONE Redis-scheduled job per tick (any
worker consumes it) that fetches every enabled source each minute with no
backoff — a permanently-down status page is re-fetched forever at full
cadence. (The original "reaper jitter" companion finding was refuted —
see header.) Because the tick can run on ANY worker, backoff state must
live in the data layer, not process memory.

**Spec (verified).** The poller already persists per-source outcomes via
`recordUpstreamStatus` / `recordUpstreamPollError`. Add to the source row
(or its status row — pick the table those two functions write; verify the
exact table name in the repo before the migration, it is the one gap this
spec leaves): `consecutive_failures integer NOT NULL DEFAULT 0` and
`next_poll_at timestamptz NULL`. In the tick loop, skip sources with
`next_poll_at > now()`; on failure set `consecutive_failures += 1,
next_poll_at = now() + LEAST(interval '5 min' * 2^consecutive_failures,
interval '1 hour')`; on success reset both. Emit one
`upstream_health.backoff` audit (system-actor `audit()`) when a source
first enters backoff (transition 0→1 only).

**Files.** upstream-health repo in `packages/data`, 
`packages/engine/src/upstream-health-poller.ts`, schema + plain migration,
`audit-helper.ts` (action union). **DB.** 2 columns on the upstream-health
table.
**AC.** Fake-timer unit test: failing source fetch count follows 5m → 10m →
20m … capped 1h; success resets; audit fires exactly once per backoff
entry; healthy sources unaffected.

#### Q-06 — Queue depth + latency gauges (M) ★

**Problem.** Queue backlog — the earliest signal that recovery throughput
is degrading — is invisible: `observability/metrics.ts` records only node
duration/failures; `workflowQueue` (verified export, `queue.ts:48-50`) has
`getJobCounts()` unused.

**Spec (verified).**
1. `packages/engine/src/observability/metrics.ts` — follow the verified
   meter pattern:
   ```ts
   const queueWaiting = meter.createObservableGauge("workflow_queue_waiting_jobs",
     { description: "Jobs waiting in the workflow queue" });
   const queueActive = meter.createObservableGauge("workflow_queue_active_jobs",
     { description: "Jobs currently being processed" });
   export function registerQueueObservables(getCounts: () => Promise<{ waiting: number; active: number }>) {
     meter.addBatchObservableCallback(async (result) => {
       try { const c = await getCounts();
         result.observe(queueWaiting, c.waiting); result.observe(queueActive, c.active);
       } catch { /* never break metrics collection */ }
     }, [queueWaiting, queueActive]);
   }
   ```
   Worker boot (`worker.ts`) wires
   `registerQueueObservables(async () => { const c = await
   workflowQueue.getJobCounts("waiting", "active"); return { waiting:
   c.waiting ?? 0, active: c.active ?? 0 }; })`.
2. API surface: extend the open `GET /health` payload with a public-safe
   `queue: { waiting: number, oldestWaitingSeconds: number | null }` block,
   computed on request via the same `getJobCounts` + oldest waiting job
   timestamp (`workflowQueue.getJobs(["waiting"], 0, 0)` → `job.timestamp`),
   guarded by a 5s in-process cache (copy the `metrics-cache.ts` entry
   pattern) and try/caught to `null` (health must never fail on Redis).
3. Web: `QueueLagChip` beside the existing `RateLimiterStatusChip` in
   `OperationsPage` header (same 20s poll of `/health` — reuse that fetch,
   don't add a second). Amber when `oldestWaitingSeconds >
   JANUSLY_QUEUE_LAG_WARN_SECONDS` (env read server-side, threshold shipped
   in the health payload as `warnSeconds`). i18n keys
   `operations.queueLag.*` EN/ES; copy pattern follows the rate-limiter
   chip ("Jobs still processing" tone, not alarm).

**Files.** `observability/metrics.ts`, `worker.ts`, health route,
`OperationsPage.tsx` + new chip component, i18n. **DB.** None.
**AC.** `/metrics` exposes both gauges (integration-lite: scrape once in a
unit test with a stubbed getCounts); `/health` carries the `queue` block
and degrades to `queue: null` with Redis stopped; chip renders neutral/amber
per threshold in a panel test.

#### Q-07 — Auto-healing gate decisions become auditable (M) ★

**Problem.** Verified in `apps/api/src/auto-healing-watcher.ts`: two deny
branches are fully silent — the auto-apply consent gate (lines 250-253,
`if (!autoApply.allowed) return;`) and the loop breaker (lines 263-270,
`if (attempts > snapshot.autoHealing.maxAttemptsPerSignature) return;`).
The other gates record a validation outcome but no operator-visible reason.
Operators assume auto-healing works while it's silently gated.

**Spec (verified).**
1. New `AuditAction` union member `"auto_healing.apply_gated"` (goes in the
   existing auto-healing group next to `"auto_healing.scan.triggered"`).
2. At both silent branches, before `return`, write (system-actor pattern
   verified at lines 303-307):
   ```ts
   await audit(row.orgId, "system:auto-healing", "auto_healing.apply_gated",
     "auto_healing_run", row.id, {
       reason: "auto_apply_disabled",       // or "loop_breaker"
       signature: row.signature,
       deadLetterId: row.deadLetterId,
       ...(reason === "loop_breaker" ? { attempts, cap: snapshot.autoHealing.maxAttemptsPerSignature } : {}),
     });
   ```
   Volume is bounded by the watcher's per-scan batch — no dedup needed
   (state the bound in the PR).
3. Web: in the Recovery Center auto-healing card, a count of gated applies
   in the window via the existing admin `GET /audit?action=auto_healing.apply_gated`
   (action-prefix filter + index already exist — verified
   `audit_logs_org_action_created_idx`). Line: "N auto-applies gated this
   week" linking to the filtered `AuditLogPanel` view. i18n EN/ES.

**Files.** `auto-healing-watcher.ts`, `audit-helper.ts`, recovery-center
card component, i18n. **DB.** None.
**AC.** Unit tests: each silent branch now writes exactly one audit row
with the right `reason`; existing watcher behavior (skips) unchanged; card
renders count from a stubbed audit response.

---

## 2B. Scale-out — from one replica to N without lying to operators

#### Q-08 — Redis cache-invalidation bus (M) ★ the scale-out unlock

**Problem.** Verified: `metrics-cache.ts` invalidates only in-process (call
sites `dlq.ts:444` + `dlq.ts:452`); `orgConfigRepo.ts` exports
`invalidateOrgConfigCache(orgId?)` (lines 202-205) but nothing calls it
cross-replica; `apps/api/src/redis.ts` exports one `redis` (ioredis)
singleton and NO pub/sub exists anywhere in apps/api. With ≥2 replicas an
operator's recovery action leaves other replicas serving stale metrics
until TTL.

**Spec (verified).**
1. New `apps/api/src/cache-invalidation-bus.ts`:
   ```ts
   import { redis } from "./redis";
   import { invalidateRecoveryMetricsCache } from "./metrics-cache";
   import { invalidateOrgConfigCache } from "@janusly/data";

   const CHANNEL = "janusly:cache:invalidate";
   type InvalidateMessage = { kind: "recovery-metrics" | "org-config"; orgId: string };

   export function publishCacheInvalidation(msg: InvalidateMessage): void {
     // fire-and-forget; a lost message degrades to the TTL ceiling
     void redis.publish(CHANNEL, JSON.stringify(msg)).catch(() => {});
   }

   let subscriber: ReturnType<typeof redis.duplicate> | null = null;
   export function startCacheInvalidationSubscriber(): void {
     if (subscriber) return;
     subscriber = redis.duplicate();          // ioredis: dedicated conn for subscribe mode
     subscriber.on("error", () => {});         // fail-open: TTL remains the ceiling
     void subscriber.subscribe(CHANNEL).catch(() => {});
     subscriber.on("message", (_ch, raw) => {
       try {
         const msg = JSON.parse(raw) as InvalidateMessage;
         if (msg.kind === "recovery-metrics") invalidateRecoveryMetricsCache(msg.orgId);
         else if (msg.kind === "org-config") invalidateOrgConfigCache(msg.orgId);
       } catch { /* ignore malformed */ }
     });
   }
   ```
2. Wire: `startCacheInvalidationSubscriber()` at API boot (`index.ts`,
   after redis init). Publish after each local invalidation: the two
   `dlq.ts` sites gain `publishCacheInvalidation({ kind:
   "recovery-metrics", orgId })`; the org-config upsert route handler (the
   one calling `upsertOrgConfig`) gains `publishCacheInvalidation({ kind:
   "org-config", orgId })`. `packages/data` stays untouched — the bus lives
   entirely in apps/api and calls data's already-exported invalidator.
3. Note in the file header: messages also arrive on the publishing replica
   (invalidate is idempotent — harmless double-clear).

**Files.** new bus file, `apps/api/src/index.ts`, `dlq.ts`, org-config
route. **DB.** None. **Envs.** None.
**AC.** Integration test (two API processes or two bus instances against
Compose Redis): invalidate published by A clears B's entry before TTL;
Redis stopped → both processes still serve within TTL and log nothing
fatal; unit test covers malformed-message tolerance.

#### Q-09 — LRU eviction for the org-config cache (S)

**Problem.** Verified FIFO at `orgConfigRepo.ts:193-199` (evicts
`keys().next().value` — insertion order): a hot org polled every 10s is
evicted by cold orgs arriving later.

**Spec (verified).** In `readOrgConfigCache` (lines 183-191), on hit,
re-insert to refresh recency:
```ts
const hit = ORG_CONFIG_CACHE.get(orgId);
if (!hit) return null;
if (hit.expiresAt <= Date.now()) { ORG_CONFIG_CACHE.delete(orgId); return null; }
ORG_CONFIG_CACHE.delete(orgId);          // LRU: move to the end
ORG_CONFIG_CACHE.set(orgId, hit);
return hit.entries;
```
Eviction code in `writeOrgConfigCache` unchanged (`keys().next()` now
yields the least-recently-used). Apply the same 4 lines to
`metrics-cache.ts`'s per-org map (`CACHE`, `MAX_ORGS = 500`).

**Files.** `orgConfigRepo.ts`, `metrics-cache.ts`, both cache test files.
**DB.** None. **AC.** Test per cache: fill to cap, READ entry #1, insert
one more → entry #2 evicted, #1 retained.

#### Q-10 — Generated columns for the DLQ queue list (M)

**Problem.** Verified projection at `dlq.ts` (`listRecoveryQueue`):
`nodeType: sql`…${deadLetters.nodeJson}->>'type'`` and `workflowName:
…${deadLetters.workflowJson}->>'name'`` — per-row detoast of jsonbs
persisted with `maxBytes: Infinity`.

**Spec (verified).**
1. Schema: add to the verified `dead_letters` column list
   ```ts
   nodeType: text("node_type").generatedAlwaysAs(sql`node_json->>'type'`),
   workflowName: text("workflow_name").generatedAlwaysAs(sql`workflow_json->>'name'`),
   ```
   Two-file migration: `migration.sql` plain
   `ALTER TABLE "dead_letters" ADD COLUMN IF NOT EXISTS "node_type" text
   GENERATED ALWAYS AS (node_json->>'type') STORED;` (+ workflow_name);
   `production-rollout.sql` documents that `ADD COLUMN … STORED` rewrites
   the table — run in a low-traffic window; dev/CI rewrite is instant.
2. `listRecoveryQueue` projection swaps the two `sql<…>` extractions for
   `deadLetters.nodeType` / `deadLetters.workflowName` — response shape
   unchanged (same field names).

**Files.** `schema.ts` + two-file migration, `dlq.ts`. **DB.** 2 generated
columns.
**AC.** Contract/route tests unchanged and green; integration test asserts
generated values equal the jsonb extraction for seeded rows (incl. NULL
name); PR includes before/after `EXPLAIN (ANALYZE, BUFFERS)` on a 1k-row
seeded org.

#### Q-11 — Hot-table index tuning pass, evidence-gated (S)

**Problem (verify-then-fix).** Suspects, with current shapes verified:
`memory_entries_org_retain_until_idx` is `(org_id, retain_until)`;
`usage_events` carries BOTH `(org_id, metric)` and `(org_id, metric,
created_at DESC)` (the former is a prefix of the latter — likely
redundant); `dead_letters` carries `(org_id, status, created_at DESC)` and
`(org_id, created_at DESC, id DESC)`.

**Spec.** For each: capture the real query from its repo, `EXPLAIN ANALYZE`
against a seeded integration DB, and only then: drop
`usage_events_org_metric_idx` if fully covered; extend the memory retention
index only if the sweep's ORDER BY needs it; leave `dead_letters` unless
plans prove redundancy. Deliver one migration (two-file for any change) +
an `explain-evidence` appendix in the PR. No blind changes.

**Files.** `schema.ts` + migration, integration evidence. **DB.** Index
adjustments only.
**AC.** Every change carries before/after EXPLAIN in the PR; index-presence
integration tests updated; no repo query regresses.

#### Q-12 — Micro-perf pass: memoize CORS origins + BRIN on run_events (S)

**Spec (verified).**
1. `apps/api/src/http.ts` — replace the per-call parse (verified lines
   92-94) with a module-scope memo:
   ```ts
   let allowedOriginsCache: string[] | null = null;
   function getAllowedOrigins() {
     if (allowedOriginsCache) return allowedOriginsCache;
     const configured = process.env.API_ALLOWED_ORIGINS ?? DEFAULT_ORIGINS;
     allowedOriginsCache = configured.split(",").map(o => o.trim()).filter(Boolean);
     return allowedOriginsCache;
   }
   ```
   Export a test-only `__resetAllowedOriginsCache()` (http.test.ts mutates
   the env between cases). Document restart-to-change in
   `docs/configuration.md`.
2. BRIN: `index("run_events_created_brin").using("brin",
   table.createdAt)` on `run_events` — two-file migration (`USING brin` in
   both; BRIN builds are cheap but keep the convention). Add one paragraph
   to `docs/architecture/platform-services.md` naming the partition
   trigger (~50M rows).

**Files.** `http.ts` + test, `schema.ts` + migration, architecture doc.
**DB.** 1 BRIN index.
**AC.** CORS tests green with the reset hook; BRIN present in the
integration index test; retention range scan uses it on seeded data
(EXPLAIN in PR).

---

## 2C. Wedge UX — dramatize the win at the exact moment it happens

#### Q-13 — Cluster recovery celebration (M) ★ the loudest silent moment

**Problem.** Verified: the dialog receives `clusterMembers?: string[]` (ids
only), POSTs `{ clusterSignature, deadLetterIds, suggestedWorkflow }`, and
the route answers `{ replayed, failed, errors }` (`dlq-routes.ts:430`).
The celebratory "Recovered after X" toast fires ONLY in single-DLQ mode
(verified `RecoveryDialog.tsx:415-426`, key
`recoveryDialog.recoveredAfter`).

**Spec (verified).**
1. Server: in the cluster-apply loop (rows are loaded per member before
   replay), accumulate
   `downtimeEndedMs += Date.now() - row.createdAt.getTime()` for each
   member that replays successfully; response becomes
   `sendJson(res, { replayed, failed: errors.length, errors, downtimeEndedMs })`
   — additive, contract test updated.
2. Web (`RecoveryDialog.tsx`, cluster success path): after
   `bumpPlatformVersion()`,
   ```ts
   if (result.replayed > 0 && Number.isFinite(result.downtimeEndedMs) && result.downtimeEndedMs > 0) {
     addToast(t('recoveryDialog.clusterRecovered', {
       count: result.replayed,
       duration: formatDowntime(result.downtimeEndedMs),
     }) as string, 'success')
   }
   ```
   Render the same line in the dialog success state under the existing
   replay ribbon.
3. i18n (EN/ES, plural suffixes):
   `recoveryDialog.clusterRecovered_one: "Recovered {{count}} failure · {{duration}} of downtime ended"`,
   `_other: "Recovered {{count}} cascading failures · {{duration}} of downtime ended"`;
   ES: `"Recuperaste {{count}} fallo · terminaron {{duration}} de inactividad"` /
   `"Recuperaste {{count}} fallos en cascada · terminaron {{duration}} de inactividad"`.

**Files.** `dlq-routes.ts` (+ its test), `RecoveryDialog.tsx` (+ test),
i18n EN/ES. **DB.** None.
**AC.** Cluster-apply of ≥2 seeded members shows count + summed downtime in
toast and dialog; single-replay path untouched (existing test green);
`downtimeEndedMs` absent/0 → generic ribbon only (no NaN string); EN/ES
parity test green.

#### Q-14 — Green-streak callout (M) ★ the retention hook

**Problem.** `buildHeatmapCells` (verified: returns `HeatmapCell[] = { day,
failures, recovered, outcome }`, densified oldest→newest) computes per-day
outcomes for 90 days; nothing celebrates consecutive clean days.

**Spec (verified).**
1. `recovery-center/helpers.ts`:
   ```ts
   export type StreakSummary = { current: number; longest: number };
   export function computeStreaks(cells: HeatmapCell[]): StreakSummary
   ```
   A day is CLEAN when `failures === 0 || failures === recovered`
   (recovered-only days count — recovery IS the win). `current` counts
   backward from the newest cell, breaking on the first non-clean day;
   `longest` is the max run over the window.
2. `RecoveryCenterPanel` computes `computeStreaks(buildHeatmapCells(heatmap,
   90, nowMs))` (cells are already built for the heatmap — reuse, don't
   rebuild) and passes `streak` to the hero.
3. `RecoveryCenterHero` (verified props) gains `streak?: StreakSummary`;
   renders under the subline when `streak.current >= 3`:
   a small inline SVG flame (stroke `var(--we-success)`, no emoji in code)
   + `t('recoveryCenter.hero.streak', { count: streak.current })`, with
   `title={t('recoveryCenter.hero.streakLongest', { count: streak.longest })}`.
4. i18n: `recoveryCenter.hero.streak_one/_other`:
   "{{count}}-day clean streak" / EN; ES "Racha limpia de {{count}} día(s)"
   via `_one`/`_other` (natural Spanish, no Spanglish).

**Files.** helpers + tests, `RecoveryCenterPanel.tsx`,
`RecoveryCenterHero.tsx`, i18n. **DB.** None.
**AC.** Streak math unit-tested: today-failure → current 0; recovered-only
day counts clean; gap resets; renders at ≥3, hidden below; EN/ES green.

#### Q-15 — Hero "longest open downtime" headline (S) ★

**Problem.** The ticking clock lives only on DLQ rows; the hero
(verified props: `salutation, subline, healthScore, openFailures,
onOpenQueue`) says "N runs need recovery" with no visceral *how long*.

**Spec (verified).** `RecoveryCenterPanel` computes
`longestOpenMs = max(nowMs - new Date(dl.createdAt).getTime())` over
`openDeadLetters` (both already in scope; `nowMs` ticks via the verified
60s interval at lines 166-170 — no new timer). Hero gains
`longestOpenMs?: number | null`; in `actionMode` renders a secondary line
`t('recoveryCenter.hero.longestDowntime', { duration: formatDowntime(longestOpenMs) })`
with `data-severity={downtimeSeverity(oldestIso, nowMs)}` reusing the
verified severity thresholds (60m warn / 240m danger) and the existing
`.we-list-row__downtime` color tokens. i18n EN "Longest downtime:
{{duration}} — and counting" / ES "Inactividad más larga: {{duration}} — y
sigue".

**Files.** `RecoveryCenterPanel.tsx`, `RecoveryCenterHero.tsx`, helpers
(one max function), i18n. **DB.** None.
**AC.** Renders only when `openFailures > 0`; severity color matches the
DLQ chip of the same oldest item (browser test); no extra interval created.

#### Q-16 — Optimistic replay state on DLQ rows (M)

**Problem.** Verified `App.tsx:620-633`: the callback awaits `api()` +
`loadStatus` + `refreshPlatform` before any visual change; on slow networks
the row shows "open" for seconds after the click. `DeadLettersPanelProps`
is `{ onRefresh, onReplay, onResolve }`.

**Spec (verified).**
1. `App.tsx`: `const [replayingIds, setReplayingIds] = useState<ReadonlySet<string>>(new Set())`;
   in `replayDeadLetter`, add the id before the `await api(...)` and remove
   it in a `finally`. Pass `replayingIds` into `<DeadLettersPanel …>`.
2. `DeadLettersPanel`: prop `replayingIds?: ReadonlySet<string>`; a row
   whose id is in the set renders the meta chip
   `t('dlq.recovering')` with the existing `we-spin` spinner class,
   `data-testid={'dlq-recovering-' + item.id}`, and disables its
   replay/resolve buttons (`disabled` + `aria-disabled`).
3. i18n: `dlq.recovering`: EN "Recovering…" / ES "Recuperando…".

**Files.** `App.tsx`, `DeadLettersPanel.tsx` + test, i18n. **DB.** None.
**AC.** With a never-resolving mocked fetch the row flips to "Recovering…"
in the same frame as the click and the button is disabled (no
double-replay); state clears on success AND on error (error toast shown);
resolve path unaffected.

#### Q-17 — Coalesce the per-bump fan-out (M) — corrected scope

**Problem (corrected by verification).** Bump BURSTS are already coalesced
(store debounce, 100 ms). The remaining cost: one bump still triggers 3
independent effects in `RecoveryCenterPanel` (metrics / clusters / heatmap
— verified deps `[platformVersion, …]` at lines 108-152) plus
OperationsPage fetches — 4+ parallel requests and staggered spinner churn.

**Spec (verified).** Merge the three panel effects into ONE effect on
`[platformVersion, i18n.language]` that fires the three `api()` calls via
`Promise.allSettled`, applies metrics state immediately, and wraps the
non-critical updates in `React.startTransition(() => { setClusters(…);
setHeatmap(…) })` so the queue + metric tiles stay responsive. Keep each
fetch's error handling identical (verified fallbacks: clusters → null,
heatmap → []). Do NOT add new endpoints (P-04, the bootstrap consolidation,
remains the server-side complement).

**Files.** `RecoveryCenterPanel.tsx` (+ its test). **DB.** None.
**AC.** One bump → exactly 3 requests, issued together (assert fetch-mock
call batching); existing loading/error states per section unchanged; panel
tests green.

#### Q-18 — One duration formatter (S)

**Problem.** Verified three: `formatDurationHm` (module-local in
`ValueDashboardSection.tsx:58-65`), `formatDowntime` + `humanizeAge`
(helpers). Same ms renders differently across toast, chip, dashboard.

**Spec.** Single source in `recovery-center/helpers.ts`:
`export function formatDuration(ms: number, style: 'clock' | 'age' = 'clock'): string`
— `'clock'` = current `formatDowntime` output; `'age'` = current
`humanizeAge` wording (i18n-aware). `formatDowntime` becomes a one-line
wrapper (kept, deprecated JSDoc); `ValueDashboardSection` deletes its local
`formatDurationHm` and imports the shared one; `humanizeAge` stays (it
takes an ISO + now, different contract) but delegates its formatting core.
One assertion table in helpers test drives all styles.

**Files.** helpers + test, `ValueDashboardSection.tsx`. **DB.** None.
**AC.** For a fixture list of ms values, toast/chip/dashboard strings are
mutually consistent; EN/ES outputs asserted.

#### Q-19 — Recovery moment on the plain-replay path (S) ★

**Problem.** Verified: the dialog celebrates
(`recoveryDialog.recoveredAfter`), but `App.tsx`'s `replayDeadLetter` shows
generic `toasts.deadLetterReplayed`. The panel calls `onReplay(item.id)` —
`createdAt` is available on the row.

**Spec (verified).** Widen the prop:
`onReplay: (id: string, createdAtIso?: string) => void`; panel passes
`item.createdAt`. In `App.tsx`, after success, compute `downtimeMs` exactly
like the dialog (guarded `Number.isFinite(downtimeMs) && downtimeMs > 0`)
and fire the SAME key `recoveryDialog.recoveredAfter` with
`formatDowntime`; fall back to `toasts.deadLetterReplayed` when no
`createdAtIso`.

**Files.** `App.tsx`, `DeadLettersPanel.tsx`, tests. **DB.** None.
**AC.** Direct replay of an item open 2h shows "Recovered after 2h …";
shared key asserted in both dialog and panel tests; missing createdAt →
generic toast.

#### Q-20 — Chart interactivity: sparkline drill-in + heatmap roving tabindex (M)

**Spec (verified).**
1. Sparkline (`VitalSignsStrip.tsx`, current verified props
   `{ points, ariaLabel, title }` + decorative aria handling): add
   `onSelectPoint?: (index: number) => void`; when set, render an invisible
   `<rect>` hit target per point (width = stepX) with
   `role="button"`/`tabIndex=0`/Enter+click handling. In
   `RecoveryCenterPanel`, MTTR tile passes
   `onSelectPoint={(i) => { const day = metrics.mttrTrend[i]?.day; if (day)
   { requestRecoveryDayFocus(day); props.onOpenTab('runs') } }}` —
   `mttrTrend[].day` is the verified `YYYY-MM-DD` string; the bus
   (`requestRecoveryDayFocus`, consume-once sessionStorage + event) already
   drives the queue's day filter.
2. Heatmap roving tabindex (`RecoveryHeatmap.tsx`, cells verified as
   `<button>`): one cell tabbable (`tabIndex=0` on the focused index, −1
   elsewhere), `onKeyDown` maps Arrow keys to ±1 / ±columns over the
   existing cell array, `.focus()` the target; Enter/Space keep native
   button semantics.

**Files.** `VitalSignsStrip.tsx`, `RecoveryCenterPanel.tsx`,
`RecoveryHeatmap.tsx`, tests (browser test for arrows). **DB.** None.
**AC.** Clicking/entering a sparkline point filters the queue to that day;
arrows traverse the grid; Tab enters/leaves the grid once; decorative
sparkline (no label, no handler) unchanged.

#### Q-21 — Demo-to-real momentum (S)

**Problem.** Verified `shouldShowOnboarding({ runs, openFailures,
waitingApprovals, dismissed })`; `dismissed` persists in localStorage
forever — an operator who runs the demo and returns sees a blank center
instead of the all-clear moment.

**Spec.** Store the dismissal in `useWorkflowStore` session state
(`introDismissedThisSession: boolean`) INSTEAD of localStorage while
`metrics.terminalRuns === 0`; once the org has real terminal runs, write
the permanent localStorage flag on dismiss (current behavior). One
transition, pure client.

**Files.** store, `RecoveryCenterPanel.tsx`, helpers test. **DB.** None.
**AC.** Fresh org: dismiss → reload → walkthrough reappears; after first
real terminal run: dismiss persists across reloads.

### 2C-love. The love layer — new, grounded in verified primitives

> Verified inventory this layer builds on: `addToast(message, tone)`;
> `useAnimatedNumber(target, durationMs, snap)`;
> `usePrefersReducedMotion()`; CSS keyframes (`we-pulse`,
> `we-skeleton-pulse`) + reduced-motion guards in `index.css`; hero
> `actionMode` branch; `EmptyState` component (`icon/kicker/body/testId`);
> `emptyState.dlq.kicker = "Recovery queue is clear"`; metrics
> `downtimeEndedMs`; `userId` in the store; `audit_logs` GIN index on
> `metadata` + `dlq.replayed` audits carrying `actor.userId`.
> **Confetti/celebration animation today: NOT FOUND** — Q-41 creates the
> primitive the others reuse.

#### Q-38 — The all-clear moment (M) ★

**Problem.** When the last open failure is recovered, the hero simply
flips out of `actionMode` to the plain salutation — the single most
satisfying state transition in the product is unmarked.

**Spec (verified).** `RecoveryCenterPanel` tracks `hadOpenFailuresRef`
(ref, set true whenever `openDeadLetters.length > 0`). When the count
transitions >0 → 0 in-session: render the hero's else-branch with an
`allClear` variant for 30s (state + timeout): kicker swaps to
`t('recoveryCenter.hero.allClearKicker')` ("All clear"), subline
`t('recoveryCenter.hero.allClearSubline', { duration:
formatDowntime(metrics.downtimeEndedMs ?? 0), days: streak.current })`
("{{duration}} of downtime ended this window · {{days}}-day streak"), and
fire `<CelebrationBurst>` (Q-41) once. Purely client-side; on reload the
normal salutation shows (no persistence needed — the moment is the point).
ES copy natural: "Todo en orden — terminaron {{duration}} de inactividad ·
racha de {{days}} días".

**Files.** `RecoveryCenterPanel.tsx`, `RecoveryCenterHero.tsx`, i18n,
tests. **DB.** None.
**AC.** Seeded transition 2→0 open failures renders the all-clear variant
exactly once with burst; 0→0 on mount does NOT (no celebration on empty
workspaces); reduced-motion renders the copy without the burst.

#### Q-39 — Impact ledger: "since day one" (M) ★

**Problem.** Every number in the product is windowed (7/30/90d). Nothing
answers the retention question an owner asks at renewal: *how much has
Janusly given us back, total?*

**Spec (verified).** New route `GET /recovery/ledger`
(`recovery-routes.ts`, `role: "viewer"`): one aggregate over the verified
`dead_letters` columns —
```sql
SELECT count(*)::int AS total_replayed,
       coalesce(sum(extract(epoch from (replayed_at - created_at))), 0)::float8 AS downtime_ended_seconds,
       min(created_at) AS since
FROM dead_letters WHERE org_id = $1 AND status = 'replayed'
```
via a new `queryRecoveryLedger(orgId)` in `recoveryMetricsRepo.ts`
(follow the verified `queryMttrTrend` style). Cache it in
`metrics-cache.ts`'s map under a sentinel window key (e.g. `windowDays: -1`)
so the existing invalidation (+ Q-08 bus) keeps it honest. Web:
`ValueDashboardSection` (verified props) gains
`ledger?: { totalReplayed: number; downtimeEndedMs: number; sinceIso: string | null }`
and renders one quiet line under the window cards: EN "Since day one:
{{count}} failures recovered · {{duration}} of downtime ended" — the number
animates with `useAnimatedNumber`. ES: "Desde el primer día: {{count}}
fallos recuperados · terminaron {{duration}} de inactividad".

**Files.** `recoveryMetricsRepo.ts`, `recovery-routes.ts` (+ registry
entry), `metrics-cache.ts` reuse, `ValueDashboardSection.tsx`,
`RecoveryCenterPanel` fetch (fold into Q-17's single effect), i18n, SDK
types NOT touched (new endpoint, additive). **DB.** None (existing
columns; `dead_letters_org_status_idx` covers the scan).
**AC.** Integration test proves the SQL against seeded rows (mixed
statuses); route contract-tested; empty org → zeros + line hidden; EN/ES
green.

#### Q-40 — Personal wins: "you recovered N this month" (M)

**Problem.** All recovery stats are org-level; the operator who did the
recovering gets no personal reflection — the strongest habit loop there is.

**Spec (verified).** The `dlq.replayed` audit rows carry
`metadata.actor.userId` (verified auditAction enrichment) and `audit_logs`
has the GIN index on `metadata`. New
`queryOperatorReplayCount(orgId, userId, since)` in `auditLogsRepo.ts`:
```ts
count(*) WHERE org_id = $1 AND action = 'dlq.replayed'
  AND created_at >= $2 AND metadata @> '{"actor":{"userId": $3}}'
```
(compose the containment object with the userId — parameterized via
`sql` template, never string-interpolated). Exposed as
`GET /recovery/my-wins?days=30` (viewer). Hero subline in `actionMode === false`
when count > 0: EN "You recovered {{count}} failures this month" / ES
"Recuperaste {{count}} fallos este mes". `userId` comes from the store
(verified) — dev-header mode included.

**Files.** `auditLogsRepo.ts`, `recovery-routes.ts`, hero + panel fetch,
i18n, tests (+1 integration case proving the GIN containment query).
**DB.** None.
**AC.** Seeded audits for two users count separately (integration); zero →
line hidden; route org-scoped (cross-org seeded rows never counted).

#### Q-41 — `<CelebrationBurst>`: the one celebration primitive (S)

**Problem.** Verified NOT FOUND: no celebration animation exists. Q-13/38
(and future moments) each need one; without a shared primitive they'll
diverge or get skipped.

**Spec (verified).** New
`apps/web/src/components/recovery-center/CelebrationBurst.tsx`: pure
CSS/DOM (no dependency, respecting the web deps allowlist) — 10 absolutely
positioned particles using `--we-success` / `--we-cyan` tokens, one
`@keyframes we-celebrate-burst` (scale+translate+fade, 600ms,
`animation-fill-mode: forwards`) added to `index.css` WITH a
`prefers-reduced-motion: reduce` rule disabling it (verified pattern
exists for `we-spin`). Component API:
`{ trigger: number }` — replays when the number changes (parent increments
a counter); `usePrefersReducedMotion()` (verified hook) short-circuits to
`null`. Mount points: cluster celebration (Q-13 dialog success), all-clear
hero (Q-38). Unit test asserts render/no-render per reduced-motion.

**Files.** new component + test, `index.css`, used by Q-13/Q-38.
**DB.** None.
**AC.** Burst renders once per trigger increment; reduced-motion renders
nothing; no timers leak (cleanup on unmount).

---

## 2D. Wedge metrics — measure the two blind spots

#### Q-22 — Time-to-first-action metric (M) ★

**Problem.** MTTR measures creation→replay; the operator's *reaction* lag
is invisible. Verified: `recovery_items` has NO acknowledged-at timestamp —
only `status`, `resolvedAt`, `updatedAt` — so first-action time cannot be
derived today.

**Spec (verified).**
1. Schema (plain migration): `recovery_items.first_action_at
   timestamptz NULL`. Set-once semantics in the three verified mutators —
   `acknowledgeRecoveryItem` (repo line 438), `escalateRecoveryItem` (476),
   `resolveRecoveryItem` (542): add to each `.set()` block
   `firstActionAt: sql`coalesce(${recoveryItems.firstActionAt}, now())``.
2. Signal: `queryTimeToFirstAction(orgId, since)` in
   `recoveryMetricsRepo.ts` returning `{ avgSeconds: number | null;
   p95Seconds: number | null }` — epoch diff `first_action_at - created_at`
   over items created in the window, plus (UNION contribution) dead letters
   replayed without a recovery item (`dead_letters.replayed_at -
   created_at` where no matching `recovery_items` row exists). Add
   `timeToFirstAction` to the verified `RecoveryMetricsSignals` type and to
   `queryRecoveryMetricsSignals`'s parallel fetch.
3. Compose + surface: extend the verified `RecoveryMetrics` type with
   `timeToFirstAction: RecoveryMetric` (bands: healthy ≤ 15 min, warn ≤ 60
   min, else unhealthy — constants next to the SLA bands); one tile in the
   Recovery Center strip (icon `Hourglass`); SDK types (`sdk-node`
   `types.ts` strict-mirror fixture + `sdk-python`) extended; i18n
   `recoveryCenter.metric.ttfa.*` EN/ES.

**Files.** schema + migration, `recoveryItemsRepo.ts`,
`recoveryMetricsRepo.ts`, `recovery-metrics.ts`, panel tile, SDKs, i18n.
**DB.** 1 nullable timestamptz column.
**AC.** Set-once proven (second acknowledge doesn't move it — integration);
metric matches hand-computed seeded values incl. the no-item replay path;
empty window → null/neutral tile; SDK mirror tests green.

#### Q-23 — Recurrence rate: did the fix hold? (M) ★

**Problem.** A failure recovered today that re-fails tomorrow with the same
signature is a failed recovery — invisible, so confidence numbers overstate
durability. Verified: `recovery_items` already carries `errorSignature`,
`occurrenceCount`, `firstOccurredAt`, `lastOccurredAt`, `resolvedAt` — NO
schema change needed.

**Spec (verified).** `queryRecurrenceRate(orgId, since)` in
`recoveryMetricsRepo.ts`: over items resolved in the window,
`recurred = (lastOccurredAt > resolvedAt)` — covers the same-row reopen
path — `OR EXISTS` a newer `recovery_items` row with the same
`(org_id, error_signature)` whose `firstOccurredAt` lands within 7 days of
`resolvedAt` (covers the new-row path). Return
`{ resolved: number; recurred: number }`. NOTE for the implementer: which
of the two paths production takes on re-occurrence is pinned by the seeded
integration fixtures, not assumed — assert BOTH paths count exactly once.
Compose as `recurrenceRate: RecoveryMetric` ("Fixes that held: 94%", bands
healthy ≥ 90%, warn ≥ 75% — mirror `SLA_ATTAINMENT_BANDS`); tile + a
per-cluster "re-failed after fix" badge in the clusters panel when the
cluster's signature has a recurrence in-window; SDK types; i18n EN/ES.

**Files.** `recoveryMetricsRepo.ts`, `recovery-metrics.ts`, tiles/badge,
SDKs, i18n, integration fixtures. **DB.** None.
**AC.** Both recurrence paths counted once each (integration, seeded);
non-recurring resolved item not counted; empty window neutral; SDK mirrors
green.

---

## 2E. AI flywheel — make the product learn from every recovery

#### Q-24 — Signature-stratified confidence calibration (M/L) ★

**Problem.** Verified: `confidence_calibrations` is unique on
`(org_id, approach_label)` with linear curve columns; `recovery_feedback`
has NO error-class column; curves therefore average a 95%-on-timeouts /
20%-on-auth approach into garbage for both.

**Spec (verified).**
1. Schema (plain migrations): `recovery_feedback.error_signature text NOT
   NULL DEFAULT ''`; `confidence_calibrations.error_signature text NOT NULL
   DEFAULT ''` + replace the unique index with
   `uniqueIndex("confidence_calibrations_org_approach_sig_idx").on(orgId,
   approachLabel, errorSignature)` (two-file for the index swap on the
   calibrations table; low-churn table so plain is acceptable — state the
   choice in the PR).
2. Write path: the feedback route already receives `deadLetterId`
   (verified `RecoveryFeedbackBodySchema`); resolve the signature
   server-side — `recovery_items.errorSignature` looked up by
   `(orgId, deadLetterId)` (verified column + `deadLetterId` on the table);
   `?? ""`. Pass through `recordRecoveryFeedback` (add
   `errorSignature: string` to its input + `.values()`).
3. Sweep (`confidence-calibration-scheduler.ts`, verified cron
   `30 1 * * *`): group samples by `(approachLabel, errorSignature)`; fit
   the verified `fitCalibrationCurve(samples)` per bucket when
   `samples.length >= MIN_CALIBRATION_BUCKET_SAMPLES` (new constant, 20,
   env `JANUSLY_CALIBRATION_MIN_BUCKET`); ALWAYS also fit the
   approach-global bucket (`errorSignature: ""`) from all samples — the
   fallback row.
4. Read path (`ai-patch-route.ts`, verified `calibrate` closure +
   `indexCalibrationCurves`): index key becomes
   `` `${approachLabel}${errorSignature}` ``; lookup tries the
   specific key, falls back to `` `${approachLabel}` `` (global row).
   The route resolves the dead letter's signature the same way as step 2.
   `applyCalibration` (verified `CalibrationCurve` shape) unchanged.

**Files.** schema + migrations, `recoveryFeedbackRepo.ts`,
`ai-patch-feedback.ts` route, calibration sweep + repo,
`ai-patch-route.ts`. **DB.** 2 columns + 1 unique-index swap.
**AC.** Seeded 95/20 split across two signatures → per-signature calibrated
values differ and match hand-fit curves; bucket under threshold → global
curve applied (byte-identical to today); existing calibration tests green;
integration test on the unique index (same org+approach+signature upsert).

#### Q-25 — Success-weighted generation exemplars (M) ★

**Problem.** Verified: `composeGenerationExemplars` recalls
`kind: "generated_workflow"` and formats top-N by similarity alone;
`MemoryRecallEntry.workflowId` is a top-level field; a workflow that caused
repair loops is re-taught as an example.

**Spec (verified).**
1. New `queryWorkflowRunOutcomes(orgId, workflowIds: string[])` in
   `packages/data` (runs repo or a small new module):
   `runs JOIN workflow_versions ON runs.workflow_version_id =
   workflow_versions.id WHERE workflow_versions.workflow_id = ANY($ids) AND
   runs.org_id = $orgId GROUP BY workflow_versions.workflow_id` →
   `Map<workflowId, { succeeded: number; failed: number }>` (statuses
   `succeeded`/`failed`; cap with a `created_at >= now() - interval '90
   days'` guard + LIMIT via the grouped aggregate).
2. In `composeGenerationExemplars` (verified structure), after recall:
   batch-fetch outcomes for `entries.map(e => e.workflowId).filter(Boolean)`;
   sort entries by `successRate desc` (unknown outcome sorts middle,
   preserving similarity order within ties); DROP entries with
   `failed > 0 && succeeded === 0`. Entire join wrapped in try/catch →
   unweighted fallback (fail-open, matching the existing recall catch).
3. `composeExemplarBlock` unchanged (it receives the re-ordered slice).

**Files.** new data query + test, `ai-generation-memory.ts` + test.
**DB.** None.
**AC.** Stubbed recall + outcomes: succeeded-exemplar ordered above
repaired at equal similarity; known-bad dropped; outcome-query failure →
today's ordering byte-for-byte; consent gates untouched (recall path
unchanged).

#### Q-26 — Calibration meta-feedback + drift flag (M)

**Spec (verified).** `RecoveryFeedbackBodySchema` (verified) gains
`calibrationVerdict: z.enum(["accurate", "too_high", "too_low"]).optional()`;
`recovery_feedback.calibration_verdict text NULL` (plain migration);
persisted through `recordRecoveryFeedback`. The daily sweep flags a bucket
when >20% of its last-30d verdicts are `too_high` (min 10 verdicts): write
audit `calibration.drift_flagged` (new `AuditAction`) with
`{ approachLabel, errorSignature, tooHighShare }`; `ai-patch-route`
includes `calibrationDrift: boolean` per suggestion (bucket flagged in the
loaded curves' last sweep — add a `driftFlagged boolean NOT NULL DEFAULT
false` column to `confidence_calibrations` set by the sweep);
`RecoveryDialog` renders an amber note
`t('recoveryDialog.calibrationDrift')` when true. **Files.** feedback
schema/route/repo, sweep, patch route, dialog, i18n, migrations. **DB.** 2
columns. **AC.** Verdict persists; flag fires at seeded 30% too-high and
not at 10%; note renders EN/ES; suggestions without drift unchanged.

#### Q-27 — AI cost observability: cache hit-rate + Best-of-N backoff telemetry (S)

**Spec (verified).** (a) Verified NOT FOUND: cached-token fields are never
read. In `llm-client.ts`, after each SDK call, defensively read
`const anth = (aiResult as { providerMetadata?: { anthropic?: Record<string, unknown> } }).providerMetadata?.anthropic;`
then `cacheReadInputTokens` / `cacheCreationInputTokens` via
`Number(...)` + `Number.isFinite` guards → optional `cachedInputTokens?:
number; cacheCreationInputTokens?: number` on the verified `UsageRecord`
type → persisted by `recordUsage` into `usage_events.metadata` (recorder
already spreads metadata; extend the object it builds). If the SDK
metadata shape differs at runtime, the guards yield `undefined` — no
crash, no lie. (b) Verified `budgetAwareCandidateCount` collapses N→1 on
`warningThresholdCrossed`; at its call site
(`ai-generate-route.ts:113-116`), when `candidateTarget <
orgConfig.ai.generationCandidates`, tag the generation's usage context —
simplest verified-safe route: pass a `bonBackoff: { from, to }` field on
the response envelope's meta AND write one audit
`ai.generation.candidates_backoff` (new AuditAction). Value dashboard adds
two rows fed by a small `queryAiCacheSavings(orgId, since)` over
`usage_events.metadata` (GIN not needed — filter by `metric =
'llm.completion'` window + aggregate in SQL on
`(metadata->>'cachedInputTokens')::int`). **Files.** `llm-client.ts`,
`usage-recorder.ts`, `usageRepo.ts`, `ai-generate-route.ts`,
`audit-helper.ts`, dashboard rows, tests. **DB.** None. **AC.** Stubbed
SDK responses with/without cache metadata produce records with/without the
fields; recorder failures still never break the call (existing posture
test); backoff audit fires only when collapsed; dashboard rows render from
seeded usage.

#### Q-28 — Memory recall quality knobs (M)

**Spec (verified).** All inside `memoryEntriesRepo.ts` + catalog. (a)
`memory.recallMinSimilarity` (catalog entry: `valueType: "number"`,
`defaultValue: 0`, `min: 0`, `fractional: true` — copy the verified entry
shape): when > 0, push onto the verified `filters` array
`sql`(${memoryEntries.embedding} <=> ${queryEmbeddingJson}::vector) <= ${1 - min}``
(cosine distance = 1 − similarity). (b) `memory.recallRecencyHalfLifeDays`
(number, default 0 = off): post-fetch re-rank in code —
`score = (1 - distance) * Math.exp(-ageDays / halfLife)` — over the
already-limited rows (fetch limit unchanged). (c) commit-side dedup:
`memory_entries.content_hash text NULL` (plain migration) +
`index("memory_entries_org_kind_hash_idx").on(orgId, kind, contentHash)`;
in `commitMemory` before `generateEmbedding`, compute
`createHash("sha256").update(scrubbedContent).digest("hex")`, look up same
`(orgId, kind, contentHash)` with `createdAt >= now() - 7 days`; hit →
return `{ ok: true, entryId: existing.id }` (skip embed + insert — saves
the embedding call too). Defaults preserve today's behavior byte-for-byte.
**Files.** `memoryEntriesRepo.ts`, `orgConfigCatalog.ts`, schema +
migration, unit + one integration case. **DB.** 1 column + 1 index.
**AC.** Each knob unit-tested; defaults byte-identical (existing memory
tests green); dedup proven against real Postgres in the integration lane
(second commit returns the first id, no second row).

#### Q-29 — Structured-output schema-retry (S)

**Spec (verified).** In the verified structured-output path
(`experimental_output` undefined → throw): before throwing, retry ONCE —
re-call `aiGenerateText` with the same args plus system suffixed by
`"\nEmit ONLY valid JSON matching the schema. Your previous attempt did
not parse."`; tag the retry's usage record `aiError:
"schema_retry_succeeded"`... no — keep `mode: "ai"` on success and add
optional `schemaRetry?: true` to `UsageRecord`. Second failure → today's
fallback exactly. Guard: only when the first call actually returned text
(don't retry transport errors — the SDK's `maxRetries` covers those,
verified `maxRetries: cfg.maxRetries`). **Files.** `llm-client.ts` +
tests, `usage-recorder.ts`. **DB.** None. **AC.** Stubbed
invalid-then-valid returns the object with `schemaRetry` recorded;
invalid-invalid falls back identically to today (envelope byte-compatible);
fallback contract untouched.

#### Q-30 — Streaming run-explain (M, lowest priority here)

**Spec (verified).** Verified NOT FOUND: no `streamText` anywhere. Add
`import { streamText } from "ai"` in `llm-client.ts`; new
`generateTextStream(input): Promise<{ stream: ReadableStream<string>; … }>`
(same provider/model/system plumbing; usage recorded on stream end via the
SDK's `onFinish`). `/ai/explain-run` gains `?stream=true` → SSE (reuse the
run-events SSE plumbing pattern in the API); web run inspector renders
progressive text with the buffered path as fallback. **Files.**
`llm-client.ts`, `runExplainer.ts`, explain route, inspector component.
**DB.** None. **AC.** Stubbed slow stream shows first token before
completion (browser test); non-streaming path byte-identical; usage row
still written once.

---

## 2F. Engineering hygiene

#### Q-31 — Adopt Biome (M) ★
Verified: zero linter/formatter config repo-wide. `biome.json` at root
(recommended preset; formatter matched to dominant style — the repo mixes
2-space TS with semicolons in packages and no-semicolons in apps/web, so
scope the formatter per-dir via `overrides` or start linter-only +
formatter in a follow-up; state the choice in the PR), excludes
`dist`/`migrations`/generated; one mechanical `biome check --write` commit
reviewed separately; CI step `biome ci` in `build_test` (blocking);
AGENTS.md testing section documents it. **AC.** `biome ci` green; fixup
commit has zero behavior change (`pnpm test` identical before/after); a
seeded unused import fails CI.

#### Q-32 — Data-repo test gap (M)
Verified zero test files for `failureClusterRepo`, `budgetRepo`,
`usageRepo`, `routingStatsRepo`, `invitationsRepo`. One `*.test.ts` each
(mocked-DB pattern from `orgConfigRepo.test.ts`): tenant scope, caps,
cursor/window edges, empty results; +1 integration case for clustering
windows. **AC.** Removing any org-scope WHERE breaks a test; each public
function ≥ happy + edge.

#### Q-33 — Payload-assertion retrofit (M)
Verified status-only assertions (e.g. `dlq-routes.test.ts:191/235/284`).
Retrofit workflows/runs/dlq/recovery/credentials suites: every status
assertion pairs with `expect(payload).toEqual(expect.objectContaining({…}))`
on load-bearing fields. **AC.** Grep gate documented in the PR shows zero
status-only assertions remain in the five suites; all green.

#### Q-34 — Split `http-policy.ts` at its natural seam (M)
835 lines mixing SSRF/DNS-pin with bounds/streaming. Move to
`http-policy/ssrf-pin.ts` + `http-policy/bounds.ts` +
`http-policy/index.ts` barrel re-exporting `fetchHttpTarget` (consumer
imports unchanged). Pure structural. **AC.** `http-policy.test.ts` green
WITHOUT edits; AGENTS.md pointer updated.

#### Q-35 — Shared route-test fixture (M)
30–50 lines of duplicated `vi.mock` boilerplate per route test.
`apps/api/src/routes/test-fixtures.ts` with `createRouteHarness()`
(auth-context factory, audit spy, sendJson capture); prove on dlq +
credentials + mcp suites. **AC.** 3 suites shrink (LOC delta reported)
with identical assertions; authoring guide in the fixture header.

#### Q-36 — `engines` on all workspaces (S)
Verified missing on all 8 (db, data, engine, shared, ai, domain, api, web);
both SDKs have it. Add `"engines": { "node": ">=24.0.0" }` to each.
**AC.** All manifests carry engines; install on Node 24 unaffected.

#### Q-37 — Drizzle stable-upgrade spike (S/M)
Four packages pin RC commit hashes. Time-boxed: check latest stable
`drizzle-orm`/`drizzle-kit`; upgrade on a branch; `pnpm test` +
`pnpm test:integration` + `pnpm migrate` on a scratch DB + regenerate one
no-op migration to diff kit output. Green → land; red → dated blocker note
in P-15's doc. **AC.** Upgrade landed or blocker documented — no third
outcome.

---

## 3. Consolidated DB changes

| Proposal | Change | Pattern |
| --- | --- | --- |
| Q-04 | `schedule_ticks` table + UNIQUE `(schedule_entry_id, triggered_at_minute)` | Plain |
| Q-05 | `consecutive_failures` + `next_poll_at` on the upstream-health table | Plain |
| Q-10 | `dead_letters.node_type` + `workflow_name` STORED generated columns | Two-file (table rewrite runbook) |
| Q-11 | Evidence-gated index adjustments (`usage_events` prefix-redundancy first) | Two-file |
| Q-12 | BRIN on `run_events(created_at)` | Two-file |
| Q-22 | `recovery_items.first_action_at timestamptz NULL` | Plain |
| Q-24 | `error_signature` (NOT NULL DEFAULT '') on `recovery_feedback` + `confidence_calibrations`; unique-index swap to `(org, approach, signature)` | Plain + index swap |
| Q-26 | `recovery_feedback.calibration_verdict` + `confidence_calibrations.drift_flagged` | Plain |
| Q-28 | `memory_entries.content_hash` + `(org, kind, hash)` index | Plain |

Q-23 needs NO schema change (verified `recovery_items.error_signature` /
`occurrence_count` / timestamps suffice). Everything follows
schema-in-`schema.ts` + checked-in SQL; hot-table work uses the two-file
pattern.

---

## 4. Refinements to the existing backlog (new evidence, same tickets)

- **P-07 (retention org pre-filter):** `listOrgIdsForRetention` is
  uncapped — add `batchSize` (default 100) + spread across more frequent
  fires.
- **P-10 (split templates.ts):** better design — extract the 13 inline
  template objects to `apps/api/data/templates.json` + typed loader.
- **P-14 (usePoll hook):** widen to `usePanelFetch` — ~20 panels repeat the
  fetch/loading/error scaffold (400–600 duplicated lines).
- **P-24 (quick-copy error summary):** add copy-full-JSON to the DLQ
  `DetailBlock`.
- **Deep-review #20 (eval auto-harvest):** concretize the filter —
  `accepted = true AND rawConfidence ≥ 80` daily sweep proposing one-click
  eval candidates.

---

## 5. Recommended execution order

1. **Batch A — platform trust:** Q-01 ★ (do first: S with outsized MTTR
   impact), Q-02, Q-03, Q-36.
2. **Batch B — the drama of recovery + love layer:** Q-41 (the primitive),
   Q-13 ★, Q-19 ★, Q-15 ★, Q-14 ★, Q-38 ★, Q-16. Pull P-22 (weekly digest)
   from v1 alongside — it compounds with streaks and the ledger.
3. **Batch C — scale-out truth:** Q-08 ★, Q-09, Q-10, Q-12, Q-11.
4. **Batch D — wedge metrics + flywheel:** Q-22 ★, Q-23 ★, Q-39 ★, Q-40,
   Q-24 ★, Q-25 ★, Q-27.
5. **Batch E — hygiene:** Q-31 ★ (Biome first — every later diff
   benefits), Q-32, Q-34, Q-37; Q-33/Q-35 opportunistic.
6. **Batch F — remaining:** Q-05, Q-06, Q-07, Q-17, Q-18, Q-20, Q-21,
   Q-26, Q-28, Q-29; Q-04, Q-30 when their areas are next touched.

**Sizing note:** Batches A+B ≈ one focused iteration (~3 S + ~8 M). If only
ONE thing ships, ship Q-01: a recovery platform whose own nodes can hang
forever is the one story we never want a design partner to tell. If TWO,
add Q-13 — the loudest silent moment in the product becoming its proudest.

> §6 below (market scan, added later the same day) integrates
> market-extracted proposals into this order — see §6.6 for the merged
> sequence. Where §5 and §6.6 differ, §6.6 wins.

---

## 6. Market scan & competitive feature extraction — 2026-07-06

Method: four web-research passes over the current (July 2026) state of the
four adjacent markets — automation incumbents (Zapier, Make, n8n, Workato,
Power Automate), developer durable-execution (Temporal, Inngest,
Trigger.dev, Restate, Hatchet, Windmill, Step Functions), AI-native
automation (Gumloop, Lindy, Relay.app, LangGraph/LangSmith, OpenAI, Anthropic,
Copilot Studio, Retool, Zapier Agents), and incident/AIOps remediation
(PagerDuty, incident.io, Rootly, FireHydrant, Grafana IRM, BigPanda,
Resolve.io, Datadog). Every load-bearing claim carries a docs/changelog URL
in the underlying reports; the strongest are cited inline here.

### 6.1 Positioning verdict — the wedge holds; amplify, don't pivot

1. **Nobody owns the full recovery loop.** Across all four segments, no
   product chains DLQ → AI patch with confidence → **sandbox validation** →
   cluster apply → replay → rollback. The pieces exist separately: Zapier
   explains errors (AI Troubleshoot) but stops at instructions; Windmill's
   "AI Fix" is editor-time for developers; PagerDuty's SRE Agent executes
   remediations on approval but never dry-runs them; Temporal/Inngest have
   no AI recovery at all. **No one validates the fix before offering it** —
   Janusly's sandbox gate is ahead of the whole market.
2. **Closed-loop remediation success tracking is the market's weakest spot
   and Janusly's strongest.** Audit logs of job runs exist everywhere;
   "did this class of fix hold?" analytics mostly don't (BigPanda problem
   management and PagerDuty smart playbooks are the closest). The recovery
   feedback loop + confidence calibration is a durable differentiator —
   Q-23/Q-24 deepen exactly this moat.
3. **Every incumbent's replay story breaks at scale — marketing ammo with
   exact numbers:** Zapier's Autoreplay can't touch Held runs; Workato caps
   manual rerun at 10/page (its new Job Retry API: 25/call); Power Automate
   caps resubmit at 20 with no supported API; n8n has NO bulk retry (the
   community scripts internal endpoints; auto-retry has been an open request
   since 2021). Make only shipped bulk retry in March 2025 after a 130-vote,
   years-old request.
4. **Demand evidence for the wedge itself:** the n8n community hand-builds
   "auto-heal failing workflows with OpenAI + n8n API + Slack" templates —
   people are assembling Janusly out of duct tape.
5. **Market signals:** OpenAI deprecated Agent Builder + its Evals platform
   (June 2026, EOL Nov 2026) — the model lab exited visual agent ops,
   validating the independent ops layer and orphaning a user base ("don't
   build your ops on a lab's side project" is now a proven sales line).
   Anthropic stays a supplier (SDK + Managed Agents infra), not a
   competitor, to this layer.
6. **Pricing posture (not a code ticket, a positioning decision):** Zapier,
   Make, and Workato all bill retries/reruns as tasks/operations/credits —
   a documented source of operator resentment ("recovery literally costs
   money"). Janusly should hold the line, loudly: **recovery actions are
   never metered.** Put it on the pricing page when one exists.
7. **2026 trust bar for AI findings:** confidence scores alone are table
   stakes; the bar is a **visible reasoning chain** (Rootly evidence-backed
   theories, Datadog Bits hypothesis tree + agent trace). Janusly has the
   score and the evidence side-channel; it under-invests in the display
   (M-11).

### 6.2 Market-extracted proposals (M-series)

Feature-level proposals distilled and deduplicated from ~40 gap-table rows.
Format: Who/evidence → problem → design sketch grounded in Janusly's
existing architecture → composes-with → size. Full Q-style specs get
written on promotion to an ENG row (same verify-before-implement
discipline as §2).

#### Tier ★ — wedge-critical

**M-01 — Redrive: resume the failed run from the failed node, on the
patched version (M/L) ★★ the last mile of the wedge.**
Who: Step Functions Redrive (resume-from-failure, outputs reused), Windmill
"restart flow with version selection" (restart an old run on a NEWER flow
version, prior step results reused by matching step IDs), Temporal Reset.
Problem: Janusly replays the failed *job*; on long DAGs that can re-run
write-side upstream nodes (double charge/email) or lose completed work.
Design: new `POST /runs/:id/redrive` — creates a linked continuation run
seeded from the original's completed `run_nodes` outputs (the substrate
already persists them; the validation-replay tx already proves the
copy-ancestor-state pattern), marks the failed node `queued`, executes
forward on a chosen `workflowVersionId` (default: latest = the AI-patched
version), matching nodes by id like the sandbox does. Composes: Q-02
(atomic transition), the sandbox gate (validate first), cluster-apply
(cluster-redrive). **Nobody in the market has redrive + new-version +
AI-patch chained; each rival has exactly one piece.**

**M-02 — Canary ramp for patched versions + alarm-gated auto-rollback (M) ★.**
Who: Temporal Ramping Version (GA), SFN alias weighted routing.
Problem: after sandbox validation, cluster-apply goes 0→100 — validation
proves structure, not production behavior.
Design: `workflow_versions` gains an optional ramp: N% of new runs route to
v(n+1) (deterministic hash on runId), the rest stay pinned; the existing
health rollup watches the canary cohort's failure rate; breach → automatic
rollback + alert; healthy for a window → promote. Composes: auto-healing
(a ramped auto-apply is far easier to consent to), Q-07 (gate audit).

**M-03 — Circuit breaker + trigger buffering + backfill (M/L) ★.**
Who: Make auto-deactivation ("errors before deactivation" per-scenario),
Zapier error-ratio auto-pause, Inngest function pausing (events stored as
"skipped", replayable after resume).
Problem: while a patch is authored, a broken workflow keeps flooding the
DLQ and firing duplicate side effects; disabling it today drops trigger
events on the floor.
Design: per-workflow `recovery.circuitBreaker` config (consecutive-failure
threshold); tripping pauses new runs but event-driven trigger nodes keep
ingesting into a buffered state (`runs` with a `buffered` status or a
slim `trigger_buffer` table); on resume (or on applied patch), backfill
replays the buffered window — paced (M-04's scheduler). Turns "we dropped
3 hours of webhooks" into a non-event. Composes: M-01 (backfill = bulk
redrive), ownership handoff (pause → patch → sandbox → resume is the
incident flow).

**M-04 — Transient-error fast path: class-aware auto-retry tier + jitter (S/M) ★.**
Who: Zapier Autoreplay (5m→30m→1h→3h→6h), Make auto-retry of
rate-limit/connection/timeout incompletes, SFN `JitterStrategy`/`MaxDelaySeconds`.
Problem: most failures are transient; burning an LLM patch proposal (and
operator attention) on a 429 wastes the wedge's credibility and budget.
Design: failure classification already exists (clustering signatures) —
add a deterministic pre-DLQ tier: error classes `rate_limit | connection |
timeout` get a zero-LLM scheduled re-enqueue ladder (env-tunable, capped)
before dead-lettering; per-node retry config gains `jitter: boolean` and
`maxDelayMs`. DLQ then holds only the *interesting* failures. Composes:
M-10 (don't page on self-healed), value dashboard (count auto-recovered).

**M-05 — Replay campaigns: named, paced, abortable bulk recovery (M) ★.**
Who: Inngest Replay (function × time window × statuses incl. *Succeeded*,
spread over time, progress page), Trigger.dev bulk actions (millions of
runs, live progress, mid-action abort, completion email), Inngest
predicate bulk-cancel (CEL `if` over event data).
Problem: cluster-apply replays a failure cluster; incidents also need
"replay everything in this 2h window — including silently-wrong successes"
without thundering-herding the just-recovered upstream, and killing
in-flight poisoned runs first.
Design: `recovery_campaigns` table (name, filter snapshot, pacing,
progress counters, status) + a worker loop that drains the matched set at
a paced rate; UI: create-from-filter on the queue/runs views, progress
page, abort button; a matching predicate-scoped bulk-cancel. Composes:
M-01 (campaign of redrives), M-03 (backfill runs as a campaign), Q-39
(campaign outcomes feed the ledger).

**M-06 — Slack-first recovery actions (L) ★ the adoption bet.**
Who: incident.io (the Slack-native gold standard), Datadog Workflow
"Make a decision" Approve/Reject in Slack, Relay.app interactive approvals
(approve + fill form inputs in Slack), Rootly.
Problem: operators live in Slack; every serious competitor's approval loop
is chat-native; Janusly's approve/replay/patch-review being web-only is the
single biggest adoption-friction gap found in the whole scan. Approval
latency is often the biggest wall-clock slice of MTTR.
Design: a Slack app (per-org OAuth, `credentials.secret_ref`-style token
custody): failure alert → channel message carrying the error summary + top
patch + confidence + buttons [Validate in sandbox] [Replay] [Acknowledge]
[Open]; `approval`/`human_form` nodes optionally post interactive messages
(the HMAC resume-token flow already secures the resume). Absorbs and
supersedes deep-review #16 (Slack two-way approvals). Phased: alerts+ack
(S) → replay/patch buttons (M) → human_form forms (L).

**M-07 — The alert carries the fix (S) ★.**
Who: Power Automate repair-tips emails, Zapier AI Troubleshoot — nobody
closes the loop.
Problem: the MTTR clock starts at the alert, but Janusly's alerts and its
patch proposals live in different surfaces.
Design: the DLQ alert payload (email/webhook/Slack) embeds the top cached
patch approach + calibrated confidence + a one-click deep link to the
Recovery dialog with sandbox pre-armed. Alert-to-action in one click; no
competitor does it. Composes: M-06, Q-24 (per-signature confidence).

**M-08 — Change correlation: "suspect version" (S) ★.**
Who: PagerDuty AIOps change correlation, incident.io failing-PR detection,
Datadog Change Tracking.
Problem: "what changed?" is the first RCA question in every incident tool;
Janusly has version history + `computeWorkflowDiff` and never volunteers
the answer.
Design: when a failure's first occurrence lands within a window after a
`workflow_versions` save, tag the DLQ item/cluster `suspectVersionId`;
`/ai/patch-workflow` evidence gains a `workflow_diff` row (diff vs
last-green version); UI chip "Started after v12 was saved — view diff".
Nearly free: the diff engine and version timestamps exist.

**M-09 — Auto-pause alerts for self-healed transients (S) ★.**
Who: PagerDuty AIOps (auto-paused incident notifications for transient
alerts).
Problem: alert fatigue is the #1 churn driver in the category; Janusly's
alert policies page on failures that M-04's retry tier (or auto-healing)
resolves seconds later.
Design: alert dispatch for a failure enters a short hold (config
`alerts.selfHealHoldSeconds`, default 60); if the failure resolves within
the hold, suppress the page and count it ("42 alerts you never needed to
see" in the value dashboard — the quietest feature with the loudest love).

**M-10 — Playbooks: promote proven fixes + success analytics (M) ★.**
Who: PagerDuty SRE Agent "smart playbooks" + Advance analytics (value of
AI quantified), BigPanda problem management.
Problem: calibration data already knows which patch approaches work where;
that knowledge is invisible and unnamed — nothing an ops lead can point at
in a renewal conversation.
Design: an accepted patch (or recurring cluster fix) can be promoted to a
named `playbook` (org-scoped: name, signature match, workflow patch
template, success stats from `recovery_feedback`); on a new matching
failure the playbook is the first suggestion, labeled "Playbook: Retry
after 429 — 87% success (23 uses)". Absorbs BigPanda's "problem record"
concept (a playbook attached to a recurring signature IS the KEDB entry).
Composes: Q-24 (per-signature stats are the playbook's scorecard),
deep-review #2 (runbook attachments).

**M-11 — Reasoning transparency: hypothesis panel on patches + live agent
trace (M) ★.**
Who: Datadog Bits hypothesis tree + Agent Trace view, Rootly confidence +
visible reasoning chain, Make's agent Reasoning Panel.
Problem: the 2026 bar for AI findings is an inspectable reasoning chain;
Janusly shows confidence + evidence rows but not *which theories the
patcher weighed*, and agent nodes stream events without a "what is it
thinking" surface.
Design: (a) `/ai/patch-workflow` prompt asks for a compact
`consideredAlternatives: [{approach, rejectedBecause}]` alongside each
suggestion (free_json, additive, fallback-safe); dialog renders it as a
collapsible "Why this fix" panel over the existing evidence rows. (b) The
agent loop already emits run events over SSE — add a `agent.reasoning`
event type (plan step, tool chosen, why) rendered live in the run
inspector. Directly upgrades patch-approval conversion.

**M-12 — `janusly.md`: operator guidance file for the AI (S) ★.**
Who: Datadog `bits.md` (preview 2026).
Problem: operators steer patch generation today only via feedback after
the fact; there's no way to say "in this org, never suggest raising
timeouts on payment nodes" without prompt engineering.
Design: an org-level (and optional per-workflow, via
`workflow_metadata`) markdown guidance document, stored like runbook
fragments, size-capped, injected DATA-framed (escape clause +
`scrubSecretShapes`, exactly like the recall paths) into patch/generation
prompts. Editable in the UI under AI settings. Deepens lock-in: the
guidance lives in Janusly.

#### Tier 2 — strong, schedule after the ★ set

**M-13 — Payload surgery on DLQ items (M).** Who: Make incomplete
executions (edit the failed bundle's data inline, then resume). Problem:
AI patches fix the *workflow*; many DLQ items are one bad *record* —
unrecoverable today no matter how good the patch engine is. Design: the
DLQ detail view allows editing the failed node's **input** (bounded JSON
editor, schema-checked against the node's config schema, secrets-redacted
view), replayed via the existing suggestedWorkflow path with an
`inputOverride`; audited (`dlq.input_overridden`).

**M-14 — Ops copilot + natural-language run filter (M).** Who: Power
Automate Automation Center Copilot ("what's at risk of breaching SLA
today?"), Trigger.dev AI filter feeding bulk actions. Design: one
LlmClient consumer that translates NL to the existing filter grammar
(queue/runs filters + day ranges) and answers aggregate questions over
DLQ/SLA/cluster data (read-only, evidence-linked). Filter-translation
first (S), Q&A second (M).

**M-15 — Recommendations inbox (M).** Who: PA Automation Center
recommendations feed (ranked by impact). Problem: Janusly's health rollup +
readiness + clustering are dashboards-you-visit, not a triage queue that
finds you. Design: a ranked ops inbox composing existing signals (failure
spike vs baseline, SLA-at-risk, workflow missing retries/readiness fails,
gated auto-heals from Q-07); each card deep-links to the fix surface.

**M-16 — Read-only SQL introspection (S → M).** Who: Restate `restate sql`
(psql-compatible over live state), Inngest Insights, Trigger.dev TRQL.
Design phase 1 (S): a documented read-only Postgres role + curated views
(`janusly_runs`, `janusly_dlq`, `janusly_usage`) shipped as SQL in
`docs/operations/introspection.md` — Janusly is Postgres-native; this is
nearly free and lands hard with senior operators. Phase 2 (M, later): an
in-app query panel.

**M-17 — On-error edges on the canvas (M/L).** Who: Make's 5 error
directives, n8n error output branch, Gumloop Error Shield, Retool error
handlers — table stakes for every incumbent. Problem: without author-time
error routes, *every* failure becomes a DLQ item; predictable failures
should degrade gracefully in-flow, reserving the AI machinery for novel
breaks. Design: an `onError` edge condition (the edge model already
supports `condition`) + readiness rules for orphan error paths; the
runtime routes a failed-after-retries node's error envelope down the
error edge instead of dead-lettering, when one exists.

**M-18 — Fan-out failure budget + failed-items-only redrive (M/L).** Who:
SFN Distributed Map (`ToleratedFailurePercentage`, item-level redrive of
only failed children). Problem: `parallel_fork`/`join` is ALL-AND; batch
workflows dead-letter 10,000 items because 12 failed. Design: fork config
gains `toleratedFailureCount/Percentage`; the join collects
partial-success (failed branches recorded, run continues); DLQ entry per
failed item group with an items-only redrive. Composes: M-01, M-05.

**M-19 — Run-level deadline (S).** Who: Temporal Schedule-To-Close, SFN
`TimeoutSeconds`, Trigger.dev `maxDuration`. Design: `workflow.deadlineMs`
(workflow-level field, diff-tagged like timeouts); a scheduler sweep (or
check on node completion) fails runs exceeding it — "alive but too slow"
becomes a hard signal feeding SLA attainment. Composes: Q-01.

**M-20 — NL edits with diff preview (S/M).** Who: Zapier Copilot edits
existing Zaps; standard across AI-natives (Gummie, Lindy, Relay). Design:
generalize `/ai/patch-workflow`'s envelope to an edit surface: prompt +
current workflow → patched workflow → `WorkflowDiffView` gate → save as
new version. The whole chain exists; this is a new route + studio entry
point. Makes patching feel native, not exceptional.

**M-21 — Selective hunk apply on AI patches (M).** Who: Zapier Agents
per-AI-edit checkpoints with partial restore. Problem: operators reviewing
a 3-change patch often want 2 of 3. Design: `computeWorkflowDiff` already
yields per-node/per-field changes; the Recovery dialog gains checkboxes
per change group; apply composes only the selected hunks onto the base
version. Deepens patch-approval trust.

**M-22 — One filter grammar across find AND bulk-act (M).** Who: Temporal
List Filters (same query drives UI list, CLI, and every batch operation).
Problem: Janusly's DLQ/runs filters are bespoke query params per endpoint;
M-05's campaigns need a reusable cohort definition. Design: a small typed
filter object (status, day range, workflowId, signature, severity)
serialized once, accepted by list + campaign + bulk-cancel endpoints alike.

#### Priority bumps to existing backlog (market-validated, not new)

- **Deep-review #6 (postmortem generator)** — validated by PagerDuty Jeli,
  FireHydrant AI retros, incident.io auto-drafted postmortems. Promote
  early: compose run-explain + evidence + timeline into the artifact ops
  teams are contractually required to produce.
- **Deep-review #27 (read-only status page)** — validated by PagerDuty
  audience-specific status pages (GA 2025) + incident.io. Add the
  "audience" concept (internal stakeholder view keyed to business
  workflows) when promoting.
- **Deep-review #20 (eval auto-harvest)** — validated by LangSmith
  datasets-from-traces; keep the §4 refinement (confidence-filtered
  candidates) and add "one-click failed-run → eval case" from the DLQ
  detail view.
- **P-22 (weekly digest)** — validated by LangSmith Insights Agent
  (AI-written exec summaries over traces, scheduled). Upgrade the spec: the
  digest narrates failure clusters, MTTR wins, and the ledger (Q-39), not
  just counts.
- **Q-22 (time-to-first-action)** — add PagerDuty's companion numbers when
  building: acknowledgement-rate % and off-hours interruption count come
  from the same timestamps.

#### Watchlist (monitor, don't build)

- **Computer use / Autopilot** (Lindy, Copilot Studio): biggest capability
  gap *off*-wedge — large effort, no MTTR payoff.
- **BYO agent-framework interop** (Temporal × OpenAI Agents SDK GA):
  revisit only if design partners ask; Janusly's agent nodes compete on
  integrated recovery, not framework interop.
- **Durable LLM token streams** (Temporal Workflow Streams, Trigger.dev
  Realtime v2 resumable streams): elegant, not wedge-critical; pair with
  Q-30 if/when streaming ships.
- **Live activity operations** (Temporal activity pause/update-options
  mid-failure): the single best operator-trust feature found in
  durable-execution land, but heavy on the runtime; reconsider after M-03.

### 6.6 Integrated execution order (supersedes §5 where they differ)

1. **Batch A — platform trust:** Q-01 ★, Q-02, Q-03, Q-36 *(unchanged)*.
2. **Batch B — drama of recovery + love layer:** Q-41, Q-13 ★, Q-19 ★,
   Q-15 ★, Q-14 ★, Q-38 ★, Q-16, **+ M-07 ★ (alert carries the fix — S)
   and M-08 ★ (suspect version — S)**: both are small, both make the wedge
   visceral at the exact alert/diagnosis moments.
3. **Batch C — scale-out truth:** Q-08 ★, Q-09, Q-10, Q-12, Q-11
   *(unchanged)*.
4. **Batch D — wedge metrics + flywheel:** Q-22 ★ (+ ack-rate), Q-23 ★,
   Q-39 ★, Q-40, Q-24 ★, Q-25 ★, Q-27, **+ M-10 ★ (playbooks)** — it
   converts D's calibration work into sellable ROI, and **M-09 ★
   (self-heal alert hold — S)**.
5. **Batch E — containment (new, market-driven):** M-04 ★ (transient
   tier), M-03 ★ (circuit breaker + buffering), M-05 ★ (campaigns), M-22
   (filter grammar — build it inside M-05).
6. **Batch F — the two big bets:** M-01 ★★ (redrive) then M-02 ★ (canary)
   — sequence after Batch E so campaigns/backfill can drive redrives; then
   M-06 ★ (Slack) phased S→M→L.
7. **Batch G — hygiene:** Q-31 ★, Q-32, Q-34, Q-37; Q-33/Q-35
   opportunistic *(unchanged)*.
8. **Batch H — remaining Q + Tier-2 M:** §5's batch F list + M-11, M-12,
   M-13..M-21 as their areas get touched; priority bumps (postmortem,
   status page, digest) interleave on design-partner pull.

**One-sentence strategy:** the scan says Janusly's loop is unique — so
spend Batches A–D making it *trustworthy and felt*, Batch E making it
*contained*, and Batch F making it *complete* (redrive + canary) and
*present where operators live* (Slack); everything else is fluency.

---

## 7. Third-wave audit — under-covered axes + empirical measurement (2026-07-06)

The first two waves covered engine/UX/perf/testing deeply but SPOT-covered
five axes. This pass targeted exactly those, added **empirical measurement**
(real bundle sizes, schema/route/LOC counts) instead of static reading, and
ran a **claim-verification batch** before writing — which corrected three
false agent findings (kept below for honesty).

**Empirical baseline (measured this pass):** 50 tables · 80 routes · 2,693
i18n keys (EN) · 40 runtime deps · **~103k LOC of source** (web 30.5k · api
23.7k · engine 23.0k · data 15.3k · shared 4.9k · ai 3.0k · db 2.1k · domain
0.4k). Web bundle: **1,818 KB raw / 470 KB gzip across 41 chunks**; heaviest
gzip: `index` entry 93.8 KB, `react-vendor` 73.7 KB, `CanvasWorkspace` 56.4
KB (already code-split), `supabase-vendor` 50.0 KB, `App` 32.8 KB.

**Corrected during verification (agent claims that were FALSE — do NOT act
on the original framing):**
- `GET /causal` **exists** (`runs-routes.ts:709`) — the causal-reasoning
  engine IS routed. The real gap is only the UI "What if?" affordance
  (R-13), not the route.
- `agent_reflection` **is** in the canvas toolbar
  (`BuilderSidebar.tsx:98` + icon `:120`) — the "missing node type" finding
  is void; dropped.
- The Python SDK **does** run `mypy --strict src/janusly` in CI
  (`ci.yml:168-170`) — "untyped, no mypy" is false. The accurate, smaller
  finding: it returns `dict`/`cast()` shapes rather than typed DTOs
  (R-16), but type-checking is enforced.

### 7.1 Scorecard — the five under-covered axes (v3)

| Axis | Grade | Evidence (verified this pass) |
| --- | --- | --- |
| **Security / tenant isolation** | **Excellent (9–10)** | The strongest axis in the project. All 3 recent repos (metrics/clusters/audit) scope `eq(table.orgId, orgId)`; SSRF DNS-pin covers AWS metadata + redirect re-validation; secrets multi-layer redacted; MCP two-flag write consent; SQL tool parameterized + verb-gated. **Conclusion: do not spend cycles here** — only 3 tiny hardening notes (R-23/24/25). |
| **Data model** | **Good (7)** | 50 tables, clean conventions (id=text, timestamptz, org-scoped). Weak points: `real` for currency (`monthlyUsd`, R-17), `real`-vs-`integer` metric inconsistency, `orgId.default("default")` dev-convenience on 7 tables (hardening, NOT a live leak — R-18), a few missing secondary indexes (R-19), `holdUntil` legal-hold untested (R-20). |
| **API surface as product** | **Fair (5–6) — the real gap** | The loop is world-class internally but the *front door* is incomplete: SDK covers metrics-read only, not the DLQ/recovery loop (R-01); no `/v1` versioning (R-03); `/runs` returns a bare array vs the envelope pattern (R-04); 3 cursor shapes; `/dlq` vs `/dlq/queue` duplication; MCP omits `recovery_items` (R-02); no OpenAPI (deep-review #30). |
| **Latent value ("80% built")** | **Under-captured — highest ROI** | PromptOps registry fully wired but AI routes use hardcoded prompts (zero registry refs — R-05); experiment/A-B harness backend + routes complete with tests, ZERO web UI (R-06); confidence calibration fit + applied but never surfaced (R-07); feedback decay undetected (R-08); vector tools + causal engine routed but no canvas/UI affordance (R-09/R-13). |
| **Frontend performance (measured)** | **Good (7)** | 470 KB gzip is reasonable for the surface area; canvas is already lazy. Opportunities: the 93.8 KB `index` entry is the heaviest chunk (R-21, investigate what's eagerly in it), and `supabase-vendor` 50 KB gzip may load even in dev-header mode where Supabase is unused (R-22, lazy-load auth). |

**The v3 headline:** the previous waves asked "is the recovery loop good?"
(yes, world-class) and "does it feel good?" (Batches A–F). This wave asks
"**can people reach it, extend it, and see it working?**" — and the answer
exposes the highest-leverage under-investment in the codebase: a huge amount
of the "Improve over time" README bet is **built and dark**. Surfacing it is
cheaper than building anything new.

### 7.2 New proposals (R-series) — verified, deduplicated

Only genuinely-new items (deduped against P/Q/M/deep-review). Each carries
verified file:line evidence. Full specs on promotion.

#### Tier ★ — the front door + the dark loop (highest ROI)

**R-01 — SDK covers the recovery loop end-to-end (L) ★.** `sdk-node`
(`client.ts`) binds only Runs/Reports/Recovery(metrics-read)/Webhooks — no
`dlq.list/clusters/replay/bulk-replay`, no `recovery.items.*`, no
`patch/validate`. The wedge is undersold by its own SDK; operators mix
SDK+REST+MCP. Add `client.dlq` + `client.recovery` resources (list → cluster
→ patch → validate → replay → rollback), mirror in `sdk-python`, strict-mirror
types. Composes: R-03 (version it), R-11 (examples).

**R-02 — MCP exposes recovery_items (M) ★.** `mcp-server/tools.ts`
advertises ~20 read tools but NO `recovery_items.*` (the incident
abstraction: triage/acknowledge/escalate/assign/resolve — 13+ API endpoints
exist). The LLM sees dead letters but not incidents. Add read + write tools
(writes behind `guardMcpWrite`, the existing gate). Composes: M-06 (Slack),
the ownership/handoff flow.

**R-05 — AI routes consume the PromptOps registry (L) ★★ the spine.**
Verified: `promptsRepo` has versioning+pinning+CRUD routes, and the AI
routes (`ai-generate`/`ai-patch`/`ai-explain`/review) reference it **zero
times** — all use hardcoded `ai-prompts.ts`. This is the single biggest
latent asset: PromptOps, per-org prompt overrides (deep-review #19), and the
experiment harness (R-06) are ALL blocked on this one refactor. Design: AI
routes resolve an active prompt version per (org, surface) from
`resolveActiveVersion`, falling back to the hardcoded default; add
`ai.customPromptsEnabled` org-config; audit `ai.prompt.resolved`. Composes:
R-06, deep-review #19, Q-24 (calibration per surface).

**R-06 — Experiment/A-B harness gets a UI (M) ★.** Verified: full backend —
`experiment-runner.ts` + `experiment-scorer.ts` + `experiments-routes.ts`
(`GET /experiments`, `GET /:id`, `POST /run` with control/candidate arms,
scorers, promote/keep recommendation) — all tested, **zero web surface**.
Add `ExperimentsPanel` (list + per-arm score/cost/latency/error tables +
"promote candidate" button wired to the route). Unlocks PromptOps A-B on top
of R-05. Backend-complete = pure frontend ROI.

**R-07 — Confidence-calibration health card (M) ★.** Verified: curves are
fit daily and applied in `ai-patch-route.ts:312` (`applyCalibration`) but
never shown. New read-only `GET /recovery/calibration-status` (per-approach
slope, sample count, accept rate) + a "Model calibration" card in the
Recovery Center. Directly renders the "Improve over time" README bet the
product currently hides. Composes: Q-24 (per-signature curves become the
card's rows), Q-26 (drift flag surfaces here).

**R-08 — Feedback-staleness signal (S) ★.** `summarizePastFeedback` uses a
30-day/100-row window; when it empties, patch confidence silently reverts to
0-shot with no operator signal. Track `feedbackLastSeen` per (org, workflow,
approach); badge "learning paused — no accepted fix in N days" in the
dialog; `GET /recovery/feedback-health`. Cheap, closes the explain loop.

**R-09 — Vector-memory canvas nodes (M) ★.** `vector.search`/`vector.upsert`
are registered tools with schemas + examples but have no canvas affordance —
operators who enable memory can't discover or wire them without hand-editing
JSON. Add distinct `vector_search`/`vector_upsert` node types (not raw
`tool` wrappers) under an "AI Memory" toolbar section, gated on memory
consent. Unlocks semantic-similarity recovery in authored workflows.

#### Tier 2 — API-surface hardening & latent unlocks

**R-03 — API versioning (`/v1`) + deprecation posture (M).** No version
prefix anywhere; the R-04 fix would break SDK consumers silently. Introduce
`/v1` alongside current routes (dual-serve 6–12 mo), deprecation headers, a
policy in docs. Prereq for any breaking change and for OpenAPI.

**R-04 — Envelope-consistency pass (M).** `/runs` returns a bare array;
standardize to `{ runs, nextCursor?, hasMore? }` (the SDK already
defensively handles both — remove the drift). Sweep all list routes for the
envelope + one cursor grammar (folds into Q-22/M-22's filter object). Ship
under `/v1` (R-03).

**R-10 — Run-event drill-down (M).** `run_events.payload` carries rich
bodies (`node.succeeded` duration, `node.failed` signature+retryCount) that
the timeline never parses. Typed payload schema per event kind + a run
"Metrics" card (LLM calls, retries, memory touches, total duration) + inline
`durationMs`/`retryCount` on node rows. Pure observe-bet win over data
already persisted.

**R-11 — DX quickstart: recovery-loop examples + config builders (M).**
`examples/recover-dlq-entries.{ts,py}`, a quickstart that runs the loop, and
typed org-config builders. Cuts time-to-first-successful-call. Composes:
R-01 (the SDK methods it demonstrates).

**R-12 — Error-code catalog completion + i18n backfill (M).** ~80 codes
declared, ~150 distinct error cases emitted across routes; only ~30–40 i18n'd.
Non-web clients get untranslated prose. Audit routes → expand the closed
catalog → backfill EN/ES → add a lint gate (extends Q-33's assertion sweep).

**R-13 — Causal "What if?" UI (S).** The `/causal` route EXISTS
(`runs-routes.ts:709`) but no UI reaches it. Add a "What if?" button on
conditional/skipped nodes in the run timeline rendering the counterfactual
("skipped because <condition> was false"). Route done; pure UI.

**R-14 — Memory transparency: consent countdown + audit trail (S).**
Consent-revocation purge is scheduled 7 days out but never surfaced;
`commitMemory` audits every write but no UI reads them. Add
`GET /memory/consent-status` (enabled + purge-scheduled-for) → Settings
banner + Recovery hero countdown; a "Memory audit" table over
`GET /audit?action=memory.*`. Operator transparency, ~little code.

**R-15 — Agent-recall observability (S).** The agent loop recalls episodes
and injects them but emits no signal; operators can't tell memory shaped a
route. Emit `agent.memory.recalled` (count + top-match fingerprints) →
subtle run-timeline note. Closes the explain bet for agent decisions.

#### Tier 3 — data-model & hygiene (mostly S)

**R-16 — Python SDK typed DTOs (M).** mypy IS enforced, but the client
returns `cast("dict", …)` shapes; hand-code or generate `TypedDict`/
`@dataclass` DTOs mirroring `sdk-node/types.ts` for real inference. (Not the
false "no mypy" claim — this is the accurate, smaller version.)

**R-17 — Currency as `numeric` (M).** `workflowBudgets.monthlyUsd` is
`real("monthly_usd")` — IEEE-754 float for money → non-deterministic budget
comparisons. Migrate to `numeric(12,2)`. (Keep `real` for pure-math curve
slopes; standardize the 0–100 metrics like `confidence`/`acceptRate` to a
consistent representation while touching it.)

**R-18 — Drop `orgId.default("default")` (M, hardening not a fix).** 7
tables carry the dev-convenience default. Security verified there is NO live
cross-tenant leak (every insert passes orgId, every read scopes it), so this
is defense-hardening, not a vuln: remove the default so a future careless
insert fails loudly instead of silently bucketing into a shared org.
Coordinate with the e2e "default" org fixture.

**R-19 — Secondary-index pass (S).** `run_nodes(runId, startedAt, nodeId)`
for the recovery-evidence timeline sort (the unique `(runId,nodeId)` can't
carry `startedAt`); `recovery_items(orgId, workflowId, status, slaTargetAt)`
for "open incidents by SLA for workflow X". Evidence-gate like Q-11 (EXPLAIN
before/after in the PR).

**R-20 — Legal-hold test coverage (S).** `holdUntil` on
`run_events`/`usage_events`/`audit_logs` gates retention deletes but no test
proves a future hold blocks the purge — a silent-compliance-break risk on
refactor. Add the assertion to `retentionRepo.test.ts` (+ integration case).

**R-21 — Entry-chunk slimming (S, measure-first).** The 93.8 KB-gzip `index`
entry is the heaviest chunk. Profile `manualChunks` output; split shared
non-critical code (schemas 17.9 KB gzip is already separate — find the next).

**R-22 — Lazy-load Supabase auth (S).** `supabase-vendor` is 50 KB gzip;
verify it isn't eagerly imported in dev-header mode (where Supabase is
unset). Dynamic-import the auth client behind the production-auth branch.

**R-23/24/25 — Security hardening notes (S each).** (23) Audit resume-token
*successes* too (today only failures) for forensics. (24) Optional per-org
resume-token TTL (<7d) config for high-security tenants. (25) Add a
`janusly_rate_limit_degraded_buckets` gauge (folds into Q-06's metrics
work). None are vulnerabilities — the axis is already excellent.

---

## 8. Unified master backlog — the single execution list

Three analysis waves produced five proposal series across three docs:
**P-01..P-35** (`20260706-world-class-audit.md`), **deep-review #1..#30**
(`20260702-deep-review.md`), and **Q / M / R** (this doc). The second
iteration needs ONE scored, deduplicated, sequenced list. This is it.
Where any prior "recommended order" conflicts, **§8 wins.**

> **SUPERSEDED IN PART — read `20260706-fourth-wave-audit.md` §4–§5 first.**
> A fourth (full-Fable) wave audited the authoring + observation + web-arch +
> engine-vocabulary axes and ran an adversarial red-team of THIS backlog. It
> found five confirmed correctness bugs (a new **Tier −1** that precedes
> everything), nine plan corrections **C-1..C-9** (including that Q-01/Q-04 as
> spec'd each convert their bug into a worse one, and that Q-08's "no pub/sub"
> claim is false), and that §8.2 silently dropped ~17 live P-items (C-6). The
> **corrected Tier-0 lives in fourth-wave §5** and supersedes §8.1 below.
> §8.2's theme backlog remains valid; apply C-1..C-9 before promoting.

**Scoring:** each item is Impact (wedge/love/trust/adoption, 1–5) × Effort
(S=1, M=2, L=3) → a rough priority. ★ marks wedge-critical. Items already
shipped (P-01..P-03/05, P-16..P-30 partial, ENG-267..283) are excluded.

### 8.1 Tier 0 — "if you do nothing else, do these ten"

The highest impact-per-effort across all series, in execution order:

1. **Q-01 ★ — enforce node `timeoutMs`** (S). The platform must out-reliable
   the workflows it recovers; today a hung node waits for the 5-min reaper.
2. **R-05 ★★ — AI routes consume the prompt registry** (L). Unlocks PromptOps,
   per-org prompts, and the experiment harness in one refactor — the biggest
   dark asset in the codebase.
3. **R-07 ★ + R-08 ★ — surface calibration health + feedback staleness**
   (M+S). Make the "Improve over time" bet visible; the loop already runs.
4. **Q-13 ★ — cluster-recovery celebration** (M). The loudest silent moment
   becomes the proudest; market scan confirms no rival celebrates recovery.
5. **M-08 ★ — "suspect version" change correlation** (S). "What changed?" is
   the first RCA question in every incident tool; `computeWorkflowDiff` +
   version timestamps make it nearly free.
6. **Q-08 ★ — Redis cache-invalidation bus** (M). The scale-out unlock; the
   recovery-metrics product must not show stale numbers after a recovery.
7. **R-06 ★ — experiment harness UI** (M). Full backend, zero UI — pure ROI,
   composes on R-05.
8. **M-01 ★★ — redrive from the failed node on the patched version** (M/L).
   The last mile of the wedge; no competitor has the full chain.
9. **R-01 ★ — SDK covers the recovery loop** (L). Stop underselling the wedge
   through the SDK; the front-door gap.
10. **Q-31 ★ — adopt Biome** (M). Do it early — every later diff benefits;
    ~103k LOC with zero linter today.

### 8.2 Full backlog by theme (scored, deduped)

Each row: id · title · size · impact · notes/composes. Sorted within theme
by priority. `[shipped-adjacent]` = extends merged work.

**A · Platform trust (correctness the recovery product needs):**
Q-01 ★ S · Q-02 (atomic replay) S/M · Q-03 (statement timeout) S ·
M-04 ★ (transient auto-retry tier) S/M · M-19 (run-level deadline) S ·
Q-05 (upstream backoff) M · Q-04 (schedule dedup) M · Q-36 (engines field) S.

**B · The dark loop made visible (Improve-bet, highest latent ROI):**
R-05 ★★ L · R-06 ★ M · R-07 ★ M · R-08 ★ S · R-15 (agent recall) S ·
R-10 (run-event drill-down) M · deep-review #19 (per-workflow prompts,
now unblocked by R-05) · deep-review #20 (eval auto-harvest).

**C · Drama of recovery + love layer (wedge UX):**
Q-41 (celebration primitive) S · Q-13 ★ M · Q-19 ★ S · Q-15 ★ S · Q-14 ★ M ·
Q-38 ★ (all-clear) M · Q-16 (optimistic replay) M · Q-39 ★ (impact ledger) M ·
Q-40 (personal wins) M · Q-18 (one formatter) S · Q-20 (chart interactivity) M ·
Q-21 (demo momentum) S · P-22 (weekly digest — market-validated) M.

**D · Meet operators where they live (adoption, market-driven):**
M-07 ★ (alert carries the fix) S · M-08 ★ (suspect version) S ·
M-09 ★ (self-heal alert hold) S · M-06 ★ (Slack — phased S→M→L) L ·
R-02 ★ (MCP recovery_items) M · deep-review #6 (postmortem generator —
market-validated) M · deep-review #27 (status page + audiences) M.

**E · Scale-out truth:**
Q-08 ★ M · Q-09 (LRU) S · Q-10 (generated cols) M · Q-12 (CORS memo + BRIN) S ·
Q-11 (index evidence pass) S · Q-06 ★ (queue metrics + R-25 gauge) M ·
Q-17 (coalesce fan-out) M.

**F · Wedge metrics + AI flywheel:**
Q-22 ★ (time-to-first-action + ack-rate) M · Q-23 ★ (recurrence) M ·
Q-24 ★ (signature calibration) M/L · Q-25 ★ (success-weighted exemplars) M ·
M-10 ★ (playbooks + success analytics) M · Q-27 (cache/BoN telemetry) S ·
Q-26 (calibration drift) M · Q-28 (recall quality knobs) M · Q-29 (schema retry) S.

**G · Completeness bets (after E/F):**
M-02 ★ (canary ramp + auto-rollback) M · M-01 ★★ (redrive) M/L ·
M-03 ★ (circuit breaker + buffer + backfill) M/L · M-05 ★ (replay campaigns) M ·
M-22 (filter grammar — inside M-05) M · M-13 (payload surgery) M ·
M-17 (on-error edges) M/L · M-18 (fan-out failure budget) M/L.

**H · The front door (API-as-product, adoption):**
R-01 ★ L · R-03 (versioning) M · R-04 (envelope pass) M · R-11 (DX examples) M ·
R-12 (error-code + i18n) M · R-16 (Python DTOs) M · deep-review #30 (OpenAPI) L.

**I · Latent unlocks (small, delightful):**
R-09 ★ (vector canvas nodes) M · R-13 (causal What-if) S · R-14 (memory
transparency) S · P-27-adjacent (solution-pack onboarding surface) M ·
M-14 (ops copilot / NL filter) M · M-15 (recommendations inbox) M ·
M-16 (SQL introspection) S · M-11 (reasoning transparency) M · M-12 (janusly.md) S ·
M-20 (NL edits + diff) S/M · M-21 (selective hunk apply) M.

**J · Hygiene & data-model:**
Q-31 ★ (Biome) M · Q-32 (data-repo tests) M · Q-34 (split http-policy) M ·
Q-37 (drizzle upgrade spike) S/M · Q-33 (payload assertions) M · Q-35 (route
fixture) M · R-17 (currency numeric) M · R-18 (drop orgId default) M ·
R-19 (secondary indexes) S · R-20 (legal-hold test) S · R-21 (entry chunk) S ·
R-22 (lazy Supabase) S · R-23/24/25 (security notes) S · P-06 (scim TTL) S ·
P-07 (retention batching) S · P-10 (templates.json) M · P-14 (usePanelFetch) M.

**Watchlist (monitor, don't build):** computer use / Autopilot;
BYO-agent-framework interop; durable LLM token streams; live activity
operations mid-failure. (Rationale in §6.2 watchlist.)

### 8.3 How to run the second iteration

1. Promote a Tier-0 item to a new `ENG-284+` row in `docs/ROADMAP.md` §3c
   (next free id **ENG-284**), copying its spec block here as the AC.
2. Ship via `janus-ship` (or direct) with the standard gates:
   `pnpm build`/`pnpm test` + `pnpm test:integration` for DB work +
   typescript-react-reviewer/node review + UI-smoke for UI/DB tickets.
3. Each spec block already cites the exact files/signatures/DDL/i18n keys —
   re-verify the one or two claims marked "verify" in the AC before coding
   (the discipline that kept this document hallucination-free).
4. Batch commits; ONE push at the end of a session (private repo).

**The through-line across all three waves:** Janusly's recovery loop is
genuinely world-class and genuinely unique in the market — the work is not
to invent a new wedge but to (1) make the platform *trustworthy* enough to
carry it (Batch A), (2) make the operator *feel* it working (Batch C) and
*see* it learning (Batch B — the dark loop), (3) let people *reach and
extend* it (Batch H — the front door), and (4) *complete* it where rivals
can't follow (Batch G — redrive + canary + Slack). Everything else is
fluency on a thesis that already holds.

> §9 below (fourth wave) amends this section: see §9.6 for spec
> corrections to Q-01/Q-02/Q-04/Q-06/Q-08/Q-24/M-01/M-02/M-05/M-17/
> Q-31/R-01/R-05 and §9.7 for **Tier-0 v2**, which supersedes §8.1.

---

## 9. Fourth wave — deep product audit + adversarial plan review (2026-07-06)

Five parallel passes on the axes waves 1–3 never went deep on: **workflow
authoring** (the canvas/builder), **run observation** (timeline/triage/live),
**web architecture & CSS** (measured, not opined), **the engine as a
product** (execution vocabulary vs the README's target workflows), and —
new for this wave — an **adversarial red-team of the master plan itself**.
Every load-bearing claim below survived a batch verification against the
code (8/8 critical claims confirmed verbatim, including four live
correctness bugs); the red-team's own spot-checks found 4 of 5 sampled
"Spec (verified)" blocks exact and one false claim (fixed in §9.6).

**The wave-4 headline:** the four *product-core* axes scored the LOWEST of
any axis in any wave — authoring onboarding **3/10**, triage-speed **3/10**,
expression-power **3/10**, CSS organization **4/10** — while the underlying
data/backend for most of it already exists. The recovery loop is
world-class; the *daily product around it* (build a workflow, watch a run,
understand a failure without the DLQ) is where a design partner would
actually feel pain first. Wave 4 rebalances the plan accordingly.

### 9.1 Scorecard v4 — the product-core axes

| Axis | Score | One-line verdict |
| --- | --- | --- |
| Authoring: config ergonomics | 4/10 | Readiness demands `retry`/`timeoutMs` no editor can produce (F3); http quick-config exposes only `url`. |
| Authoring: canvas interactions | 4/10 | No drag-drop, no minimap, click-add lands nodes off-viewport, layout wiped on reopen (F2/F11). |
| Authoring: feedback loops | 5/10 | Validation issues aren't navigable; edge/workflow issues render nowhere (F5). |
| Authoring: onboarding | 3/10 | Unsaveable drafts + 5 silent canvas-wipe paths + dead Help buttons + `multi_agent` as the first-run sample (F1/F12). |
| Observation: live fidelity | 6/10 | SSE+rAF is genuinely good; but "Live" shows on dead runs, status text stales mid-run, catch-up truncates silently (O-08/O-09). |
| Observation: triage speed | 3/10 | `errorJson`/`attempts` on the wire, never rendered; every open-run path lands on an empty multi-agent tab (O-01/O-02). |
| Observation: long-run + waiting | 3–4/10 | No search/filter/jump-to-failure; waiting cards name the node, not the wait (O-07/O-11). |
| Web: CSS architecture | 4/10 | Token discipline excellent (0 raw hex, 10 `!important`); organization decayed — 47 real sections vs 24 mapped, one 3,646-line section, ~400 lines dead (W-02/W-03). |
| Web: component structure | 5/10 | One mutation template ×14 in App.tsx → 40-prop RightPanel; 12 hand-rolled dialogs, focus trap in 1 (W-04/W-05). |
| Web: state discipline | **8/10** | store.ts genuinely clean — documented invariants, scoped selectors, coalesced bump. Healthy. |
| Web: type health | 6/10 | Only 3 `as any` (ratchet healthy) — but 754 vestigial `t() as string` casts (W-01). |
| Engine: node vocabulary | 5/10 | Broad surface, but the batch primitive doesn't execute work (E-02) and the multi-branch primitive doesn't route (E-06). |
| Engine: expression power | 3/10 | 8 comparators, no string/date ops, silent `""`/NaN failure modes (E-04/E-10/E-11). |
| Engine: tool coverage / composition | 5/10 | Agent planner sees 3 of 31 tools (E-05); subworkflows unpinned + lossy errors (E-08). |

### 9.2 Batch 0 — confirmed bugs, fix before anything else

All verified against code this session. Small, surgical, high-trust.

| id | Bug (verified evidence) | Fix | Size |
| --- | --- | --- | --- |
| **B-01 ★★** | **Trigger/run input never reaches templates.** Scope is `{ context, inputs: node.config }` (`execute-node.ts:63-66`); `getRunContext` returns per-node rows only; yet `triggers.ts:68` *documents* `ctx.context.input` and line 73 reads it — always `{}` in production. Trigger ingest starts runs with `input: { event: payload }` that no downstream node can see. Unit tests mask it (pass context directly); sandbox masks it (seeds trigger outputs) — so validation SHOWS the event flowing while production drops it. "When an email arrives, classify it" — a README flagship — cannot read the email. | Merge run `input` (reserved key, collision-checked in workflow-validation) into the context `getRunContext` returns; expose `{{input.*}}` in template+expression scopes; un-mask the tests; align `sandbox-run.ts:44-48` docs. | M |
| **B-02 ★** | **`router`/`router_llm` decide but never route.** Runtime records the decision and marks the node succeeded (`runtime.ts:172-193`); nothing consumes `chosenNodeId` (verified: zero refs); `enqueueReadyNodes` queues ALL successors. The canonical AI-prompt example (`ai-prompts.ts:60`) wires candidates with NO incoming edges, so both execute from t=0, every run — double cost + double side effects. | After decide, mark non-chosen candidates `skipped` (the status already exists for condition edges); validation rule: router candidates must be wired router→candidate; fix the prompt example. | M |
| **B-03** | **Edge-condition editor corrupts data.** The edge textarea is uncontrolled with NO `key` (`InspectorPanel.tsx:167-173`, verified verbatim); selecting edge A then B shows A's text, and blur writes A's stale condition into B. Bonus: `jsonError` never resets on selection change. | `key={selectedEdge.id}` (one line); clear `jsonError` on selection change. | S |
| **B-04** | **Edge conditions evaluate with `inputs: {}`** (`runtime.ts:378`, verified) while the published grammar advertises `inputs.` paths — such conditions silently never fire. | After B-01: pass run input as `inputs` on edge evaluation; until then, reject `inputs.` in edge conditions at validation. | S |
| **B-05** | **Status bar renders hardcoded `queue: 0`** (`App.tsx:730` → `:999`, verified) — a permanent fake stat in a reliability product. | Delete the segment now (honest UI); re-wire when Q-06 ships. | S |
| **B-06** | **Every open-run path lands on the multi-agent tab** — empty for ordinary runs (`App.tsx:463` default `'multiAgent'`, verified; Recovery tiles' `onOpenTab('runs')` is overridden because `openRun` sets the tab *after* its await). | Default to `'runs'`; route to multiAgent only when events contain `multi_agent.*`; set tab before await. | S |
| B-07 | Sign-out logic duplicated inside App.tsx (`:262-270` vs `:961-969`) — paths already diverge on `fireSignOut`. | Pass the one callback. | S |
| B-08 | Build stamp `2026.05.14-90f3a77` hardcoded twice (`App.tsx:1019`, `UserMenu.tsx:49`), 7 weeks stale. | Vite `define: __BUILD_ID__` from git sha; consume in both. | S |
| B-09 | `tenantAwareTools` drift: `pdf.generate`/`vector.*` get tenant config via the agent path but NOT via `tool` nodes (`node-registry.ts:490-501` hard-coded set) — per-tenant object-store/rate-limit silently ignored on one path. | Always pass the (cached) snapshot; delete the set or make it a registration flag. | S |
| B-10 | Dead affordances: Help/What's-new buttons with no onClick (`BuilderSidebar.tsx:584-589`); ⌘1/⌘2 displayed but unbound; "Docs" button = "docs unavailable" toast. | Wire Help→shortcuts modal/cheatsheet; bind ⌘1/⌘2; hide Docs. | S |

### 9.3 F-series — authoring (the builder half of the product)

Compact statements; full evidence in the wave-4 transcript. All dedupe-
checked against P/Q/M/R/deep-review.

- **F-01 ★ Draft safety (S/M):** invalid drafts are unsaveable
  (`App.tsx:380-381` validate-gate on save); no `beforeunload`; five paths
  silently replace the canvas while `currentWorkflowSaved` exists unused.
  Fix: draft-status save (bypass validity), one `useConfirm` on all
  hydrate/new call sites, `beforeunload`, bind Cmd/Ctrl+S.
- **F-02 Layout persistence (M):** `graphToWorkflow` serializes
  `{id,type,config}` only; `hydrateWorkflow` re-lays out on a grid; added
  nodes land off-viewport. Fix: `ui.positions` block in `dagJson` (engine
  ignores unknown keys) + `screenToFlowPosition` placement.
- **F-03 ★ Resilience fieldset (M):** readiness fails
  `external_node_missing_retry` and points at `config.retry.maxAttempts` —
  which NO editor exposes (http quick-config = `url` only). The AI can
  patch `retry`; the human can't author it. Fix: shared Resilience fieldset
  (retry/backoff/timeout) for http/tool/agent/mcp_tool + method/headers for
  http; readiness suggestion deep-links to it.
- **F-05 Navigable problems list (M):** edge/workflow validation issues
  render nowhere; no issue is clickable. Fix: Problems list → click selects
  node/edge + opens inspector; project `hasValidationError` onto edges.
- **F-06 Expression help for humans (M):** the grammar is published to the
  LLM (`expression.ts:12-16`) and to no human. Fix: cheatsheet + clickable
  upstream-node path inserter under condition/edge/mapping fields;
  validate-on-blur.
- **F-07 Typed I/O editor (M):** `inputs`/`outputs` are only ever set by
  AI/template hydration; the polished R
