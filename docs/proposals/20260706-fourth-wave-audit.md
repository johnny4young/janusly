# Fourth-wave audit — the other half of the product + an adversarial pass (2026-07-06)

Full-Fable audit. The first three waves went deep on the recovery loop,
performance, security, data model, API surface, and latent value. This wave
covers what they left in shadow — the **authoring** experience (canvas /
builder / AI Studio), the **run-observation** experience (timeline /
inspector / live streaming), **web architecture & CSS**, and the **engine's
execution vocabulary** as a product — plus a first **adversarial review of
the master plan itself** (red-team of `20260706-second-wave-audit.md` §8).

**Method.** Five parallel Fable explorers, each self-deduplicating against
the ~120 live proposals in the three prior docs (P / deep-review / Q / M / R),
then a **claim-verification batch** against `main` today. Verification
CONFIRMED the headline correctness bugs below and corrected the plan's own
Q-08 "verified" claim (see §4). Baseline unchanged: `main` @ `bcccbb5`,
3,688 unit tests, next free id **ENG-284**.

**Why this wave matters most:** the prior waves asked "is the recovery loop
good, felt, visible, reachable?" This one found that **the two things
surrounding the loop — building a workflow and watching it run — score 3–5
out of 10**, that the engine **silently drops trigger input in production**,
and that the master plan's own #1 and top-correctness tickets each contain a
design flaw. An operator who can't build confidently or read a failed run
never reaches the world-class recovery loop at all.

---

## 1. CONFIRMED correctness bugs — verified against code today

These are not proposals; they are defects with reproduction paths verified
this session. Ranked by blast radius. Each is a candidate for an immediate
fix ticket ahead of any feature work.

### B-01 — Trigger input is dropped in production ★★★ (S to fix, huge impact)
**Verified:** `execute-node.ts:62-66` builds the template scope as
`{ context: getRunContext(runId), inputs: node.config }`. `getRunContext`
(`persistence.ts:508-538`) reduces `run_nodes` rows into a map keyed **only
by nodeId** — it never reads `runs.inputJson` and never adds a
`context.input` key. Yet `triggers.ts:73` reads `ctx.context.input` and its
docstring (`persistence.ts:68`) claims *"the engine plumbs `input` onto
every node's context as `ctx.context.input`"* — **false**. So in a real run
`email_received` / `file_dropped` / `mcp_server_event` executors return
`event: {}`; `trigger-ingest-routes.ts:189` starts the run with
`input: { event: payload }` and the payload never reaches a downstream node.
The bug is masked two ways: unit tests pass `{ input: { event } }` directly
as context (`triggers.test.ts:45`); sandbox validation seeds trigger outputs
from the input (`adapters/sandbox-run.ts:99-102`), so **validation shows the
event flowing while production drops it** — the worst possible masking for a
recovery product. **Impact:** the README's flagship "when an email arrives,
classify it" workflow cannot read the email; every trigger-driven workflow
(the event-driven half of the product) is broken in prod.
**Fix:** merge the run's `inputJson.input` into the context returned by
`getRunContext` under a reserved `input` key (collision-checked in
`workflow-validation.ts`), expose `{{input.*}}` in template + expression
scopes, delete the false docstring, and add a NON-sandbox integration test
that asserts a trigger payload reaches a downstream node. Composes with
E-11 (edges also get the real `inputs`).

### B-02 — `router` decides but never routes; both branches execute every run ★★ (M)
**Verified:** the router branch records a `decision` and marks the node
succeeded (`core/runtime.ts:172-193`); the only `node.skipped` writes
(`runtime.ts:113/127/383`) are for binary `condition` "Condition not met",
never for router losers — nothing consumes `chosenNodeId`. And the AI's own
canonical example (`ai-prompts.ts:60`) gives candidates `fast_path` /
`accurate_path` **no incoming edges**, so `startRun`'s root-node scan queues
both at t=0. **Impact:** the only multi-way branch primitive (condition is
binary) is decorative — every generated router workflow runs all branches,
doubling cost and side effects, silently. **Fix:** after `decide()`, mark
non-chosen candidate nodes `skipped`; validation requires candidates wired
as router successors (edge router→candidate); fix the AI prompt example to
include those edges. (Note: this touches fan-in readiness — coordinate with
the failure-path precedence note in §4.)

