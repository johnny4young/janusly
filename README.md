# Janusly

> **The operational backbone for AI workflows.**
>
> Janusly is an agent-native workflow orchestration and recovery platform. Build, run, observe, and recover durable AI automations—with human approvals, audit trails, and deterministic safeguards.

**Purpose:** turn fragile AI automations into dependable operations for the boring, critical work companies actually run every day.

## Why Janusly exists

Every company is racing to put AI into production. Most discover the same hard truth: an LLM that works perfectly in a demo is a different animal in week three — when it's running a billing flow at 3am and something upstream broke, when the credential rotated and nobody noticed, when the third-party API silently changed its contract.

Workflow tools were built for the **integration era** — drag-and-drop connectors between APIs that already worked. They were not built for the **AI era**, where the hardest question is not "how do I wire these systems together?" but "what happens when the model returns nonsense, the secret expires, or a step that worked yesterday fails today?"

**Janusly answers that question by treating recovery as a first-class runtime concern.**

It provides a control plane where humans and AI agents can operate workflows without surrendering deterministic safeguards: every step leaves evidence, every failure creates a recovery path, every fix can be reviewed before rollout, and every workflow can evolve without losing human control. Running an AI workflow should become as operationally boring as running a database: instrumented, backed up, recoverable, auditable, and trusted enough for work that matters.

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

The recovery loop is production-shaped end to end:

- **Observable runtime.** Postgres-backed DAG execution with per-node `run_events`, live SSE run streaming, a unified Runs workspace for overview / chronology / agent activity, a Recovery Center home surfacing failed runs / failure clusters / pending approvals / MTTR-style recovery metrics, and OpenTelemetry traces + Prometheus metrics.
- **Diagnosis + patch.** AI failure explanation and 1–3 patch suggestions with self-rated confidence, calibrated per approach against the team's own accept/reject history, with a Recovery Confidence Passport that scores whether a patch is safe to apply.
- **Safe recovery.** Sandbox validation (write-side effects skipped) before any patch saves, immediate cluster-level apply for small cohorts, paced and cancellable replay campaigns with durable per-item progress for larger cohorts, one-click rollback through version history, production redrive that continues a failed run on the patched version, and progressive baseline/canary delivery with minimum-sample automatic return when the canary success guardrail is breached.
- **Reproducible recovery drills.** Solution Packs expose safe, selectable credential, AI-output, rate-limit, contract-drift, upstream-failure, and worker-interruption scenarios. Every drill records its source and enters the same recovery queue used by runtime failures; the worker-interruption scenario crosses the configured age threshold and exercises the real stalled-node reaper rather than inserting a synthetic terminal failure. Recovery Queue measures each drill from failure to verified terminal success or accepted loss and then observes the existing seven-day production recurrence window. Recovery Center turns those bounded facts into a per-organization validation dossier with explicit completion, recovery, operator-intervention, timing, and failure-mode denominators plus Markdown/JSON exports; partner count, setup time, and willingness-to-pay remain external evidence.
- **Containment.** A transient-error fast path that auto-retries the failures that would have healed anyway (429 / dropped connection / gateway timeout) before they reach the DLQ, and a circuit breaker that pauses a workflow after repeated failures — buffering inbound trigger events for backfill on resume instead of dropping them.
- **Evidence-gated Recovery Playbooks** that promote a proven fix, with a per-playbook success scorecard.
- **Operate + govern.** Visual React Flow builder, per-org RBAC with a closed permission catalog and custom roles, append-only audit log per action, SSO (WorkOS) + SCIM directory sync, cost/budget governance, an encrypted tenant Credential Secret Store, signed Slack recovery buttons, prompt-generated deterministic PagerDuty off-hours workflows with optional post-action AI summaries, an MCP client (workflow tool nodes) and MCP server (proxying the API to agent ecosystems), and typed Node + Python SDKs.
- **Runs without an LLM.** Every AI surface degrades to a deterministic fallback, so the runtime works with no model key configured.

**In one line:** Let humans and AI agents build, run, inspect, and safely recover critical workflows on a durable, auditable runtime.

