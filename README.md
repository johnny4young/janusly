# Janusly

> **Operator-grade workflow recovery.** When a run fails, AI proposes 1–3 alternative fixes with confidence scores. Sandbox-validate before saving. Apply across every similar failure with one click. One-click rollback if a patch goes wrong.

Janusly is an AI operator for business workflows — a DAG runtime where AI is part of the loop, not glued on top. The differentiator is the **failure-recovery loop**: AI patch suggestions with self-rated confidence, sandbox replay before commit, cluster apply across DLQ entries that share a failure signature, and one-click rollback. Generic workflow execution (durable retries, decision engine, RL adjustments, NL run explanations) is the table-stakes layer underneath. With an Anthropic key it becomes an end-to-end AI operator: prompt → workflow → execution → decision → learning → recovery → rollback → conversational explainability. Without one, every deterministic path still works.

> Design system: **Cobalt** (`#245BFF`) primary with **Cyan** (`#06B6D4`) accent. Tokens declared CSS-first via `@theme {}` in [`apps/web/src/index.css`](apps/web/src/index.css).

---

## What Janusly does

- **Build**: generate a workflow DAG from a prompt (`POST /ai/generate-workflow`), draft / edit on a React Flow canvas with Run timeline + Step setup panels, save versions automatically.
- **Run**: execute on a Postgres-backed runtime + BullMQ workers with retries, dead-letter queue, timeouts, and per-org rate limits.
- **Recover** (the differentiator):
  - **Suggest a fix.** When a run lands in DLQ, `POST /ai/patch-workflow` returns 1–3 alternative patches with self-rated confidence (0–100) and an `approachLabel` per option (`add_retry` / `raise_timeout` / `swap_secret_ref` / `add_approval` / `fix_url` / `other`). The Recovery dialog renders them as tabs sorted by confidence desc.
  - **Sandbox before commit.** `POST /dlq/validate-fix` runs the proposed patch against a writes-skipped sandbox replay. Save + production replay only fire when the sandbox terminates `succeeded`.
  - **Apply across the cluster.** `GET /dlq/clusters` groups DLQ entries by failure signature; `POST /dlq/cluster-apply` replays every entry that shares the cluster signature in one bulk action with per-row signature recheck.
  - **Rollback.** `POST /workflows/rollback` saves any prior version's DAG as the new latest in a single transaction with a `workflow.rolled_back` audit row.
- **Decide**: `router` / `router_llm` nodes pick a route via a decision engine (cost / latency / quality + RL on past pulls).
- **Learn**: every node outcome updates `routing_stats`; reinforcement learning shifts future scoring. Rollback fires automatically when a confidence delta drops below 30%.
- **Explain**: natural-language Q&A about any past run (`POST /ai/explain-run`), counterfactual decision replay (`GET /causal`), readiness review with structured findings (`POST /ai/review-workflow`), per-workflow health rollup (`GET /workflows/health`), org-wide recovery metrics dashboard (`GET /recovery/metrics`).
- **Operate**: visual builder with React Flow, Failure Clusters card on the Operations dashboard, per-row Suggest fix + Recover-this-pattern affordances, multi-tenant scoping enforced on every query.

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
  ai         -> provider-neutral LLM surfaces + deterministic fallback
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
| Backend     | `bullmq`, `ioredis`, `drizzle-orm`/`postgres-js`, Vercel `ai` SDK      |
| AI          | Vercel AI SDK with **`anthropic/claude-haiku-4-5-20251001`** as the supported MVP provider. `LlmClient` registry also carries `openai` for future expansion, but production posture is Anthropic-only until cross-provider verification reopens it. Every AI surface has a deterministic fallback (try/catch + `{ mode: "fallback", aiError, ... }`). |
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
- (Optional) Anthropic API key — see [`docs/ai.md`](docs/ai.md). MVP support posture is Anthropic-only; OpenAI is registered in the provider abstraction but not currently a verified runtime target.

---

## Quick start

Three steps to a working local stack with the dev-mode UI (no auth setup needed):

```bash
# 1. Install dependencies
corepack enable
pnpm install

# 2. Start Postgres, Redis, API, worker, and web
pnpm dev

# 3. Open the Studio
# http://localhost:5173
```

Open <http://localhost:5173> — Janusly signs you in as `dev-user` in org `default`. Click **Validate**, **Save**, **Run**. Open the **Runs** tab and chat with the **AI Run Explainer**. The first reply will be `mode: "fallback"` until you add an `ANTHROPIC_API_KEY` to `.env` — see [§ AI](#ai-janusly-as-an-ai-operator). (If port 5173 is already in use, Vite falls back to 5174; both are in `API_ALLOWED_ORIGINS` by default.)

When you're done, press `Ctrl+C` in the `pnpm dev` terminal. The orchestrator shuts down API, worker, web, and Compose.

### Use Janusly from Claude Desktop / Cursor (MCP)

`packages/mcp-server` ships an MCP server that exposes six tools over stdio: five read-only tools (`workflows.list`, `workflows.get`, `recipes.list`, `tools.list`, `runs.get`) plus `workflows.validate`. MCP write tools, including `workflows.save`, stay unavailable until the consent/audit policy lands. With `pnpm dev` running, drop this into `~/Library/Application Support/Claude/claude_desktop_config.json` (or your platform equivalent) and restart Claude Desktop:

```jsonc
{
  "mcpServers": {
    "janusly": {
      "command": "pnpm",
      "args": ["--filter", "@janusly/mcp-server", "start"],
      "env": {
        "JANUSLY_API_URL": "http://127.0.0.1:3001",
        "JANUSLY_API_ORG_ID": "default",
        "JANUSLY_API_USER_ID": "mcp-user"
      }
    }
  }
}
```