### B-03 — Edge-condition editor writes one edge's condition into another ★ (S, one-line fix)
**Verified:** `InspectorPanel.tsx:167-173` — the edge textarea is
uncontrolled (`defaultValue={selectedEdge.data?.condition}`) with **no
`key`**, unlike the node JSON textarea which is keyed (`:139`). React reuses
the DOM node across selections: select edge A then edge B → B shows A's text,
and the blur-commit writes A's stale condition onto B. **Impact:** silent
edge-condition corruption in the product's own builder — precisely the
failure class Janusly exists to recover from. **Fix:** `key={selectedEdge.id}`
on the textarea; also clear `jsonError` when `selectedNode?.id` changes
(the error banner currently persists across selections, `:53/155`).

### B-04 — Edge conditions evaluate with `inputs: {}` while the grammar advertises `inputs.` (S)
**Verified:** `core/runtime.ts:378` — `evaluateExpression(edge.condition,
{ context, inputs: {} })`; the published grammar (AI prompt, `ai-prompts.ts:53`)
documents `inputs.` paths. An edge condition on `inputs.priority` is always
undefined→falsy, so the branch silently never fires and grammar validation
can't catch it. **Fix:** after B-01, pass the run input as `inputs` on edges
(one scope everywhere); until then, reject `inputs.` in edge conditions at
validation with a clear message.

### B-05 — `{{env.*}}` is templatable into outbound request bodies by any tenant author ★ (M, security)
**Verified:** `template.ts:103-125` resolves `{{env.NAME}}` to
`process.env[NAME.toUpperCase()]` for any author; redaction protects
*persistence* only, not the outbound `http.request` body. A tenant author
can template `{{env.DATABASE_URL}}` (or any worker env var) into an HTTP POST
to their own server and exfiltrate it. **Impact:** cross-tenant / infra
secret exposure on a multi-tenant platform. (The security wave scored
isolation 9.5 but scoped to DB predicates + SSRF + persistence redaction —
it did not cover template-time env resolution into request bodies.) **Fix:**
gate `{{env.*}}` behind an org-config allowlist of permitted env-var names
(default empty); keep `{{secret.X}}` (credential-scoped) as the sanctioned
path. Coordinate with E-12's per-org secret store (§3).

### B-06 — The status bar shows a hardcoded fake "queue: 0" (S, trust)
**Verified:** `App.tsx:730` `const queueCount = 0` feeds the status-bar
`t('statusBar.queue', { queue: queueCount, dlq })` at `:999`. **Impact:** a
reliability product displays a permanently false reliability stat.
**Fix:** delete the queue segment until Q-06's gauge exists, or wire it to
Q-06. One line either way. (Also: build stamp `2026.05.14-90f3a77`
hardcoded in two places, `App.tsx:1019` + `UserMenu.tsx:49`, 7 weeks stale —
fold into the same honesty pass.)

**These six are the "make the existing thing honest" set — all S except
B-02/B-05 (M) — and should precede feature work; a demo where the router
runs both paths, the trigger can't read its event, or the builder corrupts a
condition is unshippable regardless of how good the recovery loop is.**

---

## 2. Scorecard v4 — the newly-audited axes

