# Workflow Engine

Workflow engine for async, distributed DAG execution. HTTP API + BullMQ worker (Node.js 24, TypeScript 6) and a React 19 + React Flow UI built on Vite 8 + Tailwind 4. Lives in a single PNPM monorepo.

> Design system: **Electric Indigo** (`#4F46E5`) primary with **Cyan** (`#06B6D4`) accent and semantic green/amber/red status tones. Tokens declared CSS-first via `@theme {}` in [`apps/web/src/index.css`](apps/web/src/index.css).

---

## Architecture

```txt
apps/
  api        -> HTTP API (control plane, plain Node http)
  web        -> React 19 + Vite 8 + React Flow UI

packages/
  engine     -> runtime, scheduler, executors, BullMQ worker
  db         -> Drizzle ORM 0.45 / postgres-js client + schema bootstrap
  shared     -> Zod 4 contracts shared across packages
```

The worker lives in `packages/engine/src/worker.ts` and runs with `pnpm --filter @workflow-engine/engine dev`.

---

## Stack

| Layer       | Library                                                   |
| ----------- | --------------------------------------------------------- |
| Runtime     | Node.js 24 LTS (Krypton), Postgres 18, Redis 8            |
| TypeScript  | 6.0                                                        |
| Backend     | `bullmq`, `ioredis`, `drizzle-orm`/`postgres-js`, `openai` |
| Validation  | `zod` 4                                                    |
| UI          | React 19, Vite 8 (Rolldown), `@xyflow/react`, Tailwind 4  |
| State       | `zustand` 5                                                |
| Auth        | `@supabase/supabase-js` 2 (optional)                      |
| Tests       | Vitest 4 (jsdom + Testing Library), Playwright            |

---

## Requirements

- Node.js **24+** (`engines.node` enforced at root)
- PNPM **10** (`corepack enable`)
- Docker (for Postgres 18 + Redis 8 services)

---

## Quick start

Five steps to a working local stack with the dev-mode UI (no auth setup needed):

```bash
# 1. Install dependencies
corepack enable
pnpm install

# 2. Boot Postgres 18 + Redis 8
docker compose up -d redis postgres

# 3. Start the API in one terminal
pnpm --filter @workflow-engine/api dev      # http://localhost:3001

# 4. Start the worker in another terminal
pnpm --filter @workflow-engine/engine dev

# 5. Start the UI in a third terminal
pnpm --filter @workflow-engine/web dev      # http://localhost:5173
```

Open <http://localhost:5173> — the UI is signed in as `dev-user` in org `default`. Click **Validate**, **Save**, **Run** on the seeded workflow to verify the full path works.

When you're done:

```bash
docker compose down
```

### Test commands

```bash
pnpm test       # 66 Vitest unit tests (shared + engine + web) + tsc on api/db
pnpm build      # type-check + Vite production build with manualChunks
pnpm test:e2e   # Playwright; boots Compose, runs full UI flow, tears Compose down

# Vitest watch (web only)
pnpm --filter @workflow-engine/web test:watch
```

### End-to-end smoke via curl

`.env.example` is auto-loaded for development; no `.env` is needed for the dev-mode flow.

```bash
# 1. Save a workflow from the example payload
curl -X POST http://localhost:3001/workflows/save \
  -H "Content-Type: application/json" \
  -H "x-org-id: default" -H "x-user-id: dev-user" \
  -d @docs/examples/github-uppercase.json

# 2. Start a run
RUN=$(curl -s -X POST http://localhost:3001/start \
  -H "Content-Type: application/json" \
  -H "x-org-id: default" -H "x-user-id: dev-user" \
  -d @docs/examples/github-uppercase.json)
RUNID=$(echo "$RUN" | jq -r .runId)

# 3. Inspect (status will become "succeeded" within ~1 second)
curl -s "http://localhost:3001/run?runId=$RUNID" \
  -H "x-org-id: default" -H "x-user-id: dev-user" | jq .
```

---

## Credentials & auth

The project has **three independent layers of credentials** — they don't overlap:

### 1. App login (how a user signs in to the UI)

**Dev mode (default — no setup):** the UI sends `x-org-id=default` and `x-user-id=dev-user` headers; the API trusts them. No credentials required.

**Supabase mode (production):** real email/password auth backed by Supabase.

1. Create a free project at <https://supabase.com>.
2. *Project Settings → API*. Copy:
   - `Project URL` → `SUPABASE_URL` and `VITE_SUPABASE_URL`
   - `anon public key` → `VITE_SUPABASE_ANON_KEY` (frontend, safe to expose)
   - `service_role key` → `SUPABASE_SERVICE_ROLE_KEY` (backend only, **never** ship to the frontend)
3. Put them in `.env` at the repo root:
   ```env
   SUPABASE_URL=https://xxxxx.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...
   VITE_SUPABASE_URL=https://xxxxx.supabase.co
   VITE_SUPABASE_ANON_KEY=eyJhbGc...
   ```
4. Restart API + UI. The dev headers are now disabled (the API rejects them when Supabase is configured). Override with `ALLOW_DEV_AUTH_HEADERS=true` only for hybrid test/staging.

### 2. Workflow secrets (what nodes use to call external APIs)