See [`packages/mcp-server/README.md`](packages/mcp-server/README.md) for the architecture, auth flow, and how to add new tools.

### Test commands

```bash
pnpm test       # ~535 Vitest tests across shared / engine / ai / domain / web / api / mcp-server
pnpm test:browser  # Vitest browser mode for *.browser.test.tsx (Playwright/Chromium)
pnpm build      # type-check + Vite production build (Rolldown, manualChunks)
pnpm test:e2e   # Playwright; boots Compose, runs UI flow, tears Compose down
pnpm evals      # scripts/run-evals.mjs against /ai/generate-workflow (assumes pnpm dev is up)
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

### Authoring & explanation

| Feature | Endpoint / surface | Without provider key | With key |
| --- | --- | --- | --- |
| Generate a workflow from a prompt | `POST /ai/generate-workflow` | Returns a seeded template | LLM emits a typed DAG via `generateObject({ schema: WorkflowSchema })` |
| Explain a workflow | `POST /ai/explain-workflow` | Generic placeholder | Bullet walkthrough |
| Review a workflow for production-readiness | `POST /ai/review-workflow` | Deterministic readiness gate (`checkWorkflowReadiness`) | LLM semantic pass on top of the deterministic gate |
| Run-level Q&A chat | `POST /ai/explain-run` + UI Runs tab | Deterministic summary (failures / retries / decisions / rollbacks) | Free-form answers |
| Agent planner | `agent.config.planner: "openai"` | Rules planner | LLM picks tools per step |
| Causal reasoning | `GET /causal?runId=...&nodeId=...` | Always available — pure logic | Same |
| Health check | `GET /ai/health` | `{ enabled: false }` | `{ enabled: true, provider, model }` |

### Failure recovery loop

| Feature | Endpoint / surface | Without provider key | With key |
| --- | --- | --- | --- |
| Suggest 1–3 alternative patches for a failed run | `POST /ai/patch-workflow` | `{ mode: "fallback" }` with the original workflow untouched | Array of suggestions with `approachLabel` + self-rated confidence per tab; route fan-out-merges + validates each |
| Sandbox-validate a patch before saving | `POST /dlq/validate-fix` | Always available — sandbox is provider-agnostic | Same; gates the production save+replay chain |
| Apply a patch across every DLQ entry sharing a failure signature | `POST /dlq/cluster-apply` | Always available | Same; recovery dialog reuses the multi-suggestion tabs in cluster mode |
| Failure clustering | `GET /dlq/clusters` | Always available — deterministic signature classifier | Same |
| Roll back a workflow to any prior version | `POST /workflows/rollback` | Always available — pure CRUD with single-transaction insert + audit row | Same |
| Per-workflow health rollup | `GET /workflows/health` | Always available — pure aggregation | Same |
| Org-wide recovery metrics | `GET /recovery/metrics` | Always available — pure aggregation | Same |

**Activate AI in 30 seconds (Anthropic, MVP-supported):**

```bash
cp .env.example .env
echo "ANTHROPIC_API_KEY=sk-ant-xxxxxxxx" >> .env
echo "JANUSLY_LLM_PROVIDER=anthropic" >> .env
pnpm --filter @janusly/api dev    # restart
curl -s http://localhost:3001/ai/health -H "x-org-id: default" -H "x-user-id: dev-user"
```

```json
{ "enabled": true, "provider": "anthropic", "model": "claude-haiku-4-5-20251001", "timeoutMs": 30000, "maxRetries": 2 }
```

OpenAI is registered in the provider abstraction for future expansion but is **not a supported runtime target** in the current MVP — the `/ai/generate-workflow` schema currently trips OpenAI's strict-mode `oneOf` rejection. Don't switch a tenant's `ai.provider` away from `anthropic` without a verification plan; see `AGENTS.md` "AI integration" for the full operating posture.

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
| Environment variables and runtime configuration | [`docs/configuration.md`](docs/configuration.md) |
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
3. **AI provider** — `ANTHROPIC_API_KEY` + `JANUSLY_LLM_PROVIDER=anthropic` for the AI-native paths.

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

## Testing

| Package                  | Stack                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `apps/web`               | Vitest 4 + jsdom + Testing Library (utilities, store, components, recovery dialog tabs). Playwright e2e. Browser-mode pool for `*.browser.test.tsx`. |
| `packages/shared`        | Vitest 4 over the Zod workflow contracts + `computeWorkflowDiff` + status enums.   |
| `packages/engine`        | Vitest 4 for expressions, validation, templates, tool registry, secrets, memory, planner, error-signature classifier, recovery metrics, workflow health, cluster failures. |
| `packages/domain`        | Vitest 4 for decision engine, causal reasoning, improvement engine, RL.            |
| `packages/ai`            | Vitest 4 for the provider-neutral `LlmClient`, run explainer, multi-suggestion patch helper (mocked LLM). |
| `apps/api`               | Vitest 4 for the patch envelopes (multi-suggestion array), the recovery-fixture matrix, rollback transaction, cluster recovery glue, route registry, rate limiter, run pagination. |
| `packages/db`, `packages/data` | `tsc --noEmit` as a type guard.                                              |

```bash
pnpm test               # full unit test suite (~535 tests across shared/engine/ai/domain/web/api/mcp-server)
pnpm test:browser       # Vitest browser-mode (Playwright/Chromium) for `*.browser.test.tsx`
pnpm test:e2e           # Playwright with automatic Compose up/down
pnpm build              # type-check + web build
pnpm --filter @janusly/web test:watch   # Vitest watch
```