| Axis | Grade | Evidence |
| --- | --- | --- |
| **Authoring — config ergonomics** | **4/10** | Most node types get real editors, but http exposes only `url` while readiness demands `retry`/`timeout` the UI can't produce (S-series); type-change silently wipes config; steps can't be named. |
| **Authoring — canvas interactions** | **4/10** | No drag-from-palette (click-only), no minimap, zoom clamped 0.45–1.35, manual layout thrown away on reopen, no copy/paste, on-canvas palette only on one tab. |
| **Authoring — onboarding** | **3/10** | First run drops a non-technical operator onto a `multi_agent` step; dead Help/What's-new buttons; a half-built draft is unsaveable and unprotected (no `beforeunload`, no Cmd+S). |
| **Observation — triage speed** | **3/10** | `errorJson`, `attempts`, `startedAt`, `inputJson`, `traceId`, `wakeAt` are all on the wire and dropped at the web type boundary; "open run" lands on an empty multi-agent panel. |
| **Observation — live fidelity** | **6/10** | SSE + rAF coalescing + Live-chip-with-age are genuinely good; but status text goes stale mid-run, the canvas is hidden while watching, reconnect can silently hole the timeline. |
| **Observation — long-run & waiting clarity** | **3–4/10** | Flat unvirtualized event list, no in-run search/jump-to-failure; approval/webhook/timer pauses show only a node id (no reason, no since, no wake time, no approver). |
| **Engine — expression power** | **3/10** | Dot-paths + 8 comparators only; no string/date/arithmetic ops; `>`/`<` on strings compares NaN silently; missing paths render `""` with no event (B-04, E-10). |
| **Engine — node vocabulary** | **5/10** | Broad surface but `loop` can't do work per item (no dynamic fan-out), `router` doesn't route (B-02), approvals can hang forever, agent planner sees 3 of 31 tools. |
| **Web — CSS architecture** | **4/10** | Token discipline excellent (0 raw hex, 10 `!important`); organization decayed: ~400 lines dead CSS, section map is fiction (24 declared / 47 real), one 3,646-line append-only section, no CSS gate. |
| **Web — component structure** | **5/10** | Good code-splitting; but App.tsx pastes one mutation template ~14× into a 40-prop RightPanel; 12 hand-rolled dialogs with a focus trap in exactly one. |
| **Web — state discipline** | **8/10** | store.ts (463 lines) is genuinely clean — scoped selectors, coalesced bump, no misplaced server cache. The bright spot. |
| **Plan robustness (red-team)** | **specs strong, plan weaker** | 4 of 5 sampled Q "verified" blocks exact; but Tier-0 ordering contradicts the doc's own composes-notes 3×, "single deduped list" silently drops ~17 P-items, and Q-01/Q-04 each convert their bug into a worse one (§4). |

**The v4 headline:** the recovery loop is world-class; the two experiences
that gate access to it — **authoring** (avg 3.7/10) and **observation**
(avg 4/10) — are the weakest surfaces in the entire product, and the fix is
overwhelmingly **frontend wiring against data the backend already
persists**. This is the highest-ROI, lowest-risk work available.

---

## 3. New proposal series (verified, deduped)

Long tails in tables; headline items in prose. Full specs on promotion.

### 3A · Authoring (S-series)

**S-01 — Draft-safe authoring: save-with-warnings + unsaved guard + Cmd+S (S/M) ★.**
An invalid draft is unsaveable (`App.tsx:380`), no `beforeunload` exists,
and 5 paths replace the canvas without confirm while `currentWorkflowSaved`
already tracks the signal. Save drafts (`status:'draft'`) bypassing the
validity gate; `useConfirm` on all hydrate/new call sites when unsaved;
`beforeunload`; bind Cmd/Ctrl+S in `useKeyboardShortcuts.ts`.

**S-02 — Shared "Resilience" fieldset for http/tool/agent/mcp_tool (M) ★.**
Readiness fails production with `external_node_missing_retry` and suggests
`config.retry.maxAttempts`, but no editor produces `retry`/`timeout`/
`headers`/`method` — only the Advanced-JSON `<details>`. One reused
fieldset; the readiness suggestion deep-links to it. Closes the gap where
the AI can patch `retry` but a human author can't set it.

