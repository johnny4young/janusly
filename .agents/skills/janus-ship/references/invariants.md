# Janusly invariants — coupled risks

Every ticket carries the risk of breaking one of these invariants. Each section explains *what* the invariant is AND *why* it exists — the reason matters more than the rule, because edge cases will surface and the right call depends on understanding the original constraint.

List the invariants at risk in the PHASE 1 plan. Verify them in the PHASE 2 review checklist. The full operational reference is `AGENTS.md`.

## Multi-tenant scoping

**What:**

- Every new query includes `.where(eq(<table>.orgId, auth.orgId))`.
- The auth resolver lives in `apps/api/src/index.ts`. In dev mode, headers `x-org-id` / `x-user-id` carry the org/user identity, with role fallback to `admin` ONLY when Supabase is unset and `NODE_ENV !== "production"`.
- In production without Supabase, the API refuses to start unless `ALLOW_DEV_AUTH_HEADERS=true`.
- `service-token` mode does NOT auto-grant `admin`.
- Reuse the resolver — no bespoke middleware.

**Why:**

A missing `org_id` filter on any query lets one organization read or mutate another organization's rows — a hard cross-tenant data leak. The dev-mode `admin` fallback exists so a fresh checkout works without setup, but it is privilege escalation if it ever leaks into production. The boot-time refusal is the safety net: if someone misconfigures prod to skip Supabase, the API fails closed instead of silently granting admin to anyone with the right header.

## AI fallback contract

**What:**

- `/ai/generate-workflow`, `/ai/explain-workflow`, `/ai/explain-run`, the `agent` planner `"openai"`, and the `ai` step type each wrap the OpenAI call in `try/catch`.
- On any failure (quota, rate, network, malformed output), the response stays `{ mode: "fallback", aiError: "<reason>", ... }` with the local content attached.
- `aiError` flows to the UI — never swallowed.
- `parseAiWorkflow` (in `apps/api/src/index.ts`) keeps its looser that coerces wrong-typed ids and drops invalid edges/conditions before Zod parse. The looser stays even when adding fields.

**Why:**

OpenAI calls fail routinely — rate limits, billing issues, transient network blips, malformed JSON output. Without the fallback contract, every AI surface becomes a single point of failure for the entire workflow runtime: a quota error could brick the run pipeline. The contract turns failure into a graceful degradation: features still work in deterministic mode, the user sees an explanation (`aiError`), and runs continue. The looser on `parseAiWorkflow` exists because LLM output drifts even with prompt engineering — coercing near-misses (wrong-typed ids, malformed edges) keeps the success rate high without sacrificing the strict schema for the runtime.

## Engine atomicity & lifecycle

**What:**

- `tryClaimNodeForQueue` is the atomic `UPDATE … WHERE status='pending'` claim. Never re-introduce a non-atomic `markNodeQueued`.
- `startRun` is one Drizzle transaction: runs insert + batch runNodes insert + `run.started` event. Do not split.
- DLQ insertion happens via `BullMQQueueAdapter` composing `DeadLetterQueueAdapter`. Do not bypass the queue contract.
- The worker (`packages/engine/src/worker.ts`) listens for SIGTERM/SIGINT and calls `worker.close()` to drain in-flight jobs.

**Why:**

Janusly runs N workers in parallel. When two predecessors of a downstream node finish at the same instant, both workers race to enqueue that node. A non-atomic check-then-update would let both win, producing duplicate work and inconsistent state. The atomic UPDATE ensures exactly one wins.

The `startRun` transaction matters because a partial insert (run row written but runNodes missing, or runs+nodes written but `run.started` event missing) leaves an unrecoverable run: the worker has nothing to claim, the UI shows a phantom run, and the operator has to clean it manually.

DLQ via the queue adapter ensures every retry-exhausted job lands in `dead_letters` for replay. Bypassing the adapter — for instance, manually calling the DLQ repo from a special-cased failure path — creates a parallel pipeline that diverges over time.

The SIGTERM/SIGINT handler drains in-flight jobs. Without it, a container restart leaves jobs in `running` state forever (no worker reaps them, BullMQ lock expires but the row still says `running`).

## OpenTelemetry resource

**What:**

- `service.name === "janusly"` in both the tracer and the meter (`packages/engine/src/observability/{tracer,metrics}.ts`).

**Why:**

External dashboards (Grafana, Honeycomb, whatever the operator uses) filter and group on `service.name`. Renaming it silently breaks every alert, every saved query, every dashboard panel. The legacy name was `workflow-engine` — the rename to `janusly` was a deliberate, coordinated change. Don't undo it casually.

## Cross-panel reactivity

**What:**

Mutations that invalidate server data must call `bumpPlatformVersion()` on the Zustand store. The events that bump:

- Workflow save.
- Run start (saved or ad-hoc).
- Terminal run state (success or failure reaches the UI).
- Member invite, role update, or removal.
- DLQ replay.

Independent panels read the counter as an effect dep and refetch.

**Why:**

Janusly's UI is multi-panel: Workflows, Runs, Members, DLQ all visible at once. They don't know about each other. A mutation in one panel (say, replaying a dead letter) needs to refresh another panel (the Runs list) without manual reload. The `platformVersion` counter is a global "something changed, refetch your data" signal. Forgetting to bump it after a mutation leaves panels showing stale data until the user manually refreshes — confusing and easy to misread as a bug.

