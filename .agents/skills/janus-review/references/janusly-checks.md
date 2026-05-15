# Janusly-specific review checks

The generic review skills (`typescript-react-reviewer`, `node`) catch language-level issues. These checks are Janusly-specific — they cover invariants the generic reviewers do not know about.

Each check has a **what** (the invariant), a **why** (the rationale, so edge cases can be judged correctly) and an **action** (FIX INLINE or REPORT). Apply [`fix-policy.md`](fix-policy.md) for each finding. Run only the checks that match what the diff touched.

## a. Multi-tenant invariant

**What:** Every new query carries `eq(<table>.orgId, auth.orgId)`. The local convention is `org_id`, not `ctx.tenantId` (which does not exist in this repo). The auth resolver in `apps/api/src/index.ts` is the only entry point. In dev, headers `x-org-id` / `x-user-id` are accepted with role fallback `admin` ONLY when Supabase is unset and `NODE_ENV !== "production"`. In production without Supabase the API refuses to start unless `ALLOW_DEV_AUTH_HEADERS=true`. `service-token` mode does NOT auto-grant `admin`.

**Why:** A missing `org_id` filter is a hard cross-tenant data leak. The dev-mode admin fallback is fine in dev but is privilege escalation if it leaks into prod — the boot-time refusal is the safety net.

**Action:** FIX INLINE when an `org_id` filter is missing on a new query.

## b. AI fallback contract

**What:** `/ai/generate-workflow`, `/ai/explain-workflow`, `/ai/explain-run`, the `agent` planner with `"openai"`, and the `ai` step type each wrap their OpenAI call in `try/catch`. Any failure (quota, rate, network, malformed output) returns `{ mode: "fallback", aiError: "<reason>", ... }` with the local content attached. `aiError` flows to the UI — never swallowed. `parseAiWorkflow` (in `apps/api/src/index.ts`) keeps its looser that coerces wrong-typed ids and drops invalid edges/conditions before Zod parse.

**Why:** OpenAI calls fail routinely. Without the fallback contract, every AI surface becomes a single point of failure for the entire workflow runtime. The looser exists because LLM output drifts; coercing near-misses keeps the success rate high without sacrificing the runtime schema.

**Action:** FIX INLINE when try/catch was removed or the response contract changed.

## c. Engine atomicity & lifecycle

**What:** `tryClaimNodeForQueue` is the atomic `UPDATE … WHERE status='pending'` claim. No re-introduced non-atomic `markNodeQueued`. `startRun` is one Drizzle transaction (runs insert + batch runNodes insert + `run.started` event). DLQ insertion goes through `BullMQQueueAdapter` composing `DeadLetterQueueAdapter`. The worker (`packages/engine/src/worker.ts`) listens for SIGTERM/SIGINT and calls `worker.close()`.

**Why:** With N parallel workers, two predecessors finishing at the same instant race to enqueue the downstream node — only the atomic UPDATE prevents duplicate work. The `startRun` transaction prevents partial inserts that leave unrecoverable runs (worker has nothing to claim, UI shows phantom run). DLQ adapter composition keeps the retry-exhaustion path consistent. The drain handler keeps container restarts from orphaning `running` rows.

**Action:** FIX INLINE when any of these regressed.

## d. Audit logs

**What:** Every mutation writes a row in `audit_logs` with a stable `action` string. AI mutations write audit on success AND on fallback (with `metadata.mode` and `metadata.error`). Convention list:

- `member.invited`, `member.role.updated`, `member.removed`
- `workflow.saved`
- `plugin.installed`
- `credential.created`
- `ai.workflow.generated`, `ai.workflow.explained`, `ai.run.explained`
- `run.started`, `run.started.adhoc`, `run.resumed`
- `dlq.resolved`, `dlq.replayed`

**Why:** Audit answers "who did what, when?" — required for compliance and for debugging "this run shouldn't have happened" complaints. Skipping audit on AI fallback specifically would create silent gaps where a feature failed and nothing was recorded. Always-write semantics keep audit reliable.

**Action:** FIX INLINE when a new mutation does not call `audit(...)` or when an AI path lost its audit row.