**S-03 — Persist manual canvas layout (M).** `graphToWorkflow` serializes
only `{id,type,config}`; `hydrateWorkflow` re-lays-out on a fixed diagonal
every open. Persist a `ui.positions` block in `dagJson` (engine ignores
unknown keys); place added nodes at viewport center via
`screenToFlowPosition`.

**S-04 — Navigable Problems list (M).** `ValidationIssue.edgeId` and
workflow-level codes render nowhere; readiness/AI-review findings print
`nodeId` as inert text. A compact Problems list where clicking an issue
selects the node/edge + switches to inspector; project validation errors
onto edges too. (Distinct from excluded lint-on-type — this is
display/navigation of existing on-demand results.)

**S-05 — Expression/`{{template}}` human helper (M).** The grammar is
published only to the LLM; the condition/mapping editors are bare textareas.
A shared helper: grammar cheatsheet + a clickable list of upstream node ids
(from the graph) that inserts `context.<id>.output`; validate-on-blur.

| id | title | size |
| --- | --- | --- |
| S-06 | Authorable typed inputs/outputs in the I/O card (unlocks the 700-line RunInputDialog for hand-built workflows) | M |
| S-07 | Step naming (`data.label` field; renderers already prefer it) | S |
| S-08 | Confirm on node-type change (currently silently discards config); carry over shared keys | S |
| S-09 | `subworkflow.workflowId` + `schedule.cron` as smart pickers (app already holds the workflow list; cron→next-3-runs preview) | S |
| S-10 | Drag-from-palette + MiniMap (node-count gated) + Duplicate-step; fix the palette-only-on-copilot-tab bug | M |
| S-11 | Wire dead affordances: Help→cheatsheet, ⌘1/⌘2 bindings, hide Docs until real; reshape the seed sample to `http→condition→approval` | S |

### 3B · Observation (O-series)

**O-01 — Fix the golden triage path (S) ★.** Four small changes that
compound: (1) `openRun` defaults to `'multiAgent'` (`App.tsx:463`) and lands
on an empty panel — default to `'runs'`, route to multiAgent only when the
run has `multi_agent.*` events, set the tab before the await; (2) extend web
`RunNode` with `attempts/startedAt/finishedAt` (dropped at `types.ts:17`)
and render `pickErrorMessage(errorJson)` + "attempt 3/3 · 42s" on the
failed-node card (the error is on the wire, never shown); (3) backfill the
i18n event catalog for every `RunEventType` (core lifecycle renders as raw
`node.succeeded` strings) + a contract test asserting union coverage; (4)
persist `run.succeeded`/`run.failed` rows so a failed run's stored timeline
has a terminal marker (today it ends mid-sentence). This is the observe-bet
front door.

**O-02 — Run header card: identity + cause (M).** `openRun` fetches the full
row (incl. `inputJson`, `traceId`) then discards `data.run`. Show workflow
name/version, status, started/duration, copyable traceId, and the trigger
input behind `<details>` — "the input that caused the failure" is triage
step 2 and is currently invisible.

**O-03 — Cross-run navigation on finished backend (M).** `GET /runs?workflowId=`
and the generic `getRunComparison` repo both exist with **zero** web
callers; comparison is locked inside ReplayLabDialog. Add workflow+status
filters to history and a "Compare with last green" action reusing
`RunComparisonView`. "When did this last work and what changed?" — pure
frontend ROI.

| id | title | size |
| --- | --- | --- |
| O-04 | Timeline tone + timestamps + inter-event deltas (finish the abandoned `toReasoningMessage`/`summarizeRunStatus` in `eventUtils.ts` — zero callers today); de-emphasize queued/status-checked noise | S/M |
| O-05 | Live status patching: `patchRunSummary(runId,status)` from the SSE `run.status` branch + `loadStatus` so the active card/tiles update mid-run (frames are parsed and discarded today) | S |
| O-06 | Waiting clarity: thread approval `config.title/description` into waiting metadata; render waiting-since + `wakeAt` countdown; label wait kind (approval vs webhook vs timer) | M |
| O-07 | SSE robustness: emit a `run-status` frame at connect (stops "Live" on dead runs + wasted stream slots); `catchup-truncated` signal when >500-event catch-up caps (silent timeline hole today) | S/M |
| O-08 | Virtualize the ReasoningPanel event list + in-run text/nodeId filter + "jump to first failure" (flat unvirtualized 1000+ cards on long runs) | M |
| O-09 | Show the canvas beside the runs panel with a pulse on the running node (live status pills exist but are hidden on every run-watching tab) | M |

