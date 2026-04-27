# Agent Notes — Janusly

Janusly = the AI operator for business workflows. Internal packages live under the `@janusly/*` scope. Everywhere user-facing (UI brand-mark, page titles, marketing copy, `/ai/*` responses) say **Janusly**.

- **Stack baselines:** Node.js **24**, TypeScript 6, React 19, Vite 8 (Rolldown), Tailwind 4 (CSS-first via `@theme` + `@tailwindcss/vite`), Vitest 4, Zod 4, Drizzle 0.45, Postgres 18, Redis 8, OpenAI SDK 6.
- **Design system:** Workflow palette (Cobalt `#245BFF` + Cyan `#06B6D4` + green/amber/red status). Tokens in `apps/web/src/index.css` (`@theme { --color-we-* }` + `:root` aliases). No inline hex.
- **Tailwind 4 is CSS-first.** No `tailwind.config.ts` or `postcss.config.js`. The plugin runs through `@tailwindcss/vite()` in `apps/web/vite.config.ts`.
- **Vite 8 / Rolldown:** `build.rollupOptions.output.manualChunks` must be a function, not an object literal.
- **Zod 4:** `z.record(z.string(), z.unknown())` — two-arg form.
- **Auth:** dev-mode uses `x-org-id` and `x-user-id` headers. With Supabase configured, the API requires a Bearer JWT unless `ALLOW_DEV_AUTH_HEADERS=true`.
- **HTTP/SSRF:** `ALLOW_PRIVATE_HTTP_TARGETS=false` blocks localhost/private/link-local for `http` nodes and the `http.request` tool.
- **AI integration:** `OPENAI_API_KEY` enables `/ai/generate-workflow`, `/ai/explain-workflow`, `/ai/explain-run`, and the `agent` planner `"openai"`. Every AI path has a deterministic fallback — calls return `{ mode: "ai" | "fallback" | "error" }`. Never break the fallback. `GET /ai/health` is the source of truth for "is AI live?".
- **Decision engine / RL:** `packages/domain` is pure logic, no I/O. `packages/data` owns the drizzle repos. Don't put DB queries in `domain`; don't put scoring logic in `data`.
- **Causal reasoning:** runs without an LLM. Always available.
- **Cross-panel reactivity:** when an action invalidates server data (save, run start, terminal run, member invite/remove, DLQ replay), call `bumpPlatformVersion()` on the Zustand store. Independent panels listen to it as an effect dep.
- **DLQ:** every failed node beyond `retryPolicy.maxAttempts` lands in `dead_letters`. Replay via `POST /dlq/replay`. The Operations card in Runs surfaces counts and filters.
- **Tests:** `pnpm test` runs Vitest 4 in shared, engine, ai, domain, and web (jsdom + Testing Library). `pnpm test:e2e` boots Postgres/Redis via Compose, starts API + worker, lets Playwright bring up the UI, shuts Compose down on exit.
- **Compose lifecycle:** if a task started Compose, run `docker compose down` before finishing unless told otherwise.
- **Don't reintroduce** the deleted tRPC stub or Stripe SDK; the API is plain HTTP, billing schema columns are placeholders.
- **`CLAUDE.md`** is a symlink to this file. Edit here; don't break the symlink.