See [`CHANGELOG.md`](CHANGELOG.md) for release-facing traceability. Architecture
invariants and operational contracts live under [`docs/architecture/`](docs/architecture/).
For metrics, traces, queue topology, retention, repair jobs, and the local or
Grafana Cloud starter stack, see [`docs/observability.md`](docs/observability.md).

## What Janusly is NOT

- Not a "better Zapier UI." Recovery, not integration breadth, is the wedge.
- Not "n8n with AI." AI is part of the engine, not a button glued on top.
- Not generic RPA. We operate AI workflows; we don't click-record desktop scripts.
- Not "agents that do everything." Human approval gates are first-class; the operator stays in the loop.

### So how do you reach a system Janusly doesn't ship?

Built-in vendor tools cover Slack, GitHub, and PagerDuty, plus vendor-neutral
building blocks (`http.request`, `webhook.send`, `db.query.*`, `vector.*`,
`email.send`, `pdf.generate`, and text/JSON/CSV/time utilities). Everything
else comes through **MCP**: register a Model Context Protocol server once and
its tools become workflow nodes with the same retry, dead-letter, replay, and
run-timeline behavior as a built-in tool.

That is why "not integration breadth" is a scope decision rather than a gap —
breadth is delegated to an open ecosystem instead of hand-written one logo at a
time. See [`docs/mcp.md`](docs/mcp.md) for connecting a server, the per-tool
opt-in model, and the safety posture that applies to servers you did not write.


> Design system: **Cobalt** (`#245BFF`) primary with **Cyan** (`#06B6D4`) accent. [`apps/web/src/index.css`](apps/web/src/index.css) imports the ordered hand-written modules; tokens are declared CSS-first via `@theme {}` in [`apps/web/src/styles/foundations.css`](apps/web/src/styles/foundations.css).

---

## What Janusly does

- **Build**: generate a workflow DAG from a prompt (`POST /ai/generate-workflow`, stable alias `/v1/ai/generate-workflow`), draft / edit on a React Flow canvas with Run timeline + Step setup panels, save versions automatically.
- **Run**: execute on a Postgres-backed runtime + BullMQ workers with retries, dead-letter queue, timeouts, and per-org rate limits.
- **Recover** (the differentiator):
  - **Suggest a fix.** When a run lands in DLQ, `POST /ai/patch-workflow` (stable alias `/v1/ai/patch-workflow`) returns 1–3 alternative patches with self-rated confidence (0–100) and an `approachLabel` per option (`add_retry` / `raise_timeout` / `swap_secret_ref` / `add_approval` / `fix_url` / `other`). The Recovery dialog renders them as tabs sorted by confidence desc.
  - **Sandbox before commit.** `POST /dlq/validate-fix` runs the proposed patch against a writes-skipped sandbox replay. Save + production replay only fire when the sandbox terminates `succeeded`.
  - **Apply across the cluster.** `GET /dlq/clusters` (stable alias `/v1/dlq/clusters`) groups DLQ entries by failure signature; `POST /dlq/cluster-apply` replays every entry that shares the cluster signature in one bulk action with per-row signature recheck. Stable clients list bounded summaries through `/v1/dlq` and replay an exact entry through `POST /v1/dlq/replay` with its `deadLetterId`.
  - **Rollback.** `POST /workflows/rollback` (also contracted as `/v1/workflows/rollback`) validates the historical DAG, appends it as the new latest version with bounded conflict retries, reconciles schedules after commit, and writes a `workflow.rolled_back` audit row.
- **Decide**: `router` / `router_llm` nodes pick a route via a decision engine (cost / latency / quality + RL on past pulls).
- **Learn**: executed nodes write org-scoped `routing_stats`; router candidates read those per-node counters, so repeated successes / failures bias future route scoring. When an evaluated workflow change has a baseline version and confidence falls below 30%, the improvement engine rolls back to that base version.
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
  db         -> drizzle schema + checked-in migrations
  shared     -> Zod 4 contracts for the workflow DSL
  mcp-server -> stdio MCP server that proxies Janusly API tools
  solution-packs -> code-resident installable workflow starter catalog
  sdk-node   -> typed `@janusly/sdk` HTTP client (Node 24 ESM package, zero runtime deps,
                stable /v1 envelopes + async iterators + opt-in retries +
                webhook signature verifier — see `packages/sdk-node/README.md`)
  sdk-python -> typed `janusly` Python client + stdlib webhook verifier
