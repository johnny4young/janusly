# Janusly Roadmap

> Tactical ticket pool. Strategic context lives in [`docs/PLAN.md`](PLAN.md). Operational invariants live in [`AGENTS.md`](../AGENTS.md). README is descriptive only — no planning.

This file is the **source of truth** for what is in flight, what shipped, what is blocked, and what is intentionally deferred. The implementer skill (`janus-ship`) picks tickets from §3b among `Pending` and `Partial`. The reviewer skill (`janus-review`) verifies that staged diffs flip Status correctly.

---

## 1. Convention

- **ID:** stable `ENG-NNN`. Once assigned, never renumbered.
- **Title:** short imperative phrase, ≤ 8 words.
- **Status:** one of `Pending`, `Partial`, `Shipped`, `Gated`, `Deferred` (see §2).
- **Priority:** `P0` (urgent / unblocking others), `P1` (next), `P2` (later), `P3` (someday).
- **Phase:** which §11 phase from `docs/PLAN.md` this rolls into (`1`, `2`, `3`, `4`, or `—` for cross-phase / standalone).
- **Scope cell:** one paragraph of acceptance criteria + (when `Partial`/`Shipped`) a `**Remaining:**` or `**Summary:**` line at the end. Patterns ENG-001/002/003 below show the shape.

When this file and `docs/PLAN.md` disagree on a Status, this file wins.

When `AGENTS.md` and `docs/PLAN.md` disagree on an operational invariant, `AGENTS.md` wins.

---

## 2. Status legend

| Status | Meaning | Picked by `janus-ship`? |
| --- | --- | --- |
| Pending | Ready to pick. AC defined. No code yet. | Yes |
| Partial | Scaffolding exists, specific work remains. `Remaining:` line at the end of Scope. | Yes (preferred over Pending — less risk) |
| Shipped | Closed. 2-3 line summary at the end of Scope. | No |
| Gated | Blocked by an external decision (open question, license choice, vendor selection). | No — resolve the gate first |
| Deferred | Punted to a later phase by design. Don't pick. | No |

---

## 3. Tickets

### 3a. Sequencing recommendation

1. **Phase 1 (Foundations for AI scale):** ENG-008..010 + ENG-015 (shipped) → ENG-011..014 (provider abstraction, usage events, MCP server stub, generateObject migration). Quick wins (ENG-016..023) parallel any time — they don't gate phases.
2. **Phase 2 (Workflow expressiveness):** ENG-024 — only after Phase 1 ships.
3. **Phase 3 (Self-learning loop):** ENG-025 — gated on Phase 2.
4. **Phase 4 (Operator-grade ergonomics):** ENG-026 — gated on Phase 3.

A ticket whose `Phase` is later than Phase 1 stays `Deferred` until the prior phase reaches `Shipped`.

### 3b. Active pool