`http`, `tool`, `agent`, etc. nodes can resolve the `{{secret.NAME}}` placeholder at run time. The placeholder is read from `process.env.NAME` in the worker.

Two pieces, decoupled on purpose:

- **The reference** lives in Postgres via the **Secrets** tab in the UI (or `POST /credentials`). It only stores the *name* of the env var, never the value:
  ```bash
  curl -X POST http://localhost:3001/credentials \
    -H "Content-Type: application/json" \
    -H "x-org-id: default" -H "x-user-id: dev-user" \
    -d '{"name":"GitHub bot","kind":"github","secretRef":"GITHUB_TOKEN"}'
  ```
- **The actual value** lives in `.env` (or your secret manager: Doppler, Supabase Vault, AWS Secrets Manager, etc.):
  ```env
  GITHUB_TOKEN=ghp_xxxxx
  SLACK_BOT_TOKEN=xoxb-xxxxx
  ```
- **Workflow node usage:**
  ```jsonc
  {
    "id": "call",
    "type": "http",
    "config": {
      "url": "https://api.github.com/user",
      "headers": { "Authorization": "Bearer {{secret.GITHUB_TOKEN}}" }
    }
  }
  ```

### 3. Optional integrations (LLM provider for `agent` and `/ai/*`)

If you want `agent` nodes with `planner: "openai"` and the `/ai/generate-workflow` / `/ai/explain-workflow` endpoints to call a real model:

- Get a key from <https://platform.openai.com/api-keys>.
- Add it to `.env`:
  ```env
  OPENAI_API_KEY=sk-...
  ```

Without this key, the AI endpoints return a deterministic fallback (template / placeholder text) instead of failing — agents fall back to the rules planner.

### Full env-var reference

```env
# Required
REDIS_URL=redis://localhost:6379
DATABASE_URL=postgres://postgres:postgres@localhost:5432/workflow

# API tuning
PORT=3001
WORKER_CONCURRENCY=10
API_ALLOWED_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
API_MAX_JSON_BODY_BYTES=1048576

# SSRF policy — keep false unless you intentionally allow internal calls
ALLOW_PRIVATE_HTTP_TARGETS=false

# Supabase auth (optional)
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
ALLOW_DEV_AUTH_HEADERS=false

# Service-to-service auth (optional)
API_SERVICE_TOKEN=

# AI providers (optional)
OPENAI_API_KEY=

# Workflow secrets (each {{secret.NAME}} resolves to one of these)
# GITHUB_TOKEN=
# SLACK_BOT_TOKEN=
```

> The API and worker run an idempotent Postgres schema bootstrap at startup, so you don't need to run migrations for the first run.

---

## Roles & permissions

| Role    | Capabilities                                                                  |
| ------- | ----------------------------------------------------------------------------- |
| viewer  | Read-only: workflows, runs, members, audit                                    |
| editor  | Validate, save workflows, start runs, resume `waiting` nodes                  |
| admin   | Invite/remove members, change roles, install plugins, manage credentials      |

Permissions are enforced per organization through `org_members`. In `dev-headers` and `service-token` modes the default role is `admin`.

---

## Documentation

| Topic | File |
| --- | --- |
| Node types, configs, outputs, templating | [`docs/nodes.md`](docs/nodes.md) |
| HTTP API request/response examples | [`docs/api.md`](docs/api.md) |
| Full workflow examples (DAG JSON) | [`docs/workflows.md`](docs/workflows.md) |
| Runnable example payload | [`docs/examples/github-uppercase.json`](docs/examples/github-uppercase.json) |

---

## Status

### Implemented

- Postgres persistence (workflows, versions, runs, events, memberships, audit, plugins, credentials).
- BullMQ queue + worker with configurable concurrency and exponential backoff.
- DAG validation: types, cycles, sandboxed expressions, tool input schemas, start node detection.
- 12 node types: `noop`, `http`, `condition`, `transform`, `loop`, `tool`, `agent`, `multi_agent`, `agent_reflection`, `ai`, `webhook`, `approval`.
- 3 builtin tools: `http.request`, `text.uppercase`, `json.pick`.
- React 19 + Tailwind 4 UI with Workflow Engine design system.
- Auto-refresh on terminal run state via shared `platformVersion` signal.
- Vitest 4 unit suites across `shared`, `engine`, `web`; Playwright e2e.
- Code splitting (React/Flow/Supabase vendors) with Rolldown.
- Incremental SSE on `/events` (only events newer than the last cursor).

### In progress

- Formal Drizzle migrations for production deployments.
- Lazy loading for very large run timelines.
- Vitest browser mode for canvas-level React Flow tests.

---

## Testing

| Package                  | Stack                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `apps/web`               | Vitest 4 + jsdom + Testing Library (utilities, store, components). Playwright e2e. |
| `packages/shared`        | Vitest 4 over the Zod workflow contracts.                                          |
| `packages/engine`        | Vitest 4 for expressions, validation, templates, tool registry, secrets, memory, planner. |
| `apps/api`, `packages/db`| `tsc --noEmit` as a type guard.                                                    |

```bash
pnpm test               # full unit test suite (66 tests)
pnpm test:e2e           # Playwright with automatic Compose up/down
pnpm build              # type-check + web build
pnpm --filter @workflow-engine/web test:watch   # Vitest watch
```
