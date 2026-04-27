# Janusly

> The AI operator for your business workflows.

Janusly turns business processes into observable, learning DAGs. It runs them on a BullMQ worker, decides routes with a built-in decision engine + RL adjustments, rolls back when confidence drops, and explains every run in natural language. With an OpenAI key it becomes an end-to-end AI operator: prompt → workflow → execution → decision → learning → rollback → conversational explainability. Without one, every deterministic path still works.

> Design system: **Cobalt** (`#245BFF`) primary with **Cyan** (`#06B6D4`) accent. Tokens declared CSS-first via `@theme {}` in [`apps/web/src/index.css`](apps/web/src/index.css).

---

## What Janusly does

- **Plan**: generate a workflow DAG from a prompt (`POST /ai/generate-workflow`).
- **Run**: execute it on a Postgres-backed runtime + BullMQ workers, with retries, dead-letter queue, timeouts.
- **Decide**: `router` / `router_llm` nodes pick a route via a decision engine (cost / latency / quality + RL on past pulls).
- **Learn**: every node outcome updates `routing_stats`; reinforcement learning shifts future scoring.
- **Improve & rollback**: a confidence model compares before/after metrics; below 30% it auto-creates a rollback workflow version.
- **Explain**: natural-language Q&A about any past run (`POST /ai/explain-run`), and counterfactual decision replay (`GET /causal`).
- **Operate**: visual builder with React Flow, Crew Timeline for multi-agent runs, Dead Letters operations panel.

---

## Architecture

```txt
apps/
  api        -> HTTP API (control plane, plain Node http)
  web        -> React 19 + Vite 8 + React Flow UI

packages/
  engine     -> runtime, scheduler, executors, BullMQ worker, OTEL
  domain     -> decision engine, RL, causal reasoning, improvement engine
  data       -> drizzle repos: routing stats, improvements, rollback
  ai         -> OpenAI-backed run explainer + deterministic fallback
  db         -> drizzle schema + idempotent bootstrap
  shared     -> Zod 4 contracts for the workflow DSL
```

The worker lives at `packages/engine/src/worker.ts` and runs with `pnpm --filter @janusly/engine dev`.

---

## Stack

| Layer       | Library                                                                |
| ----------- | ---------------------------------------------------------------------- |
| Runtime     | Node.js 24 LTS (Krypton), Postgres 18, Redis 8                         |
| TypeScript  | 6.0                                                                     |
| Backend     | `bullmq`, `ioredis`, `drizzle-orm`/`postgres-js`, `openai`             |
| AI          | `openai` SDK with `gpt-4o-mini` default; fallback paths everywhere     |
| Validation  | `zod` 4                                                                 |
| UI          | React 19, Vite 8 (Rolldown), `@xyflow/react`, Tailwind 4               |
| State       | `zustand` 5                                                             |
| Auth        | `@supabase/supabase-js` 2 (optional)                                   |
| Observability | OpenTelemetry SDK (traces) + Prometheus exporter                     |
| Tests       | Vitest 4 (jsdom + Testing Library), Playwright                         |

---

## Requirements

- Node.js **24+** (`engines.node` enforced at root)
- PNPM **10** (`corepack enable`)
- Docker (for Postgres 18 + Redis 8 services)
- (Optional) OpenAI API key — see [`docs/ai.md`](docs/ai.md)

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
pnpm --filter @janusly/api dev      # http://localhost:3001

# 4. Start the worker in another terminal
pnpm --filter @janusly/engine dev