## e. Cross-panel reactivity

**What:** Mutations that invalidate server data call `bumpPlatformVersion()` on the Zustand store: workflow save, run start, terminal run, member invite/remove/role-update, DLQ replay. Independent panels read the counter as an effect dep and refetch.

**Why:** The UI is multi-panel and the panels don't know about each other. Without the bump, a mutation in one panel leaves stale data in others until manual refresh — confusing, easily mistaken for a bug.

**Action:** FIX INLINE when a new mutation does not bump and panels would go stale.

## f. Pagination caps

**What:** `GET /runs` and `GET /workflows` cap at 100 default, 200 max via `?limit=`. New list endpoints follow the pattern.

**Why:** Long-lived orgs accumulate thousands of rows. An unbounded list endpoint OOMs the API or freezes the React Flow canvas. The cap is a pre-emptive defense; cursor pagination is the explicit opt-in for clients that need more.

**Action:** FIX INLINE when a new list endpoint returns unbounded.

## g. Web deps lockdown

**What:** `apps/web/package.json` only imports: `react`, `react-dom`, `@xyflow/react`, `@supabase/supabase-js`, `zustand`, `lucide-react`, `i18next`, `react-i18next`. The two i18n libs are scoped to the `apps/web/src/i18n/` module — components NEVER import from `i18next` / `react-i18next` directly; every consumer routes through `useT()` / `t()` / the server-event helpers exported from the i18n module. Forbidden: `@radix-ui/*`, `class-variance-authority`, `clsx`, `tailwind-merge`, any shadcn-style scaffolding.

**Why:** The Janusly design system is hand-written CSS with `@theme` tokens. Reintroducing radix/cva/clsx pulls in a parallel design system that fights the CSS-first approach — components end up half-tokenized, theme tokens stop being the source of truth, bundle size grows. The whitelist keeps the design system coherent. `i18next` + `react-i18next` are an explicit cross-project decision (paridad con `lingua`) but stay isolated behind `apps/web/src/i18n/` so the chokepoint pattern (server-event mapping, parity tests, missing-key fallback) is the only path consumers see.

**Action:** FIX INLINE by rewriting the component with CSS-first Tailwind 4 utilities and removing the dep — or, for the i18n libs, by routing the call through `apps/web/src/i18n` instead of importing them directly.

## h. Tailwind 4 CSS-first

**What:** No `tailwind.config.ts`. No `postcss.config.js`. The plugin runs through `@tailwindcss/vite()` in `apps/web/vite.config.ts`. Tokens live in `apps/web/src/index.css` via `@theme { --color-we-* }` and `:root` aliases. No inline hex anywhere in components — always `var(--color-we-*)`.

**Why:** Tailwind 4 moved configuration into CSS. Adding `tailwind.config.ts` back fragments the source of truth — and the Vite plugin doesn't read the config file, so the duplicated config silently does nothing. Inline hex breaks tokenization: when a designer updates Cobalt, only the tokens change and inline hex stays on the old value.

**Action:** FIX INLINE by replacing inline hex with the matching token (one find-replace per token).

## i. Vite 8 / Rolldown

**What:** `build.rollupOptions.output.manualChunks` is a function, not an object literal.

**Why:** Vite 8 with Rolldown changed the API. An object literal still type-checks but silently produces a single huge chunk — first-load size triples without any error.

**Action:** FIX INLINE when an object literal was reintroduced.

## j. Zod 4

**What:** `z.record(z.string(), z.unknown())` — two-arg form. The single-arg `z.record(z.unknown())` is the older Zod 3 API.

**Why:** Zod 4 made `z.record` two-arg to support typed keys. The single-arg form is a TypeScript error in Zod 4 — fix it now to avoid cascading type errors.

**Action:** FIX INLINE the single-arg form to two-arg.

## k. HTTP / SSRF

**What:** `ALLOW_PRIVATE_HTTP_TARGETS=false` is the default. The `http` node and the `http.request` tool reject localhost / private / link-local destinations when the flag is false.

**Why:** Workflows can fetch arbitrary URLs. With the flag false, an attacker who can author workflows cannot pivot to internal services (cloud metadata endpoints, internal admin panels). The flag exists for self-hosted deployments that need internal MCP — but loosening it without that justification is SSRF.

