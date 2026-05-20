# Janusly

> **The operational backbone for AI workflows.**
> Janusly is being built to make AI workflows feel less like fragile demos and more like production infrastructure: observable, recoverable, reviewable, auditable.

**Purpose:** make AI workflows dependable enough for the boring, critical work companies actually run every day.

## Why Janusly exists

Every company is racing to put AI into production. Most discover the same hard truth: an LLM that works perfectly in a demo is a different animal in week three — when it's running a billing flow at 3am and something upstream broke, when the credential rotated and nobody noticed, when the third-party API silently changed its contract.

Workflow tools were built for the **integration era** — drag-and-drop connectors between APIs that already worked. They were not built for the **AI era**, where the hardest question is not "how do I wire these systems together?" but "what happens when the model returns nonsense, the secret expires, or a step that worked yesterday fails today?"

**Janusly is being built to answer that question.** The vision is a control plane for AI workflows where every step leaves evidence, every failure creates a recovery path, every fix can be reviewed before rollout, and every workflow can evolve without losing human control. Running an AI workflow should become as operationally boring as running a database: instrumented, backed up, recoverable, auditable, and trusted enough for work that matters.

The number we hold ourselves to is **Mean Time To Recovery for failed automations**: from hours to minutes, from minutes to seconds.

## Where Janusly is going

Janusly's end state is not another automation builder. It is the operating layer teams trust for AI-driven business processes: support triage, refunds, billing exceptions, incident response, reporting, back-office approvals, and every workflow where model output, human judgment, and external systems meet.

The product is taking shape around four bets:

- **Observe every run.** A workflow should leave enough structured evidence for any operator to understand what happened.
- **Explain every failure.** The system should translate runtime state into a clear root cause, owner, and recovery path.
- **Recover safely.** AI can suggest, but production changes must be reviewable, sandboxed, auditable, and reversible.
- **Improve over time.** Every accepted or rejected fix should teach the operator loop how this business wants to run.

This is the destination, not a claim that every edge is finished today. The direction is deliberate: Janusly should become the place where AI workflows stop being demos and start becoming dependable operations.

## What ships today

Janusly already has the core shape of that vision:

- A Postgres-backed workflow runtime for observable DAG execution.
- A Recovery Center that surfaces failed runs, failure clusters, pending human actions, and recovery metrics.
- AI-assisted failure explanation and 1–3 patch suggestions with confidence scores.
- Sandbox validation before applying a recovery patch, cluster-level apply for repeated failures, and one-click rollback through workflow version history.
- Deterministic fallback paths when no Anthropic key is configured, so non-AI runtime behavior still works.

**In one line:** Run critical AI workflows, explain failures, propose safe fixes, and evolve workflow versions with full auditability.

## What Janusly is NOT

- Not a "better Zapier UI." Recovery, not integration breadth, is the wedge.
- Not "n8n with AI." AI is part of the engine, not a button glued on top.
- Not generic RPA. We operate AI workflows; we don't click-record desktop scripts.
- Not "agents that do everything." Human approval gates are first-class; the operator stays in the loop.

See [`docs/PLAN.md` §16.0](docs/PLAN.md) for the full positioning thesis, or [`docs/marketing/narrative.md`](docs/marketing/narrative.md) for the brand-voice version — same anchors, written for a slide or a sales conversation.

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
| Generate a workflow from a prompt | `POST /ai/generate-workflow` | Returns a seeded template | LLM emits an Anthropic-safe typed DAG via `generateObject({ schema: AiGenerationWorkflowSchema })`, then the API re-validates it through the engine workflow gates |
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