# 5. Start the UI in a third terminal
pnpm --filter @janusly/web dev      # http://localhost:5173
```

Open <http://localhost:5173> — Janusly signs you in as `dev-user` in org `default`. Click **Validate**, **Save**, **Run**. Open the **Runs** tab and chat with the **AI Run Explainer**. The first reply will be `mode: "fallback"` until you add an OpenAI key — see [§ AI](#ai-janusly-as-an-ai-operator).

When you're done:

```bash
docker compose down
```

### Test commands

```bash
pnpm test       # 96 Vitest tests (shared + engine + ai + domain + web) + tsc on api/db/data
pnpm build      # type-check + Vite production build (Rolldown, manualChunks)
pnpm test:e2e   # Playwright; boots Compose, runs UI flow, tears Compose down
```

### End-to-end smoke via curl

```bash
curl -X POST http://localhost:3001/workflows/save \
  -H "Content-Type: application/json" \
  -H "x-org-id: default" -H "x-user-id: dev-user" \
  -d @docs/examples/github-uppercase.json

RUN=$(curl -s -X POST http://localhost:3001/start \
  -H "Content-Type: application/json" \
  -H "x-org-id: default" -H "x-user-id: dev-user" \
  -d @docs/examples/github-uppercase.json)
RUNID=$(echo "$RUN" | jq -r .runId)

curl -s "http://localhost:3001/run?runId=$RUNID" \
  -H "x-org-id: default" -H "x-user-id: dev-user" | jq .
```

---

## AI: Janusly as an AI operator

The AI surfaces are listed in detail in [`docs/ai.md`](docs/ai.md). Quick summary:

| Feature | Endpoint / surface | Without OpenAI key | With key |
| --- | --- | --- | --- |
| Generate a workflow from a prompt | `POST /ai/generate-workflow` | Returns a seeded template | LLM emits a real DAG |
| Explain a workflow | `POST /ai/explain-workflow` | Generic placeholder | Bullet walkthrough |
| Run-level Q&A chat | `POST /ai/explain-run` + UI Runs tab | Deterministic summary (failures / retries / decisions / rollbacks) | Free-form answers |
| Agent planner | `agent.config.planner: "openai"` | Rules planner | LLM picks tools per step |
| Causal reasoning | `GET /causal?runId=...&nodeId=...` | Always available — pure logic | Same |
| Health check | `GET /ai/health` | `{ enabled: false }` | `{ enabled: true, model, ... }` |

**Activate AI in 30 seconds:**

```bash
cp .env.example .env
echo "OPENAI_API_KEY=sk-xxxxxxxxxxxx" >> .env
pnpm --filter @janusly/api dev    # restart
curl -s http://localhost:3001/ai/health -H "x-org-id: default" -H "x-user-id: dev-user"
```

```json
{ "enabled": true, "model": "gpt-4o-mini", "timeoutMs": 30000, "maxRetries": 2 }
```

---

## Roles & permissions

| Role    | Capabilities                                                                  |
| ------- | ----------------------------------------------------------------------------- |
| viewer  | Read-only: workflows, runs, members, audit, dead letters                      |
| editor  | Validate, save workflows, start runs, resume `waiting` nodes, replay/resolve dead letters |
| admin   | Invite/remove members, change roles, install plugins, manage credentials      |

Permissions are enforced per organization through `org_members`. In `dev-headers` mode (no Supabase configured outside production) the default role is `admin`. `service-token` mode requires an explicit `org_members` row — there is no implicit admin grant.

---

## Documentation

| Topic | File |
| --- | --- |
| Local AI configuration & verification | [`docs/ai.md`](docs/ai.md) |
| Node types, configs, outputs, templating | [`docs/nodes.md`](docs/nodes.md) |
| HTTP API request/response examples | [`docs/api.md`](docs/api.md) |
| Full workflow examples (DAG JSON) | [`docs/workflows.md`](docs/workflows.md) |
| Runnable example payload | [`docs/examples/github-uppercase.json`](docs/examples/github-uppercase.json) |

---

## Credentials & auth

Three independent layers, see [§ Credentials](#credentials):

1. **App login** — dev headers (`x-org-id` + `x-user-id`) or Supabase JWT for production.
2. **Workflow secrets** — `{{secret.NAME}}` resolves at run time from `process.env.NAME`. Register the *name* via the **Secrets** tab; keep the value in `.env` / your vault.
3. **AI provider** — `OPENAI_API_KEY` for the AI-native paths.

### Credentials

#### App login (UI auth)

- **Dev mode (default):** the UI sends `x-org-id=default` and `x-user-id=dev-user`. No setup needed.
- **Supabase mode (production):** create a free project at <https://supabase.com>, copy the `Project URL`, `anon public key`, and `service_role key`. Set in `.env`:

  ```env
  SUPABASE_URL=https://xxxxx.supabase.co
  SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...
  VITE_SUPABASE_URL=https://xxxxx.supabase.co
  VITE_SUPABASE_ANON_KEY=eyJhbGc...
  ```

  Once configured, dev headers are rejected by the API. Override for hybrid test/staging with `ALLOW_DEV_AUTH_HEADERS=true`. In `NODE_ENV=production`, the API refuses to start without either Supabase credentials **or** `ALLOW_DEV_AUTH_HEADERS=true`.

#### Workflow secrets

```bash
# 1. Register the reference (name only)
curl -X POST http://localhost:3001/credentials \
  -H "Content-Type: application/json" \
  -H "x-org-id: default" -H "x-user-id: dev-user" \
  -d '{"name":"GitHub bot","kind":"github","secretRef":"GITHUB_TOKEN"}'