**Action:** FIX INLINE when the check was loosened without justification. Loosening it WITH justification (e.g., self-hosted MCP on the local network) is a design call — REPORT instead.

## l. Tests

**What:** Each new pure helper has tests for empty input, invalid input, boundary. Each new component has tests for initial render, happy path, error state. Each new AI path has tests for success (`mode: "ai"`) AND fallback (`mode: "fallback"` with `aiError`). Each new mutation asserts the audit row exists.

**Why:** Edge cases are where bugs hide. A test that only covers the happy path passes today and fails in production when the input is empty / a unicode boundary / a malformed payload. AI tests specifically need both branches because the fallback path is the actual production behavior most of the time (rate limits, intermittent failures).

**Action:** FIX INLINE when an obvious edge case is missing — add the test.

## m. Banned dependencies

**What:** No `trpc/` files, no `@trpc/*` in deps, no bespoke procedure wrapper. The API is plain HTTP. No `stripe` SDK in deps. Billing schema columns are placeholders.

**Why:** tRPC was deleted because plain HTTP keeps Janusly MCP-friendly (clients in any language, no codegen). Reintroducing tRPC forks the API into two surfaces. Stripe was scaffolded for billing but billing isn't active; the SDK adds attack surface and a stale dep.

**Action:** FIX INLINE by deleting and rewriting with plain HTTP.

## n. Doc sync (verify the implementer's work)

**What:**

- **`docs/ROADMAP.md` §3b**: Status flip applied (Shipped, or Partial with updated `Remaining:`), 2-3 line summary at the end of the Scope cell.
- **`docs/PLAN.md`**: `### §X.0 Status Update` inline at the end of the relevant section, when a strategic claim drifted.
- **AGENTS.md**: updated only if an operational invariant changed. CLAUDE.md → AGENTS.md symlink intact. NO roadmap content.
- **README.md**: contains no planning, no pending features, no roadmap. When the implementer leaked planning into README, **FIX INLINE** by moving the content to `docs/ROADMAP.md` or removing duplicates.
- **New requirement without AC** spotted during review: add a new `Pending` row in `docs/ROADMAP.md` §3b. Bugs do not go here; fix them inline.

**Why:** Doc sync is what keeps `docs/ROADMAP.md` reliable as a ticket pool — if Status flips drift behind reality, the next `janus-ship` invocation picks the wrong tickets. Planning leaking into README means two sources of truth that drift. The split (operational in AGENTS.md, tactical in ROADMAP, strategic in PLAN, descriptive in README) breaks down quickly without enforcement.

**Action:** FIX INLINE when a required doc-sync edit is missing. It is a docs edit, not a code change.

## o. API routing (Open/Closed)

**What:**

- New HTTP routes register as entries in the `routes: Route[]` array exported from `apps/api/src/index.ts`. The dispatcher iterates the array (first-match-wins) and runs `requireAuth` + `requireRole` based on the route's declared shape — handlers don't call them inline.
- `Route` types live in `apps/api/src/routes.ts`. `skipAuth: true` is set only on `/health`. `role: "editor"` / `role: "admin"` is on the route entry, not in the handler body.
- No reintroduced `if (req.method === "POST" && req.url === "/x") { ... }` branches outside the dispatcher.

**Why:** ENG-041 closed the dispatcher for modification. The registry is the extension point; new routes plug in via `routes.push({...})`. Bypassing it means duplicate auth logic, RBAC drift, and a return to the unmaintainable 33-if-branch shape we just escaped. Phase 2 will add 11+ more routes — every ticket that bypasses the registry compounds the cost of the next refactor.

**Action:** FIX INLINE when a new route was added as an inline `if` branch outside the dispatcher — convert it to a registry entry, move `requireRole` from handler body to the route's `role` field. REPORT (don't fix) when the change is structural — e.g. introducing per-domain route files (`routes/runs.ts`, `routes/workflows.ts`), path-parameter routing (`/run/:id/cancel`), or middleware composition — those are design discussions, not silent regressions.

## p. No ticket / roadmap refs in source code