| ID | Title | Status | Priority | Phase | Scope |
| --- | --- | --- | --- | --- | --- |
| ENG-001 | Redact secrets in node output | Shipped | P0 | — | Wrap every executor result with `redactValues` before persistence so `run_nodes.state_json` and `run_events.payload` never contain raw secret values. AC: redaction runs before any DB write; existing rows are not back-filled (out of scope). **Summary:** Closed the security finding "secret values stored in run_nodes.state_json and run_events.payload." |
| ENG-002 | Validate BullMQ job payload | Shipped | P0 | — | BullMQ worker validates `job.data` against `NodeSchema` + `WorkflowSchema` on entry. Poisoned jobs throw `UnrecoverableError` so they go to DLQ instead of retrying forever. AC: validation runs as the first step of the worker handler; bad payloads land in `dead_letters` with a useful reason. **Summary:** No more infinite-retry loops on malformed jobs. |
| ENG-003 | Require editor role on POST /validate | Shipped | P1 | — | The only mutating-shape endpoint without `requireRole`. Promoted to `editor`. AC: anonymous + viewer return 403; editor + admin pass. **Summary:** Closed RBAC gap on validation endpoint. |
| ENG-004 | Cap getUsageSummary scan | Shipped | P1 | — | `getUsageSummary` was an unbounded scan that would OOM the API. Scoped to last 30 days with a 10k-row cap. AC: query plan shows time bound; cap enforced at repo layer. **Summary:** Constant-memory usage summary. |
| ENG-005 | Distinguish saved vs adhoc runs in audit | Shipped | P1 | — | `POST /start` writes `run.started` for saved workflows and `run.started.adhoc` for in-memory ones. Env `JANUSLY_REQUIRE_SAVED_WORKFLOW=true` forbids ad-hoc in production. AC: audit table shows the distinction; production env rejects ad-hoc when flag is on. **Summary:** Audit row + prod kill-switch in place. |
| ENG-006 | Redact secret-shaped keys in audit | Shipped | P0 | — | `audit()` redacts `secret*`/`password*`/`token*`/`authorization*` etc. keys in metadata before persisting to `audit_logs`. AC: round-trip test confirms redaction; key list documented in code. **Summary:** Audit metadata is safe to read. |
| ENG-007 | Bump @supabase/supabase-js to 2.105.0 | Shipped | P3 | — | Routine dep bump; touched both `apps/api` and `apps/web`. AC: `pnpm test` green; no breaking-change touches in our code. **Summary:** Latest supabase-js across the two workspaces. |
| ENG-008 | Formal Drizzle migrations for production | Shipped | P1 | 1 | Today `packages/db/src/schema-management.ts` does idempotent `CREATE TABLE IF NOT EXISTS` at runtime. Production wants versioned, repeatable Drizzle migrations. AC: `pnpm migrate` runs `drizzle-kit migrate` against `DATABASE_URL`; schema bootstrap moves to `migrations/` files; e2e boots Compose, runs migrate, runs the suite. **Summary:** `schema.ts` enriched with TZ-aware timestamps and the full index set; generated `migrations/0000_tranquil_gravity.sql` mirrors the deleted runtime bootstrap at the table/index level. Root `pnpm migrate` and a `waitForPostgres()` step in `scripts/run-e2e.mjs` wire the new flow; API and worker now call `assertMigrationsApplied()` and fail fast against an unmigrated DB. |
| ENG-009 | Lazy load very large run timelines | Shipped | P2 | — | Runs view loads the full timeline up-front. For runs with thousands of events the canvas chokes. AC: timeline paginates / virtualizes; `bumpPlatformVersion()` semantics preserved on terminal state. **Summary:** `GET /run` and `GET /status` now cap `events` at 200 (max 500) and return `eventsCursor` + `eventsHasMore` for older pages; the web store merges polled events by id and adds a `loadOlderEvents` action backed by a "Load older events" button on both Run-events and Multi-agent-timeline panels. Terminal-state `bumpPlatformVersion()` plumbing left untouched. |
| ENG-010 | Vitest browser mode for canvas tests | Shipped | P3 | — | Jsdom can't execute React Flow canvas paths reliably (drag, resize, edge layout). Want Vitest browser mode for canvas-level component tests. AC: a few representative React Flow tests run in browser mode in CI. **Summary:** Local browser-mode pool lives at `apps/web/vitest.browser.config.ts` (`@vitest/browser-playwright()` + headless Chromium) with 6 `<WorkflowCanvas>` tests covering render+counts, click→onNodeClick, fitView dimensions+transform, validation overlay, Controls toolbar, and Background pattern. ENG-015 wires the same suite into CI via the `test_browser` job, closing the "in CI" portion of the AC. |
| ENG-011 | AI provider abstraction (Vercel AI SDK) | Pending | P0 | 1 | Migrate every OpenAI call to the `ai` package + `@ai-sdk/*` providers. Per-request, per-step, per-tenant provider/model selection. Default stays OpenAI; Anthropic and Ollama become tested alternatives. See `docs/PLAN.md` §4 phases A–C. AC: `JANUSLY_LLM_PROVIDER=anthropic` makes AI Studio still work; `parseAiWorkflow` looser is replaced by `generateObject({ schema: WorkflowSchema })` (covered by ENG-014); `mode + aiError` contract preserved across providers. |
| ENG-012 | usage_events instrumentation | Pending | P0 | 1 | Every LLM call writes one row to `usage_events` (org, run, node, provider, model, tokens, latency, cost). AC: row written from a single chokepoint (the new provider abstraction's wrapper); Runs view surfaces tokens + cost per node; cost is computed from a per-model price map (env or table). |
| ENG-013 | @janusly/mcp-server (read-only) | Pending | P1 | 1 | Stand up `packages/mcp-server` with read-only tools: `workflows.list`, `workflows.get`, `recipes.list`, `tools.list`, `runs.get`. Boot via `pnpm --filter @janusly/mcp-server dev`. AC: Claude Desktop can discover and call these tools against a local instance; auth uses dev headers or service-token mode; org scoping enforced. |
| ENG-014 | generateObject replaces parseAiWorkflow looser | Pending | P1 | 1 | Replace `parseAiWorkflow`'s shape-coercing looser with `generateObject({ schema: WorkflowSchema })` from the Vercel AI SDK so the model returns a typed object directly. AC: looser code path removed; existing AI-mode tests still pass; fallback contract `{ mode: "fallback", aiError }` unchanged on validation failure. Depends on ENG-011. |
| ENG-015 | GitHub Actions CI | Shipped | P1 | 1 | Add `.github/workflows/ci.yml`: build + test + e2e + dep-audit (osv-scanner or `pnpm audit`). Cache pnpm store. Run on PR + main. AC: green CI on a clean clone; e2e job uses Compose; dep-audit fails the build on HIGH+. **Summary:** Single workflow with four parallel jobs — `build_test`, `test_browser`, `test_e2e`, `dep_audit` — pinning `pnpm@10.23.0` + `node@24` and reusing `actions/setup-node@v4`'s `cache: pnpm`. The e2e job invokes `pnpm test:e2e` which already owns the full Compose lifecycle (up → migrate → API/worker → Playwright → down). Dep-audit runs `pnpm audit --audit-level high`, letting today's two pre-existing moderate advisories through (cleanup tracked in ENG-016) and failing only on high+. Closes ENG-010's "in CI" gap as a side effect. |
| ENG-016 | Drop deprecated @esbuild-kit/* subdeps | Pending | P3 | — | Trace which top-level dep pulls in `@esbuild-kit/*` (likely `drizzle-kit`) and update once a clean version ships. AC: `pnpm why @esbuild-kit/core-utils` shows no path; `pnpm install` clean; deprecation warning gone. |
| ENG-017 | Root pnpm dev script | Pending | P3 | — | `pnpm dev` at root boots `docker compose up -d redis postgres` + api + worker + web with `concurrently`. AC: single command brings up the full stack on a fresh checkout; `Ctrl+C` shuts everything down cleanly including Compose. |
| ENG-018 | Evals harness for AI workflow generation | Pending | P2 | — | Write `evals/generate-workflow.jsonl` with 10 prompts and the node-type counts we expect. Add `pnpm evals` script that runs each prompt against `/ai/generate-workflow` and asserts shape. AC: script returns non-zero on regressions; runs against either OpenAI or a recorded fixture. |
| ENG-019 | Move rate limiter to Redis | Pending | P1 | — | The in-memory rate limiter is bypassed in multi-process deployments. Move to Redis (already a dependency). AC: limit enforced across N API processes; existing Redis connection reused; tests cover both single-process and multi-process scenarios. |
| ENG-020 | Property-based test for parseAiWorkflow looser | Pending | P2 | — | Convert the looser to a property-based test: 1000 random LLM-shaped inputs (fast-check or similar) should never crash, never throw uncaught. AC: test added to `apps/api` suite; runs in `pnpm test`. **Note:** becomes redundant if ENG-014 lands first — close as `Deferred` in that case. |
| ENG-021 | Pin AWS metadata IP after assertPublicHostname | Pending | P0 | — | Close DNS-rebinding TOCTOU on the SSRF guard: after `assertPublicHostname` resolves a hostname, pin the resolved IP for the actual connect using `undici.Agent` with a `connect` hook. AC: a regression test exercises a hostname that resolves to a public IP first, private IP second — connection is refused. |
| ENG-022 | OTel resource enrichment | Pending | P3 | — | Add `service.namespace="janusly"` and an env-derived `service.instance.id` to the OTel resource so multi-instance dashboards can disambiguate. AC: traces and metrics carry both attributes; no change to `service.name`. |
| ENG-023 | Tool registry → Zod schemas | Pending | P1 | — | Convert each entry in the tool registry to a Zod schema for input + output. Foundation for `docs/PLAN.md` §8 contract migration. AC: `validateToolInput` becomes a real schema parse; existing tools (`http.request`, `text.uppercase`, `json.pick`) round-trip; new tool registration enforces the schema field. |
| ENG-024 | Phase 2 — Workflow expressiveness | Deferred | P1 | 2 | Roll-up of `docs/PLAN.md` §11 Phase 2: add `schedule`, `subworkflow`, `human_form`, `parallel_fork`, `wait_until` node types; tool catalog Layer 1 (text/json/csv/time/crypto) + Layer 2 essentials (`email.send`, `pdf.generate`, `db.query.*`); workflow inputs/outputs schema; diff UX (v3 vs v4 + AI patch preview); MCP server write tools; run cancellation. **Deferred until Phase 1 closes** — break into sub-tickets when ready. |
| ENG-025 | Phase 3 — Self-learning loop | Deferred | P1 | 3 | Roll-up of `docs/PLAN.md` §11 Phase 3: `mcp_tool` node + `mcp_connections` + Connections UI; `vector_search` / `vector_upsert` + pgvector; episodic + semantic memory in agent prompts; Thompson sampling for `router`; DLQ pattern detection → patch suggestions; A/B test endpoint + UI; run explainer with retrieval. **Deferred until Phase 2 closes.** |
| ENG-026 | Phase 4 — Operator-grade ergonomics | Deferred | P2 | 4 | Roll-up of `docs/PLAN.md` §11 Phase 4: `@janusly/sdk` Node SDK; per-org plan limits + soft delete + retention; Storybook + a11y audit; workflow folders + tags + search; public roadmap + `CONTRIBUTING.md`; conf talk + blog series. **Deferred until Phase 3 closes.** |

### 3c. Open decisions blocking tickets

The following tickets are not in §3b because they wait on a strategic decision (see `docs/PLAN.md` §13). Move them into §3b once the decision is made.

- **Pricing model decision.** Affects `usage_events` shape (ENG-012). If we pick per-token, the row writes one shape; per-run, another. Currently writing both is fine — unblock when pricing is chosen.
- **License choice.** Affects MCP server bundling (ENG-013) and contributor pipeline (ENG-026 sub-item). Stays as a footnote on those tickets.
- **Self-host vs cloud canonical product.** Affects retention defaults (ENG-026) and SaaS-only flags. Not blocking ENG-008..023.
- **AI training data opt-in policy.** Affects future memory/RL tickets (ENG-025). Not blocking earlier phases.

---

## 4. How to add a ticket

1. Pick the next `ENG-NNN` (highest existing + 1).
2. Add the row to §3b with `Status: Pending` and a Scope cell that contains acceptance criteria.
3. If the work is part of a Phase from `docs/PLAN.md` §11, set `Phase` accordingly. If it's a standalone quick-win or fix, leave Phase as `—`.
4. If the ticket depends on another, mention the blocker in the Scope cell ("Depends on ENG-NNN").
5. If the ticket is blocked by an open question (`docs/PLAN.md` §13), set `Status: Gated` and reference the question in §3c.

When the implementer skill (`janus-ship`) closes a ticket, it flips Status to `Shipped` (or `Partial` with an updated `Remaining:`) and appends a 2-3 line `**Summary:**` to the Scope cell. The reviewer skill (`janus-review`) verifies the flip is coherent with the staged diff.