### 3C · Web architecture & CSS (W-series)

**W-01 — CSS decay gate + dead-code purge (M) ★.** ~400 lines of confirmed-
dead CSS across ~30 class families (each redesign left its predecessor);
the section map is fiction (24 declared / 47 real / "24" used twice / a
3,646-line append-only section); the file is the repo's #1 conflict hotspot
(36% of web commits touch it) with no gate. Delete the dead families; add a
zero-dep `scripts/check-css-classes.mjs` (mirrors the P-32 baseline idiom)
failing CI on new orphans; split along existing banner seams into
`src/styles/*.css` via `@import` (byte-identical output).

**W-02 — `<ModalShell>` with a focus trap (M) ★ a11y.** 12 hand-rolled
`role="dialog"` components; only `ConfirmDialog` traps Tab-focus, so
keyboard users escape 11 modals into the inert background. Extract
`<ModalShell open onClose labelledBy>` from ConfirmDialog's existing trap;
adopt in the other 11 — makes the pending WCAG gate a one-place fix.

**W-03 — Kill the 754 vestigial `t() as string` casts (S).** The i18n types
already return `string` (proven: identical uncast calls compile in 2 files);
754 casts are pure noise the P-32 ratchet doesn't count. One codemod +
extend the ratchet to count `as string`.

| id | title | size |
| --- | --- | --- |
| W-04 | `usePlatformMutation(fn,{success,failure})` — the `try/api/toast/bump/refresh` template is pasted ~14× in App.tsx (the `error instanceof Error` ternary 20×); drops ~200 lines, zero behavior change | M |
| W-05 | Group RightPanel's ~40 props into 3–4 cohesive objects (or a `WorkflowActionsContext`) — kills two parallel prop-drilling chains that already diverge | M |
| W-06 | One `.we-pill` base + `--tone-*` convention (133 names for one rounded-label primitive; 70 `border-radius:999px` blocks); collapse `.panel-card`→`.we-card` | M |
| W-07 | `React.memo(FlowRow)` — WorkflowsDashboard re-renders every row on each filter keystroke (17-useState container, raw `query`) | S |
| W-08 | Honesty pass: dedupe `signOut` (inlined twice in App.tsx), build stamp via Vite `define`, delete fake `queue:0` (= B-06) | S |

### 3D · Engine vocabulary (E-series)