```

The worker lives at `packages/engine/src/worker.ts` and runs with `pnpm --filter @janusly/engine dev`.

---

## Stack

| Layer       | Library                                                                |
| ----------- | ---------------------------------------------------------------------- |
| Runtime     | Node.js 24, Postgres 15+ (18 baseline), Redis 8                           |
| TypeScript  | 7.0                                                                     |
| Backend     | `bullmq`, `ioredis`, `drizzle-orm`/`postgres-js`, Vercel `ai` SDK      |
| AI          | Vercel AI SDK with **`anthropic/claude-haiku-4-5-20251001`** as the supported MVP provider. `LlmClient` registry also carries `openai` for future expansion, but production posture is Anthropic-only until cross-provider verification reopens it. Every AI surface has a deterministic fallback; attempted LLM-call failures surface `{ mode: "fallback", aiError, ... }`. |
| Validation  | `zod` 4                                                                 |
| UI          | React 19, Vite 8 (Rolldown), `@xyflow/react`, Tailwind 4               |
| State       | `zustand` 5                                                             |
| Auth        | `@supabase/supabase-js` 2 (optional)                                   |
| Observability | OpenTelemetry SDK (traces) + Prometheus exporter                     |
| Tests       | Vitest 4 (jsdom + Testing Library), Playwright                         |

---

## Requirements

- Node.js **24** (`engines.node` rejects earlier and future major versions)
- PNPM **11** (`corepack enable`; the exact version is pinned in `packageManager`)
- Docker (for Postgres + Redis 8 + Ollama services in local dev)
- (Optional) Anthropic API key — see [`docs/ai.md`](docs/ai.md). MVP support posture is Anthropic-only; OpenAI is registered in the provider abstraction but not currently a verified runtime target.

### Supported-version matrix (self-host)

The **floor** is the oldest version CI proves green; the **baseline** is what the dev/prod fleet runs. Node 24 is the only supported JavaScript runtime and every Node CI lane uses it. `test_compat_pg15` separately proves the Postgres 15 compatibility floor.

| Component | Floor (CI-verified) | Baseline (dev/prod) |
| --------- | ------------------- | ------------------- |
| Node.js   | 24 LTS (Krypton)    | 24 LTS (Krypton)    |
| Postgres  | 15 (+ `pgvector`)   | 18 (+ `pgvector`)   |
| Redis     | 8                   | 8                   |

Self-hosting on an older Postgres? Point Compose at it: `JANUSLY_POSTGRES_IMAGE=pgvector/pgvector:pg15 docker compose up postgres`.

---

## Quick start

Three steps to a working local stack with the dev-mode UI (no auth setup needed):

```bash
# 1. Install dependencies
corepack enable
pnpm install

# 2. Start Postgres, Redis, Ollama, API, worker, and web
pnpm dev