**What:**

- Source files (`packages/**/src`, `apps/**/src`, migrations, tests) must NOT mention ticket ids (`ENG-NNN`), roadmap phases ("Phase 1/2/3"), tier labels ("Layer 1/2"), or roadmap section numbers (`§9`, `§3b`).
- `docs/ROADMAP.md`, `docs/PLAN.md`, `AGENTS.md`, and the chat-side report ARE allowed (and expected) to reference ticket ids.

**Why:** the repo is intended to go open source. Comments that link out to internal planning docs become meaningless when those docs aren't shipped (or are stripped before public release). Self-contained explanations age well; planning-artifact links don't.

**Action:** FIX INLINE — rewrite the comment to explain the **what** and **why** in self-contained terms (the motivation usually fits inline in 1–2 sentences). Spot scan: `grep -nE "ENG-[0-9]+|Phase [1-9]|Layer [1-9]|§[0-9]" $(git diff --cached --name-only -- 'packages/*/src/*' 'apps/*/src/*')` should be empty.

## q. i18n coverage

**What:**

- User-facing text added or changed under `apps/web/**` is wrapped via `useT()` / `t()` from `apps/web/src/i18n` — never raw string literals in JSX text nodes, `aria-label`, `placeholder`, `title`, `alt`, or the first argument of `addToast(...)`.
- Every new key in `apps/web/src/i18n/locales/en/common.json` has a sibling in `apps/web/src/i18n/locales/es/common.json`. The parity test (`apps/web/src/i18n/parity.test.ts`) fails CI when the key sets diverge.
- Server-emitted strings with a stable `code` flow through the dedicated helpers exported from `apps/web/src/i18n`: `tValidationIssue` (`/validate`, `/start` 422), `tReadinessIssue` (`/workflows/readiness`), `tAiReviewIssue` (`/ai/review-workflow`), `tRunEvent` (`run_events` timeline), `tFailureCluster` (`/dlq/clusters`). When the engine adds a new code, mirror it as `<surface>.<code>` in `en/common.json` + `es/common.json`. Free-form server messages (Supabase errors, generic `Error.message`) flow through `t('serverEvents.fallback', { message })`.
- Components MUST NOT import from `i18next` / `react-i18next` directly. Every consumer routes through `apps/web/src/i18n` (its `index.ts` re-exports `useTranslation` and `Trans` for the rare cases that need them).
- Exempt: technical identifiers (`'dev-user'`, role tokens like `'admin'` when stored as values, tool registry keys like `'slack.post'` / `'noop'`), brand-mark codes (`'JN'`, `'Janusly'`), single-punctuation / emoji-only nodes, test files (`*.test.tsx`, `*.browser.test.tsx`), `console.*` / log strings, and backend `error.message` strings passed through unmodified (those become `tServerFallback(message)` if surfaced inline).

**Why:** Janusly ships with `en` + `es` today and is structured to grow to more locales without component rewrites. The chokepoint at `apps/web/src/i18n` keeps the `i18next` + `react-i18next` dependency contained (matching the AGENTS.md Web-deps invariant) and lets the same module own the server-event mapping (codes from the engine become localised on the client). Skipping `t()` regresses coverage silently — a Spanish operator suddenly sees one English string after a feature lands. The parity test catches missing translations at CI time so the only way to add a key is in both locales.

**Action:** FIX INLINE — wrap the literal in `t('namespace.key')` and add the matching pair to `en/common.json` + `es/common.json`. For server-emitted strings, route through the surface-specific helper instead of `t()` directly so missing engine codes still surface readable text via the wrapper. When a component imports `i18next` / `react-i18next` directly, replace with `import { useT, Trans } from '../i18n'`. REPORT (don't fix) when the diff legitimately needs a new exemption category — exemptions live in this file's "Exempt" list above.

**Spot scan:** `bash .agents/skills/janus-review/scripts/check-i18n-coverage.sh` (a wrapper for `apps/web/scripts/check-i18n-coverage.sh`) reports suspect literals against `git diff --cached`. Exit 0 = clean, exit 1 = at least one suspect line. False positives are tolerable; the reviewer judges.
