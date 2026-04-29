# Agent Notes — Janusly

Operational invariants only — how to run the project, what not to break. Roadmap and ticket pool live in [`docs/ROADMAP.md`](docs/ROADMAP.md). Strategic context lives in [`docs/PLAN.md`](docs/PLAN.md). Don't add planning here.

Janusly = the AI operator for business workflows. Internal packages live under the `@janusly/*` scope. Everywhere user-facing (UI brand-mark, page titles, marketing copy, `/ai/*` responses) say **Janusly**.

- **Stack baselines:** Node.js **24**, TypeScript 6, React 19, Vite 8 (Rolldown), Tailwind 4 (CSS-first via `@theme` + `@tailwindcss/vite`), Vitest 4, Zod 4, Drizzle 0.45, Postgres 18, Redis 8, OpenAI SDK 6.
- **Design system:** Workflow palette (Cobalt `#245BFF` + Cyan `#06B6D4` + green/amber/red status). Tokens in `apps/web/src/index.css` (`@theme { --color-we-* }` + `:root` aliases). No inline hex.
- **Tailwind 4 is CSS-first.** No `tailwind.config.ts` or `postcss.config.js`. The plugin runs through `@tailwindcss/vite()` in `apps/web/vite.config.ts`.
- **Vite 8 / Rolldown:** `build.rollupOptions.output.manualChunks` must be a function, not an object literal.
- **Zod 4:** `z.record(z.string(), z.unknown())` — two-arg form.
- **Auth:** dev-mode uses `x-org-id` and `x-user-id` headers, allowed automatically when Supabase is unset **and** `NODE_ENV !== "production"`. Production without Supabase requires explicit `ALLOW_DEV_AUTH_HEADERS=true` or the API refuses to start. The `dev-headers` mode falls back to the `admin` role only when no `org_members` row exists; `service-token` mode does **not** auto-grant admin.
- **HTTP/SSRF:** `ALLOW_PRIVATE_HTTP_TARGETS=false` blocks localhost/private/link-local for `http` nodes and the `http.request` tool.
- **AI integration:** `OPENAI_API_KEY` enables `/ai/generate-workflow`, `/ai/explain-workflow`, `/ai/explain-run`, the `agent` planner `"openai"`, and the `ai` step type. Every AI path has a deterministic fallback **and** wraps the OpenAI call in try/catch — on any failure (quota, rate, network, bad output) the response stays `{ mode: "fallback", aiError: "<reason>", ... }` with the local content attached. Never break the fallback or remove the try/catch. `GET /ai/health` says `enabled: true` when the key is present, but a runtime call can still degrade — surface `aiError` to the UI so the user sees billing/quota issues. `parseAiWorkflow` (in `apps/api/src/index.ts`) has a **loosener** that coerces wrong-typed ids and drops invalid edge/condition expressions before Zod parses; keep it when adding fields so the LLM's near-misses still validate.
- **Decision engine / RL:** `packages/domain` is pure logic, no I/O. `packages/data` owns the drizzle repos. Don't put DB queries in `domain`; don't put scoring logic in `data`.
- **Causal reasoning:** runs without an LLM. Always available.
- **Cross-panel reactivity:** when an action invalidates server data (save, run start, terminal run, member invite/remove, DLQ replay), call `bumpPlatformVersion()` on the Zustand store. Independent panels listen to it as an effect dep.
- **DLQ:** every failed node beyond `retryPolicy.maxAttempts` lands in `dead_letters`. Replay via `POST /dlq/replay`. The Operations card in Runs surfaces counts and filters. `BullMQQueueAdapter` composes `DeadLetterQueueAdapter` so DLQ insertion is part of the queue contract — don't bypass it.
- **Concurrency:** `enqueueReadyNodes` claims downstream nodes via `tryClaimNodeForQueue` (atomic `UPDATE … WHERE status='pending'`). With multiple workers two predecessors can complete simultaneously; only one wins the claim, so don't reintroduce a non-atomic `markNodeQueued` here.
- **Run setup:** `startRun` wraps the `runs` insert + batch `runNodes` insert + `run.started` event in one Drizzle transaction. Don't split it back into per-node inserts.
- **Worker lifecycle:** `worker.ts` listens to `SIGTERM`/`SIGINT` and calls `worker.close()` to drain in-flight jobs. Container restarts don't orphan `running` nodes.
- **Pagination:** `GET /runs` and `GET /workflows` cap at 100 rows by default (max 200 via `?limit=`). Don't return unbounded lists.
- **Observability:** OTel tracer/meter `service.name` is `"janusly"` (in `packages/engine/src/observability/{tracer,metrics}.ts`). External dashboards filtering on the legacy `workflow-engine` name need updating.
- **AI audit:** `/ai/generate-workflow` and `/ai/explain-workflow` write `audit_logs` rows on AI-mode success (`ai.workflow.generated` / `ai.workflow.explained`). Keep the audit when adding new AI endpoints.
- **Web deps:** `apps/web` only imports `react`, `react-dom`, `@xyflow/react`, `@supabase/supabase-js`, `zustand`, and `lucide-react`. No `@radix-ui`, `class-variance-authority`, `clsx`, or `tailwind-merge` — the design system is hand-written CSS in `index.css`. Don't reintroduce shadcn-style scaffolding.
- **Migrations:** schema lives in `packages/db/src/schema.ts`; checked-in SQL under `packages/db/migrations/` is generated via `pnpm --filter @janusly/db db:generate`. Apply with `pnpm migrate` (delegates to `drizzle-kit migrate`) before booting the API or worker — both call `assertMigrationsApplied()` at startup and fail fast if the `drizzle.__drizzle_migrations` table is missing. Don't reintroduce a runtime `CREATE TABLE` bootstrap. The e2e harness runs `pnpm migrate` between Compose-up and API boot.
- **Tests:** `pnpm test` runs Vitest 4 in shared, engine, ai, domain, db, and web (jsdom + Testing Library). `pnpm test:e2e` boots Postgres/Redis via Compose, runs `pnpm migrate`, starts API + worker, lets Playwright bring up the UI, shuts Compose down on exit.
- **Compose lifecycle:** if a task started Compose, run `docker compose down` before finishing unless told otherwise.
- **Don't reintroduce** the deleted tRPC stub or Stripe SDK; the API is plain HTTP, billing schema columns are placeholders.
- **`CLAUDE.md`** is a symlink to this file. Edit here; don't break the symlink.