# 3. Open the Studio
# http://127.0.0.1:5173
```

Open <http://127.0.0.1:5173> after `pnpm dev` prints its ready line — Janusly signs you in as `dev-user` in org `default`. Click **Validate**, **Save**, **Run**. Open **Runs** to move between **Overview**, **Timeline**, and **Agents** without losing the active execution, or chat with the **AI Run Explainer**. The first reply will be `mode: "fallback"` until you add an `ANTHROPIC_API_KEY` to `.env` — see [§ AI](#ai-janusly-as-an-ai-operator). Port `5173` is strict: if another process owns it, startup fails instead of silently moving the Studio. Use `pnpm dev:doctor` to clear an orphan.

The web server binds loopback-only by default. Deliberate LAN or container exposure is explicit: `JANUSLY_DEV_HOST=0.0.0.0 pnpm dev`.

The first `pnpm dev` boot may take several minutes while Ollama pulls the `bge-m3` embedding model into the `ollama_models` volume. That model is only used after memory is enabled with both `JANUSLY_MEMORY_ENABLED=true` and the tenant `memory.enabled` config flag.

When you're done, press `Ctrl+C` in the `pnpm dev` terminal. The orchestrator shuts down API, worker, web, and Compose.

### Persistent local integration lab

Use the dedicated Docker profile when identities, workflows, runs, and recovery
evidence must survive restarts:

```bash
pnpm local:auth:up
pnpm local:db:verify
# Studio: http://127.0.0.1:7310
```

Supabase supplies one PostgreSQL database: Auth owns the `auth` schema and
Janusly owns `public`. A clean mount contains no users, organizations,
workflows, credentials, tenant configuration, or example canvas nodes; create
the first account and workspace manually. Unlike the short-lived `pnpm dev`
test topology, this stack keeps API and worker behavior production-shaped.
Explicit smoke commands can install bounded provider fixtures and locally
simulate GitHub, Slack, signed webhooks, and email without contacting public
providers. See
[`docs/local-deployment.md`](docs/local-deployment.md) for lifecycle commands,
failure injection, persistence, safety boundaries, optional Ollama memory, and
the explicit simulator-to-external-provider switch for private real-use tests.

### Use Janusly from Claude Desktop / Cursor (MCP)

`packages/mcp-server` ships an agent-complete workflow surface over stdio:
discover, author, validate, save, start, poll, inspect, resume/cancel, and
recover. It advertises 24 inspection/AI tools plus 13 writes only when both MCP
write-consent flags are enabled. Every tool uses a runtime-validated `/v1`
contract, closed input schema, structured result, and explicit risk hints;
expected failures return normal `isError` tool results. Secrets and broad
platform administration remain operator-owned. With `pnpm dev` running, drop
this into `~/Library/Application Support/Claude/claude_desktop_config.json` (or
your platform equivalent) and restart Claude Desktop:

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

See [`packages/mcp-server/README.md`](packages/mcp-server/README.md) for setup,
and [`docs/architecture/mcp-server.md`](docs/architecture/mcp-server.md) for the
architecture and deliberate control-plane boundaries.

### Root commands

```bash
pnpm dev             # full local stack: Compose + migrate + api/worker/web; waits for HTTP readiness
pnpm local:auth:up   # persistent empty-start lab: Supabase Auth + one PostgreSQL DB
pnpm local:db:verify # prove auth/public share that database
pnpm local:smoke     # inbound event + GitHub/Slack/webhook/email simulator path
pnpm local:failure-smoke # controlled provider outage + fail-closed DLQ evidence
pnpm local:ui-smoke  # Chromium smoke against the persistent stack
pnpm local:verify    # provider smoke + full restart persistence proof
pnpm local:down      # stop the persistent stack without deleting its volumes
pnpm local:reset     # destructively remove persistent local-stack data
pnpm dev:doctor      # free api/web ports (:3001, :5173, legacy :5174); add --compose to tear Compose down too
pnpm stop            # docker compose stop (keeps volumes)
pnpm clean           # docker compose down -v (removes local volumes)
pnpm migrate         # apply Drizzle migrations against DATABASE_URL
pnpm contract:generate # regenerate apps/api/openapi.v1.json from Zod route contracts
pnpm contract:check  # fail when the checked-in OpenAPI 3.1 contract has drifted
pnpm typecheck       # TypeScript 7 gate across every typed workspace, including web tests
pnpm test            # Vitest across the workspace packages
pnpm test:browser    # Vitest browser mode for *.browser.test.tsx (Playwright/Chromium)
pnpm test:accessibility # Playwright + axe on high-value operator journeys
pnpm build           # workspace production builds, including the Vite/Rolldown web bundle
pnpm test:e2e        # Playwright; boots Compose, runs UI flow, tears Compose down
pnpm test:integration # data integration lane: Compose Postgres + migrate + real-DB SQL tests, down
pnpm evals           # scripts/run-evals.mjs against /ai/generate-workflow (assumes pnpm dev is up)
pnpm evals:local     # one-command local regression gate: boots Compose + API, runs golden evals, tears down (spends AI credits only if a provider key is configured)
pnpm evals:baseline  # snapshot the current ai-mode / shape-pass rates into evals/baseline.json (the regression floors)
pnpm test:evals      # node:test for the eval-gate logic (scripts/evals-baseline.mjs) — $0, no API
pnpm seed:demos      # explicit opt-in demo credentials; never runs at startup
pnpm seed:recovery-matrix  # explicit opt-in DLQ fixtures for recovery testing
pnpm seed:full       # explicit opt-in full demo dataset; never runs at startup
pnpm backfill:usage-workflowid  # one-off legacy usage_events workflow attribution backfill
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
| Generate a workflow from a prompt | `POST /ai/generate-workflow` | Returns a seeded template | Default `free_json` mode asks the LLM for JSON text, parses it through `AiGenerationWorkflowSchema`, promotes supported noop placeholders, then validates through the engine workflow gates. Strict graph failures get up to 2 targeted self-repair attempts before fallback. Legacy `constrained` mode keeps `generateObject({ schema })` available by config |
| Explain a workflow | `POST /ai/explain-workflow` | Generic placeholder | Bullet walkthrough |
| Review a workflow for production-readiness | `POST /ai/review-workflow` | Deterministic readiness gate (`checkWorkflowReadiness`) | LLM semantic pass on top of the deterministic gate |
| Run-level Q&A chat | `POST /ai/explain-run` + UI Runs tab | Deterministic summary (failures / retries / decisions / rollbacks) | Free-form answers |
| Agent planner | `agent.config.planner: "openai"` | Rules planner | LLM picks tools per step |
| Causal reasoning | `GET /causal?runId=...&nodeId=...` | Always available — pure logic | Same |
| Health check | `GET /ai/health` | `{ enabled: false }` | `{ enabled: true, provider, model, generationMode }` |

