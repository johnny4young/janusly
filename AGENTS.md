# Agent Notes

- Stack baselines: Node.js **24** (`engines.node` enforced), TypeScript 6, React 19, Vite 8 (Rolldown), Tailwind 4 (CSS-first via `@theme` + `@tailwindcss/vite`), Vitest 4, Zod 4, Drizzle 0.45, Postgres 18, Redis 8.
- Before UI/React changes activate `frontend-design` and `typescript-react-reviewer`; keep the app usable from the first viewport and validate the flow in a browser.
- Before Node.js backend, worker, queue, or runtime changes activate `node`; for auth, CORS, request handling, secrets, or SSRF changes also activate `security-best-practices`.
- Design system: Workflow Engine palette (Indigo `#4F46E5` + Cyan `#06B6D4` + green/amber/red status tones). Tokens declared in `apps/web/src/index.css` (`@theme { --color-we-*: ... }` + `:root` aliases for component CSS). Don't introduce inline hex values; use the tokens.
- Tailwind 4 is CSS-first: there is **no** `tailwind.config.ts` or `postcss.config.js`. Theme lives inside `@theme {}`, plugin runs through `@tailwindcss/vite` in `apps/web/vite.config.ts`.
- Vite 8 uses Rolldown — `build.rollupOptions.output.manualChunks` must be a function, not an object literal.
- Zod 4: `z.record(...)` requires both key and value schemas (`z.record(z.string(), z.unknown())`).
- Auth: dev mode without Supabase uses `x-org-id` and `x-user-id` headers. When Supabase is configured, the API requires a Bearer JWT unless `ALLOW_DEV_AUTH_HEADERS=true`.
- HTTP/SSRF: `ALLOW_PRIVATE_HTTP_TARGETS=false` by default blocks localhost, private ranges, and link-local for `http` nodes and the `http.request` tool.
- `pnpm test` runs Vitest 4 in shared, engine, and web (jsdom + Testing Library). `pnpm test:e2e` boots Postgres/Redis via Docker Compose, starts API and worker, lets Playwright bring up the UI, and shuts Compose down on exit.
- If Docker Compose was started during a task, run `docker compose down` before finishing unless the user explicitly asks to keep services up.
- Cross-panel reactivity: when an action invalidates server data (save, run start, run finished, member invite/remove), call `bumpPlatformVersion()` on the Zustand store. Independent panels (WorkflowsDashboard, VersionHistoryPanel, MembersPanel) listen to it as an effect dep.
- Don't reintroduce Stripe or the deleted tRPC stub; the API is plain HTTP. Migration to tRPC must be a complete iteration.
- `CLAUDE.md` is a symlink to this file. Edit here; don't break the symlink.