**E-01 — `for_each` execution mode on `loop` (L) ★.** `loop` only reshapes
an array (`node-registry.ts:479`); no node does work per item, yet the AI is
told "use loop for batch/for-each". Refunds and billing-exception batches —
flagship use cases — are inexpressible except by abusing an agent loop
(capped 50 steps). Add a `for_each` mode: a `tool` + per-item `input`
template, bounded concurrency, per-item result/error array. (This is the
prerequisite M-18's fan-out failure budget assumes exists.)

**E-02 — `json.parse` + content-type-gated `output.json` on http (S) ★.**
http `body` is always a string; no tool parses JSON from a string; the docs
themselves demonstrate the silent failure (`docs/nodes.md:342` shows
`...output.body.id` which resolves to `""`). "Call an API, use a field of
the response" is the most common step in every target workflow and silently
produces empty payloads today.

**E-03 — Unresolved-template observability + strict mode (S) ★.** Every
missing path renders `""` with no signal (`template.ts:110`); a typo POSTs
`{"amount":""}` on a *succeeded* run — the worst mode for money workflows.
Emit `template.unresolved_path` run events (dedup per node), surface the
count on the timeline; optional per-workflow strict mode that fails the node.

**E-04 — Agent planner sees all tools (S) ★.** The LLM planner's
`availableTools` is a hardcoded 3-tool list (`agent-planner.ts:72`); the
other ~28 registered tools are invisible though `executeTool` would run
them. Derive `availableTools` from `listTools()` (filter `writeSide` under
dryRun); enrich `ToolSchema` with per-field types from the Zod shape.

| id | title | size |
| --- | --- | --- |
| E-05 | Approval timeout/assignee/escalation (`timeoutMs`/`until` + `onTimeout: fail\|auto_reject\|escalate`); accept `until:<ISO>` on wait_until — an unanswered approval is a permanently stuck run = invisible downtime | M |
| E-06 | Subworkflow: optional `config.version` pin; copy child failed-node `errorJson` into the parent failure (parent shows a shell today); "reattach child" recovery when a replayed child succeeds while the parent sits failed | M |
| E-07 | Expression ops: `contains`/`startsWith`/`matches`/`in` + lexicographic string compare (`>`/`<` compares NaN today, so date/string compares silently fail); update the published grammar | M |
| E-08 | Drop the hardcoded `tenantAwareTools` set (`node-registry.ts:490`) — pdf.generate/vector.* get tenant config via the agent path but `undefined` via the `tool`-node path (a real drift bug); always pass the cached snapshot or add a `tenantAware` registration flag | S |
| E-09 | Per-org encrypted secret store + `credential` option on `http.request` (header presets) — today credentials are just env-var name pointers; onboarding one webhook = env var on every worker + redeploy; adding a coded integration touches ~6 files (composes with B-05) | L |

### 3E · The missing axis — Janusly's own survivability (red-team #15)

Across ~120 proposals in four waves, **nothing** covers the platform's own
operability. Verified: no `LICENSE` file at repo root; zero
backup/PITR/restore proposals; zero load/soak-test tickets (the P-doc
*defers to* a load test that no ticket creates); migrations are forward-only
(no down/rollback); Janusly has no self-incident runbook (M-06/M-15 build
incident tooling for *customers* only). The sharpest framing: **Q-39 sells
"since day one: N failures recovered" as the renewal number while retention
sweeps hard-delete, the schema has no FKs by design, and nothing guarantees
that history survives an operator error or a bad sweep — a durable ledger
with no durability plan.**

| id | title | size |
| --- | --- | --- |
| X-01 | **`LICENSE` file** at repo root (blocks OSS/self-host GTM; the world-class plan's self-host bets assume one) | S |
| X-02 | Documented backup/PITR posture + a restore drill in CI-adjacent tooling + `docs/operations/` runbook (natural host: M-16 phase 1) | M |
| X-03 | Load/soak harness (k6 or similar) that P-09's HNSW and Q-03's pool numbers can actually cite instead of guessing | M |
| X-04 | Self-incident runbook for Janusly itself (the recovery product needs a recovery plan) + migration down/rollback convention | M |

---

## 4. Plan corrections — the adversarial pass applied to §8

The red-team found the *specs* trustworthy (4/5 sampled "verified" blocks
exact) but the *plan* around them weaker. These corrections **supersede**
the affected parts of `20260706-second-wave-audit.md` §8. Apply before
promoting any Tier-0 item.

**C-1 — Q-08's "no pub/sub exists in apps/api" is FALSE (fix the spec).**
Verified: `run-stream.ts` is a Redis pub/sub subscriber hub
(`subscribe(...)`, exactly as AGENTS.md documents). Reuse its tested
ioredis subscribe-mode wrapper rather than a parallel one. And the **worker**
also consumes the org-config cache (`node-registry.ts:132`,
`subworkflow.ts`, `auto-healing-consent.ts`, `memory-purge-scheduler.ts`) —
so an API-only invalidation bus leaves worker replicas (the ones spending
LLM budget on stale AI/budget/memory config) TTL-stale. Decide explicitly:
worker subscribes too (forces the bus below apps/api — an AGENTS.md tension
to resolve) or document org-config invalidation as API-only.

**C-2 — Q-01 as spec'd introduces a double-side-effect (re-scope, re-size).**
`withTimeout` is `Promise.race` — it *abandons*, not cancels. A write-side
node (email.send, db.query.write, http POST) that times out keeps running
and may complete *after* the node is marked failed; the AC then says
"replayable" → the side effect fires twice. Scope Q-01 to plumb an
`AbortSignal` into executors that can honor it (http already has an abortable
dispatcher) **or** exclude `writeSide` nodes from timeout-triggered replay
eligibility. It is **not S** once side-effect safety is in scope.

**C-3 — Q-04's tick-claim outside `startRun`'s tx converts a duplicate bug
into a dropped-run bug.** A crash after the `schedule_ticks` claim commits
but before `startRun` leaves that minute permanently consumed. Fold the
claim into `startRun`'s existing transaction (optional param) or void it in
a catch. AC must add the claim-then-crash case.

**C-4 — Q-24's lookup key has no delimiter (collision).**
`` `${approachLabel}${errorSignature}` `` collides (`retry`+`auth_x` vs
`retryauth`+`_x`) and lets prefix labels shadow the global-fallback row. Use
a nested `Map<approach, Map<sig, curve>>` or a ` `-separated key; add a
collision test to the AC.

**C-5 — Q-06 must not put live queue telemetry on the unauthenticated
`/health`.** `/health` is `skipAuth:true` and its `rateLimiter` block is
deliberately coarse (full snapshot is admin-only, per AGENTS.md's two-tier
posture). Public tier gets `queue: { degraded: boolean }`; the numbers go on
the admin route; the (already-authed) web chip reads admin.

**C-6 — §8 silently dropped ~17 live P-items; two are load-bearing.**
Unshipped P-04/P-08/P-09/P-11/P-12/P-13/P-15/P-18/P-19/P-23/P-24/P-25/P-26/
P-31..P-35 are missing from §8.2. P-04 (bootstrap endpoint) is cited by
Q-17's spec as its server-side complement; P-24 (copy-full-JSON) is refined
in §4 then lost; P-12 (error-envelope) overlaps R-04/R-12. **Action:** §8
must either enumerate each dropped P-item with a "cut" rationale or re-add
it, and resolve P-04-vs-Q-17 (if P-04 ships, Q-17's "one bump → exactly 3
requests" AC is stale).

**C-7 — Failure-path precedence is unspecified across four interception
layers.** M-04 (transient ladder), M-17 (on-error edges), M-03 (breaker +
buffer), and shipped auto-healing all intercept failures before/around the
DLQ with no precedence, while every wedge metric (Q-22 TTFA, Q-23
recurrence, Q-39 ledger, heatmap/streaks) denominates on DLQ arrivals — each
layer silently reshapes the others' numbers. **Action:** one "failure-path
precedence" design note (retry → M-04 → M-17 → M-03 → DLQ → auto-heal) must
precede any of M-03/04/17; each metric spec states which interceptions count.
Also: M-17's on-error edges touch pinned fork/join ALL-AND readiness — that
interaction must be analyzed, not assumed (AGENTS.md: "Don't add a parallel
runtime primitive").

**C-8 — Sizing corrections.** M-02 (canary) is **L** not M (run-router change
on every start path + cohort-split health rollup + new watcher + version
state + UI). Q-22 (TTFA) is **M/L** not M (migration + 3 mutators + UNION
query + compose + tile + EN/ES + both SDK mirrors + integration tests) — same
scope the doc sizes Q-24 at M/L. Q-31 (Biome) full adoption is **L**; only
linter-only is M.

**C-9 — Sequencing fixes.** R-01 (SDK) must follow R-03 (versioning) +
R-04 (envelope) or it ships breaking types that get rewritten at /v1.
M-05 (campaigns) phase 1 = pace/progress/abort around the **existing**
bulk-replay path (`dlq-routes.ts:432+` already ships multi-select bulk
replay); the succeeded-runs cohort moves behind E-01/M-01. M-01 (redrive)
is blocked on Q-02 (atomic transition) — list it as such.

---

## 5. Corrected Tier-0 (supersedes §8.1)

Applying the red-team, the confirmed bugs, and the new axes. **Bugs first,
then trust, then the two access-gating experiences, then the flywheel.**

**Tier −1 — confirmed defects (ship before anything):**
B-01 (trigger input) S · B-02 (router routes) M · B-03 (edge-condition key)
S · B-06/W-08 (honest status bar) S · X-01 (LICENSE) S. These are wrong-today,
small, and non-negotiable.

**Tier 0 — the corrected ten:**
1. **Q-02 ★ — atomic replay transition** (S/M). The live cancel-vs-replay
   race; also unblocks M-01. Promoted above Q-01 per C-2.
2. **Q-01 ★ — node timeout, re-scoped** (M, not S). With AbortSignal /
   writeSide-exclusion per C-2 — the platform-trust ticket done safely.
3. **Q-31-lite ★ — Biome linter-only** (M). First, so every later diff
   benefits; formatter is a separate later ticket (C-8).
4. **O-01 ★ — the golden triage path** (S). Four small wirings that fix
   observe-bet access against shipped data.
5. **S-01 ★ — draft-safe authoring** (S/M). Stop losing authors' work before
   they reach the wedge.
6. **Q-13 ★ — cluster-recovery celebration** (M). The loudest silent moment.
7. **M-08 ★ — suspect-version correlation** (S). "What changed?" nearly free.
8. **R-06 ★ — experiment-harness UI** (M). Full backend, zero UI; independent
   of R-05 (C-6 corrected the false dependency).
9. **Q-08 ★ — cache-invalidation bus, spec-fixed** (M). Reuse run-stream's
   subscriber; decide worker subscription (C-1).
10. **R-07 + R-08 ★ — surface calibration health + feedback staleness** (M+S).
    Make the "Improve over time" bet visible.

**Deliberately demoted from the old Tier-0:** R-05 (prompt-registry, L) —
it's the PromptOps spine but it's an L refactor under the hardest AGENTS.md
invariant (AI-fallback contract) and R-06 doesn't need it (C-6); ship it
early in Batch B but not in Tier-0. M-01 (redrive) — stays a headline bet
but is blocked on Q-02 (C-9). R-01 (SDK) — blocked on R-03/R-04 (C-9).

## 6. How this wave changes the master plan

- **New "make it honest" phase (Tier −1)** now precedes everything: five
  confirmed defects, all small.
- **Two new product-half backlogs** (S-series authoring, O-series
  observation) join the themes in §8.2 — and they're the highest-ROI,
  lowest-risk work in the whole plan (frontend wiring on shipped data).
- **The engine-vocabulary gaps (E-series)** are the honest limit on which
  README workflows actually work today — E-01/E-02/E-03/E-04 (three S + one
  L) make the *existing* vocabulary trustworthy.
- **A survivability theme (X-series)** closes the axis 120 proposals missed.
- **Nine plan corrections (C-1..C-9)** fix real errors in the prior plan —
  including two tickets that would have shipped a worse bug than they fixed.

**Through-line, fourth pass:** the recovery loop is genuinely world-class
and the market confirms it's unique — but a product is the sum of building,
running, watching, and recovering, and three of those four score 3–5/10
while the fourth is a 9. The cheapest path to "world-class and addictive" is
not more recovery features; it's making the surrounding experiences honest
(Tier −1), reachable (O/S-series, on data that already exists), and
trustworthy (E-series), then letting the world-class loop shine through
them. Make no mistake: the loop was never the problem.