### Failure recovery loop

| Feature | Endpoint / surface | Without provider key | With key |
| --- | --- | --- | --- |
| Suggest 1–3 alternative patches for a failed run | `POST /ai/patch-workflow` | `{ mode: "fallback" }` with the original workflow untouched | Array of suggestions with `approachLabel` + self-rated confidence per tab; route fan-out-merges + validates each |
| Sandbox-validate a patch before saving | `POST /dlq/validate-fix` | Always available — sandbox is provider-agnostic | Same; gates the production save+redrive chain |
| Apply a patch across every DLQ entry sharing a failure signature | `POST /dlq/cluster-apply` | Always available | Same; recovery dialog reuses the multi-suggestion tabs in cluster mode |
| Preview and run a paced, cancellable replay campaign | `POST /recovery/campaigns/preview`, `POST /recovery/campaigns` | Always available — deterministic cohort verification and durable queueing | Same |
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
{ "enabled": true, "provider": "anthropic", "model": "claude-haiku-4-5-20251001", "generationMode": "free_json", "timeoutMs": 30000, "maxRetries": 2 }
```

OpenAI is registered in the provider abstraction for future expansion but is **not a supported runtime target** in the current MVP. `free_json` removes the `/ai/generate-workflow` structured-output `oneOf` blocker, but OpenAI remains unverified until it passes the eval harness and release smoke. Don't switch a tenant's `ai.provider` away from `anthropic` without a verification plan; see `AGENTS.md` "AI integration" for the full operating posture.

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
| The run model: persistence, status machine, observability, audit reconstruction | [`docs/architecture/run-model.md`](docs/architecture/run-model.md) |
| Environment variables and runtime configuration | [`docs/configuration.md`](docs/configuration.md) |
| Local AI configuration & verification | [`docs/ai.md`](docs/ai.md) |
| Node types, configs, outputs, templating | [`docs/nodes.md`](docs/nodes.md) |
| Connecting tools Janusly doesn't ship (MCP) | [`docs/mcp.md`](docs/mcp.md) |
| HTTP API request/response examples | [`docs/api.md`](docs/api.md) |
| Full workflow examples (DAG JSON) | [`docs/workflows.md`](docs/workflows.md) |
| Runnable example payload | [`docs/examples/github-uppercase.json`](docs/examples/github-uppercase.json) |

---

## Credentials & auth

Four independent layers, see [§ Credentials](#credentials):

1. **App login** — dev headers (`x-org-id` + `x-user-id`) or Supabase JWT for production.
2. **Integration credentials** — tenant values default to envelope-encrypted PostgreSQL rows protected by one external deployment root key; legacy environment references remain available.
3. **Raw template secrets** — `{{secret.NAME}}` still resolves deployment-owned `process.env.NAME` directly when no operator-managed credential is needed.
4. **AI provider** — `ANTHROPIC_API_KEY` + `JANUSLY_LLM_PROVIDER=anthropic` for the AI-native paths.

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

#### Integration credentials

Configure one 32-byte deployment root key first (`openssl rand -base64 32`).
For the persistent local stack, `pnpm local:up` generates and mounts an
ignored mode-0600 key automatically. Other deployments should mount
`JANUSLY_CREDENTIAL_MASTER_KEY_FILE` from their secret manager (or set the
base64/hex `JANUSLY_CREDENTIAL_MASTER_KEY` value directly).

```bash
# Accept a tenant secret once; API responses and audits never return it.
curl -X POST http://localhost:3001/credentials \
  -H "Content-Type: application/json" \
  -H "x-org-id: default" -H "x-user-id: dev-user" \
  -d '{"name":"GitHub bot","kind":"github_token","secretValue":"replace-me"}'