# 2. Add the value in .env (or your vault)
# GITHUB_TOKEN=ghp_xxxxxx

# 3. Use it in a node
# { "type": "http", "config": { "headers": { "Authorization": "Bearer {{secret.GITHUB_TOKEN}}" } } }
```

#### AI provider

See [`docs/ai.md`](docs/ai.md) for the full guide.

---

## Status

### Implemented

- Postgres persistence (workflows, versions, runs, events, memberships, audit, plugins, credentials, dead letters, routing stats, workflow improvements).
- BullMQ queue + worker with concurrency, exponential backoff, retry policy, timeouts, dead-letter queue, replay adapter.
- DAG validation: types, cycles, sandboxed expressions, tool input schemas, start node detection.
- 14 node types: `noop`, `http`, `condition`, `transform`, `loop`, `tool`, `agent`, `multi_agent`, `agent_reflection`, `ai`, `webhook`, `approval`, `router`, `router_llm`.
- 3 builtin tools: `http.request`, `text.uppercase`, `json.pick`.
- **Decision engine**: scores candidates by cost/latency/quality, applies RL, honors strategies (cheapest / fastest / balanced / auto), respects budget caps.
- **Improvement engine**: computes confidence between metric snapshots, auto-rollback under 30%, auto-promote over 70%.
- **Causal replay**: counterfactual reasoning over past `decision.made` events.
- **AI explainability**: OpenAI-backed run Q&A with a deterministic fallback that never crashes.
- **Observability**: OpenTelemetry traces, Prometheus metrics exporter, structured logging.
- React 19 + Tailwind 4 UI: builder, Crew Timeline, Inspector, Runs (with AI chat + DLQ ops), Members, Templates, Tools, Secrets.
- Auto-refresh on terminal run state via shared `platformVersion` signal.
- Vitest 4 unit suites across `shared`, `engine`, `ai`, `domain`, `web` (101 tests, includes the atomic-claim race-condition guard for concurrent workers). Playwright e2e.

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
| `packages/domain`        | Vitest 4 for decision engine, causal reasoning, improvement engine, RL.            |
| `packages/ai`            | Vitest 4 for run explainer (mocks the OpenAI client).                              |
| `apps/api`, `packages/db`, `packages/data` | `tsc --noEmit` as a type guard.                                  |

```bash
pnpm test               # full unit test suite (101 tests)
pnpm test:e2e           # Playwright with automatic Compose up/down
pnpm build              # type-check + web build
pnpm --filter @janusly/web test:watch   # Vitest watch
```