## Pagination caps

**What:**

- `GET /runs` and `GET /workflows` cap at 100 default, 200 max via `?limit=`.
- New list endpoints follow the same pattern.

**Why:**

A long-running org accumulates thousands of workflows and tens of thousands of runs. An unbounded list endpoint either OOMs the API process (loading every row into memory) or freezes the UI (rendering 50k React Flow nodes). The 100/200 cap is the simplest pre-emptive defense; clients that need more pages do so explicitly with cursors.

## Audit log

**What:**

Every mutation writes a row in `audit_logs` with a stable `action` string. Existing convention:

- `member.invited`, `member.role.updated`, `member.removed`
- `workflow.saved`
- `plugin.installed`
- `credential.created`
- `ai.workflow.generated`, `ai.workflow.explained`, `ai.run.explained`
- `run.started`, `run.started.adhoc`, `run.resumed`
- `dlq.resolved`, `dlq.replayed`

AI mutations write audit on success AND on fallback (with `metadata.mode` and `metadata.error`).

**Why:**

Audit answers "who did what, when?" — required for any operator going through compliance or debugging a "this run shouldn't have happened" complaint. Skipping audit on fallback specifically would create gaps where an AI feature failed silently — the operator looks at the trace and sees nothing, even though something happened. Always-write semantics make audit reliable.

## Web deps lockdown

**What:**

- `apps/web/package.json` only imports: `react`, `react-dom`, `@xyflow/react`, `@supabase/supabase-js`, `zustand`, `lucide-react`.
- Forbidden: `@radix-ui/*`, `class-variance-authority`, `clsx`, `tailwind-merge`, any shadcn-style scaffolding.

**Why:**

The Janusly design system is hand-written CSS in `index.css` with `@theme` tokens. Reintroducing radix/cva/clsx pulls in a parallel design system that conflicts with the CSS-first approach: components end up half-tokenized, half-shadcn, and the theme tokens stop being the source of truth. Bundle size also grows non-trivially. The whitelist forces every new UI to use the existing primitives.

## Tailwind 4 CSS-first

**What:**

- No `tailwind.config.ts`. No `postcss.config.js`. Plugin runs through `@tailwindcss/vite()` in `apps/web/vite.config.ts`.
- Tokens live in `apps/web/src/index.css` via `@theme { --color-we-* }` and `:root` aliases.
- No inline hex colors anywhere — always `var(--color-we-*)`.

**Why:**

Tailwind 4 moved configuration into CSS. Re-introducing `tailwind.config.ts` fragments the source of truth — you'd have tokens in CSS AND in the config file, with rules about which wins. Worse, the Vite plugin doesn't read the config file, so the duplicated config silently does nothing. Inline hex breaks tokenization: a designer changes Cobalt and only the tokens update, leaving inline hex stuck on the old value.

## Vite 8 / Rolldown

**What:**

- `build.rollupOptions.output.manualChunks` is a function, not an object literal.

**Why:**

Vite 8 with Rolldown changed the API. An object literal still type-checks but silently produces a single huge chunk — first-load size triples without any error message. The function form is the API that actually works.

## Zod 4

**What:**

- `z.record(z.string(), z.unknown())` — the two-arg form. The single-arg form is the older Zod 3 API.

**Why:**

Zod 4 made `z.record` two-arg to support typed keys. The single-arg form is a TypeScript error in Zod 4. Catching this early (in review or build) avoids cascading type errors when someone reflexively writes the Zod 3 idiom.

## HTTP / SSRF

**What:**

- `ALLOW_PRIVATE_HTTP_TARGETS=false` by default.
- The `http` node and the `http.request` tool reject localhost / private / link-local destinations when the flag is false.

**Why:**

Workflows can fetch arbitrary URLs (that's the point of the `http` node). With the flag false, an attacker who can author workflows cannot pivot to internal services (cloud metadata endpoints, internal admin panels, etcd). The flag exists for self-hosted deployments where the operator deliberately wants to reach internal MCP servers — but loosening it without that justification is a SSRF.

## Banned dependencies

**What:**

- No tRPC: the API is plain HTTP. The deleted tRPC stub does not come back.
- No Stripe SDK: billing schema columns are placeholders. The Stripe SDK does not come back.

**Why:**

tRPC was scaffolded then deleted because plain HTTP makes Janusly an MCP-friendly API (clients in any language, no codegen). Reintroducing tRPC creates two API surfaces and forces every external integration to depend on TS. Stripe was scaffolded for billing but billing isn't activated; the SDK adds attack surface and a stale dependency that drifts.

## Compose lifecycle

**What:**

When the work started Compose, run `docker compose down` before the final stage.

**Why:**

Leaked containers hold port 5432 and 6379. The next session that tries to start Postgres locally fails with "port already in use". Worse, the leaked containers may serve stale data (test fixtures from the previous session) which silently confuses future tests.

## Symlink

**What:**

`CLAUDE.md` is a symlink to `AGENTS.md`. Edit `AGENTS.md`. Do not break the symlink.

**Why:**

Different tooling expects each name. Claude Code looks for `CLAUDE.md`; other agent harnesses (and humans browsing GitHub) expect `AGENTS.md`. The symlink lets both work without duplicating the file. Editing through the symlink is fine; replacing the symlink with a copy creates two files that drift.