```

The credential row stores only an opaque reference. A random data key encrypts
each version; the deployment root key wraps that data key. Rotate from the UI
or `POST /credentials/:name/bulk-update`; deleting the credential revokes its
managed version. Back up the root key in your secret manager, separately from
database backups — restoring managed credentials needs both, and neither is
useful alone ([docs/configuration.md](docs/configuration.md) covers loss
recovery and troubleshooting).

Legacy environment references remain explicit migration compatibility:

```bash
curl -X POST http://localhost:3001/credentials \
  -H "Content-Type: application/json" \
  -H "x-org-id: default" -H "x-user-id: dev-user" \
  -d '{"name":"Legacy GitHub bot","kind":"github_token","secretRef":"GITHUB_TOKEN"}'
# Then inject GITHUB_TOKEN through .env or the deployment vault.
```

Workflow integration nodes store only the operator-facing credential name.
`org_configs`, workflow JSON, action evidence, and audit metadata are not secret
stores. See [`docs/configuration.md`](docs/configuration.md#credential-secret-store).

PagerDuty uses two credential kinds (`pagerduty_api_token` and
`pagerduty_webhook_secret`). Describe the off-hours rule in AI Studio; Janusly
compiles a visible deterministic trigger/read/evaluate/acknowledge/snooze graph
without requiring an LLM. Configuration stays versioned in the normal workflow
Inspector and evidence stays in run history. See
[`docs/architecture/integrations.md`](docs/architecture/integrations.md#prompt-generated-pagerduty-off-hours-workflow)
and [`docs/local-deployment.md`](docs/local-deployment.md#pagerduty-local-qualification).

#### Raw template secrets

```json
{
  "type": "http",
  "config": {
    "headers": { "Authorization": "Bearer {{secret.DEPLOYMENT_OWNED_TOKEN}}" }
  }
}
```

This open-ended template form reads the process environment directly and is
separate from operator-managed integration credentials.

#### AI provider

See [`docs/ai.md`](docs/ai.md) for the full guide.

---

## Testing

| Package                  | Stack                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `apps/web`               | Vitest 4 + jsdom + Testing Library (utilities, store, components, recovery dialog tabs). Playwright e2e, including an axe serious/critical accessibility floor. Browser-mode pool for `*.browser.test.tsx`. |
| `packages/shared`        | Vitest 4 over the Zod workflow contracts + `computeWorkflowDiff` + status enums.   |
| `packages/engine`        | Vitest 4 for expressions, validation, templates, tool registry, secrets, memory, planner, error-signature classifier, recovery metrics, workflow health, cluster failures. |
| `packages/domain`        | Vitest 4 for decision engine, causal reasoning, improvement engine, RL.            |
| `packages/ai`            | Vitest 4 for the provider-neutral `LlmClient`, run explainer, multi-suggestion patch helper (mocked LLM). |
| `apps/api`               | Vitest 4 for the patch envelopes (multi-suggestion array), the recovery-fixture matrix, rollback transaction, cluster recovery glue, route registry, rate limiter, run pagination. |
| `packages/db`            | Vitest 4 for migration layout, full Drizzle/latest-snapshot parity, hot-path indexes, and lifecycle defaults; `tsc --noEmit` as a type guard. |
| `packages/data`          | Vitest 4 for bounded repositories and real-Postgres integration behavior; `tsc --noEmit` as a type guard. |
| `packages/mcp-server`      | Vitest 4 for MCP stdio protocol, tool descriptors, auth headers, and dispatch. |
| `packages/solution-packs`  | Vitest 4 for pack schema validity, fixture integrity, and public catalog shape. |
| `packages/sdk-node`        | Vitest 4 for typed client headers, stable envelopes, polling/streaming, reports, recovery, and webhooks; isolated npm-tarball consumer smoke. |
| `packages/sdk-python`      | Pytest for auth, stable envelopes, runs, reports, recovery, and webhooks; mypy/ruff plus isolated wheel/sdist smoke. |

```bash
pnpm test               # full Vitest workspace suite
pnpm test:browser       # Vitest browser-mode (Playwright/Chromium) for `*.browser.test.tsx`
pnpm test:accessibility # axe serious/critical gate on settled Playwright UI states
pnpm test:e2e           # Playwright with automatic Compose up/down
pnpm typecheck          # TypeScript 7 across typed production and test sources
pnpm build              # workspace production builds
pnpm dev:doctor         # free orphaned dev ports (:3001, :5173, legacy :5174) after a crashed local run
pnpm --filter @janusly/web test:watch   # Vitest watch
```

---

## Glossary

Acronyms used throughout this README and the wider Janusly codebase ([`AGENTS.md`](AGENTS.md) / [`docs/`](docs/)).

| Acronym | Stands for | What it means in Janusly |
| --- | --- | --- |
| **AI** | Artificial Intelligence | Anything routed through an LLM provider (Anthropic by default). Every AI surface has a deterministic non-AI fallback. |
| **API** | Application Programming Interface | The HTTP control plane in `apps/api` (plain Node `http`, no framework). |
| **CAS** | Compare-And-Swap | The "atomic claim" pattern used in concurrency-sensitive transitions — `UPDATE … WHERE status='pending'` in `tryClaimNodeForQueue`, and `UPDATE … WHERE status='validated'` in the auto-healing publication claim so concurrent operator-click vs auto-apply cannot double-publish (the loser returns 409 while the winner completes through the durable replay receipt). |
| **CRUD** | Create / Read / Update / Delete | Basic record-level operations against a resource (e.g. workflows, members, credentials). |
| **CSS** | Cascading Style Sheets | The design system is hand-written CSS behind the ordered `apps/web/src/index.css` entrypoint; Tailwind 4 CSS-first tokens live in `apps/web/src/styles/foundations.css`. |
| **DAG** | Directed Acyclic Graph | The workflow shape: nodes + edges, no cycles. The engine executes nodes in topological order. |
| **DI** | Dependency Injection | The "seam" pattern used to keep `@janusly/engine` DB-agnostic — `setBudgetChecker`, `setUsageRecorder`, `setEngineRateLimiter`, `setIntegrationUsageRecorder`, `setEmailUsageRecorder`, `setPdfUsageRecorder`, `setMcpUsageRecorder`. Wired to the real implementations from `@janusly/data` at API + worker boot. |
| **DLQ** | Dead Letter Queue | Where a node lands after exhausting its `retryPolicy.maxAttempts`. Surfaced in the Recovery Center for triage / replay. |
| **DSL** | Domain-Specific Language | The Zod 4 workflow schema in `@janusly/shared` — the typed contract that defines what a Janusly workflow can be. |
| **HMAC** | Hash-based Message Authentication Code | Symmetric-key signing primitive. Janusly uses HMAC-SHA256 for `human_form` resume tokens, one-time WorkOS SSO state and opaque browser-session cookie envelopes, `webhook.send` outbound bodies (`X-Janusly-Signature: t=…,v1=…`), and the WorkOS / SCIM inbound webhook signature check. |
| **HTTP** | HyperText Transfer Protocol | The wire protocol for the control-plane API and for outbound `http` nodes (which go through the SSRF-guarded `fetchHttpTarget` chokepoint). |
| **JIT** | Just-In-Time | The membership-provisioning seam in `apps/api/src/auth.ts`: a brand-new SSO user with no `org_members` row but a matching `verified_domains` or pending `invitations` row gets a row written *during* the auth resolution path (or right before, in the SSO callback) so the resolver finds them at step 1 on the next request. |
| **JSON** | JavaScript Object Notation | The serialization format for workflow definitions, node configs, run state, and API request/response bodies. |
| **JWT** | JSON Web Token | The token shape Supabase issues for app login; the API verifies it on every request when Supabase mode is on. |
| **LLM** | Large Language Model | The model behind every AI surface. Provider-neutral via `LlmClient`; production posture is Anthropic-only (`claude-haiku-4-5-20251001`). |
| **LTS** | Long-Term Support | Node.js 24 LTS (codename Krypton) is the only supported JavaScript runtime. |
| **MCP** | Model Context Protocol | The Anthropic-defined protocol for exposing tools to LLM clients. Janusly ships an MCP server (`packages/mcp-server`) and consumes external MCP servers as `mcp_tool` workflow nodes. |
| **MFA** | Multi-Factor Authentication | A marker flag on `org_configs.auth.mfaRequired`. **Informational only** — Janusly warn-logs server-side when set, but actual enforcement happens at the IdP (Okta / Azure AD carry the claim, Supabase does not). |
| **MTTR** | Mean Time To Recovery | The north-star metric: how long from a failed automation to that automation working again. Surfaced on `GET /recovery/metrics` and as an SLO threshold field (`mttrSeconds`). |
| **MVP** | Minimum Viable Product | The current shipping scope — Anthropic-only LLM support, single recovery loop, no cross-provider verification yet. |
| **OTEL** | OpenTelemetry | The tracing / metrics stack. Tracer + Meter carry `service.name="janusly"`; Prometheus exporter is wired in. |
| **p95** | 95th percentile | Latency notation: 95% of runs / nodes finish at or below this duration. Surfaced on the workflow health rollup, the recovery metrics dashboard, and as an SLO threshold (`p95DurationMs`). |
| **PNPM** | Performant Node Package Manager | The package manager used at the monorepo root (pinned to `pnpm@11` via `packageManager`). |
| **RL** | Reinforcement Learning | The decision-engine layer that reads per-node `routing_stats` and shifts future router scoring after enough observed successes / failures. |
| **RPA** | Robotic Process Automation | Click-record desktop automation (UiPath / Automation Anywhere shape). Janusly is *not* this — it operates AI workflows, not desktop scripts. |
| **SCIM** | System for Cross-domain Identity Management | The IdP-side standard for pushing user / group lifecycle into a SaaS. Janusly consumes SCIM through WorkOS Directory Sync via `POST /webhooks/workos/directory`, normalizing events into `org_members` upserts / deactivations. |
| **SDK** | Software Development Kit | The first-party clients: `packages/sdk-node` (`@janusly/sdk`) and `packages/sdk-python` (`janusly`); both are locally installable while registry publication remains disabled. |
| **SLO** | Service Level Objective | The per-workflow reliability contract (success rate %, p95 duration, MTTR seconds, etc.) persisted on `workflow_versions.slo_json`. Breaches surface on `GET /workflows/health` and in the Inspector's SLO panel; they do *not* change the numeric health score, they are an orthogonal alert signal. |
| **SSO** | Single Sign-On | The "log in once with my company IdP" flow. Janusly's SSO is WorkOS-backed: `GET /auth/sso/start` → IdP → `GET /auth/sso/callback` creates a revocable server session and sets an opaque HttpOnly cookie. Per-org `enforced_sso: true` rejects non-SSO modes outside dev. |
| **SSRF** | Server-Side Request Forgery | The attack class where a workflow author tricks the engine into hitting an internal endpoint (e.g. `169.254.169.254` AWS metadata). Defence is the `fetchHttpTarget` / `validateHttpTarget` chokepoint plus DNS-pinning the validated IP onto the actual TCP connect via an `undici.Agent`. |
| **TTL** | Time To Live | How long a token, session, or cache entry stays valid. Applies to the WorkOS browser session (default 8h, range `300..86400` via `org_configs.auth.sessionTtlSeconds`), the SSO state token (10 min), the `human_form` resume token (7 days), the Anthropic prompt cache (5 min), and the consent-revocation memory purge delay (default 7 days). |
| **UI** | User Interface | The React 19 + Vite 8 + React Flow Studio app in `apps/web`. |
| **URL** | Uniform Resource Locator | Endpoint addresses; outbound URLs in workflows are SSRF-validated before connect via a DNS-pinned `undici.Agent`. |
