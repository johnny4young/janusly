# AI configuration (local)

Janusly runs as an **AI operator**: it plans workflows from prompts, decides which route to take when a `router` node fires, learns from past runs (RL), proposes 1–3 alternative patches per failed run with self-rated confidence, and explains every run in natural language. All of this works without a key (using deterministic fallbacks). Configuring a provider key lights up the AI-native paths.

The supported runtime provider for the current MVP is **Anthropic** (`claude-haiku-4-5-20251001`). The `openai` provider is registered in the abstraction (built on the Vercel AI SDK) for future expansion but is not currently a verified runtime target — see AGENTS.md "AI integration" for the operating posture. The instructions below default to Anthropic; OpenAI examples are kept at the end of each section for reference only.

This guide covers local setup. For production secret management, point the same env var at your vault (Doppler, AWS Secrets Manager, Supabase Vault, etc.).

---

## 1. What AI powers in Janusly

### 1a. Authoring & explanation

| Feature | Endpoint / surface | Without key | With key |
| --- | --- | --- | --- |
| Generate a workflow from a natural-language prompt | `POST /ai/generate-workflow` | Returns the seeded `http-ai-summary` template | LLM emits a typed DAG via `generateObject({ schema: WorkflowSchema })` |
| Explain a saved workflow | `POST /ai/explain-workflow` | Plain-language local summary | Bullet-pointed walkthrough |
| AI semantic review of a workflow | `POST /ai/review-workflow` | Deterministic readiness gate (`checkWorkflowReadiness`) | LLM finds ambiguous prompts, raw secrets, missing approvals upstream of write-side actions, and ambiguous tool inputs |
| Conversational chat about a finished run | `POST /ai/explain-run` + **AI Run Explainer** in the Runs tab | Deterministic summary (failures / retries / decisions / rollbacks counts) | LLM answers free-form questions ("why did this fail?", "what should I change?") |
| AI prompt step inside a workflow | `ai` node | Captures the prompt and returns a local fallback summary | LLM answers with run context |
| Agent planner inside `agent` / `multi_agent` nodes | `config.planner: "openai"` (legacy field name; resolves to the configured `ai.provider`) | Falls back to the rules planner | LLM picks the next tool per step |
| Causal reasoning over past decisions | `GET /causal?runId=...&nodeId=...` | Always available — pure logic, no LLM | Same |
| Health / introspection | `GET /ai/health` | `{ enabled: false }` | `{ enabled: true, provider, model, timeoutMs, maxRetries }` |

### 1b. Failure recovery loop

| Feature | Endpoint / surface | Without key | With key |
| --- | --- | --- | --- |
| Suggest 1–3 alternative patches for a failing node | `POST /ai/patch-workflow` | `{ mode: "fallback" }` with a single 0-confidence "other" item and the original workflow untouched | Per-failing-node-type envelope returns `suggestions: Array<{ workflow, rationale, approachLabel, confidence }>` (1–3 items, sorted by confidence desc). Recovery dialog renders one tab per item. |
| Sandbox-validate a proposed patch before saving | `POST /dlq/validate-fix` | Always available — sandbox is provider-agnostic | Same; gates the production save+replay chain |
| Apply a patch across every DLQ entry sharing a failure signature | `POST /dlq/cluster-apply` | Always available | Same; recovery dialog reuses the multi-suggestion tabs in cluster mode |
| Failure clustering | `GET /dlq/clusters` | Always available — deterministic signature classifier | Same |
| Roll back a workflow to any prior version | `POST /workflows/rollback` | Always available — pure CRUD | Same |
| Per-workflow health rollup | `GET /workflows/health` | Always available — pure aggregation | Same |
| Org-wide recovery metrics dashboard | `GET /recovery/metrics` | Always available — pure aggregation | Same |

Note: causal reasoning, decision engine, RL adjustments, sandbox replay, cluster apply, rollback, failure clustering, and metrics are 100% deterministic and run without a provider key. The provider key only unlocks AI-mode for the patch suggestions themselves and the authoring/explanation surfaces in 1a.

---

## 2. Get an Anthropic key (with credit!)

1. Go to <https://console.anthropic.com/settings/keys>.
2. Click **Create Key**.
3. Copy the `sk-ant-...` value. It is shown only once.
4. **Add credit** at <https://console.anthropic.com/settings/billing>. A valid key with **zero credit** is the most common reason every call returns the graceful fallback (`mode: "fallback"` with `aiError: "Anthropic 429: ..."` or quota messages). With credit on you'll see `mode: "ai"`.

(For OpenAI — kept here for reference only since OpenAI is not currently a verified runtime target — the equivalent steps are <https://platform.openai.com/api-keys> and <https://platform.openai.com/account/billing>.)

---

## 3. Wire it locally

`.env.example` lives at the repo root and is auto-loaded for development. Create a `.env` (gitignored) for real secrets:

```bash
cp .env.example .env
```

Edit `.env` and add (Anthropic-MVP, supported):

```env
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxx
JANUSLY_LLM_PROVIDER=anthropic

# Optional tuning
ANTHROPIC_MODEL=claude-haiku-4-5-20251001  # default
OPENAI_TIMEOUT_MS=30000                    # historical env name; applies to every provider
OPENAI_MAX_RETRIES=2                       # historical env name; applies to every provider
```

For OpenAI (registered for future expansion, currently unverified), `OPENAI_API_KEY=sk-...` plus `JANUSLY_LLM_PROVIDER=openai` is enough — but expect `/ai/generate-workflow` to fall back due to the `oneOf` strict-mode rejection.

**Restart both the API and the worker** after editing `.env` — env is captured at process start:

```bash
pnpm --filter @janusly/api dev      # terminal 1 — powers /ai/* endpoints
pnpm --filter @janusly/engine dev   # terminal 2 — powers `agent` (planner:"openai") and `ai` step types
```

`loadRootEnv()` (in `packages/db/src/env.ts`) loads BOTH `.env.example` (defaults) and `.env` (overrides) for every workspace process — never put `OPENAI_API_KEY` in `apps/api/.env` or `packages/engine/.env`, those paths aren't read.

### Where the provider key is read

The provider abstraction lives in `packages/ai/src/llm-client.ts` (built on the Vercel AI SDK). Every AI surface routes through `LlmClient.generateText` / `LlmClient.generateObject`. The API and worker both build a client at boot — neither has provider-specific code outside the registry. The relevant env vars per provider:

| Provider | Required env | Optional env |
| --- | --- | --- |
| `anthropic` (MVP) | `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL` (default `claude-haiku-4-5-20251001`) |
| `openai` (registered, currently unverified) | `OPENAI_API_KEY` | `OPENAI_MODEL` (default `gpt-4o-mini`) |

The selected provider comes from `JANUSLY_LLM_PROVIDER` (env) or `ai.provider` (per-org config) — `org_configs` overrides env when present. Per-call overrides flow through the `model` field on a workflow node or API request body: a bare id (`"claude-haiku-4-5-20251001"`) uses the configured provider; `"<provider>/<model>"` (e.g. `"anthropic/claude-haiku-4-5-20251001"`) overrides provider for that one call.

If `/ai/health` says `enabled: true` but a runtime call still falls back, the worker process is missing the env var — restart it too.

---

## 4. Verify AI is live

```bash
curl -s http://localhost:3001/ai/health \
  -H "x-org-id: default" -H "x-user-id: dev-user"
```

```json
{
  "enabled": true,
  "provider": "anthropic",
  "model": "claude-haiku-4-5-20251001",
  "timeoutMs": 30000,
  "maxRetries": 2
}
```

If `enabled: false`, the API didn't see the key — confirm `.env` is at the repo root (not inside `apps/api/`) and restart.

### Test explain-run end-to-end

```bash
# 1. Start a run
RUN=$(curl -s -X POST http://localhost:3001/start \
  -H "Content-Type: application/json" \
  -H "x-org-id: default" -H "x-user-id: dev-user" \
  -d @docs/examples/github-uppercase.json)
RUNID=$(echo "$RUN" | jq -r .runId)

sleep 2

# 2. Ask AI about it
curl -s -X POST http://localhost:3001/ai/explain-run \
  -H "Content-Type: application/json" \
  -H "x-org-id: default" -H "x-user-id: dev-user" \
  -d "{\"runId\":\"$RUNID\",\"question\":\"Why did this finish so fast and what nodes ran?\"}" | jq .
```

With a key:
```json
{ "mode": "ai", "answer": "...", "model": "claude-haiku-4-5-20251001", "provider": "anthropic" }
```

Without a key:
```json
{ "mode": "fallback", "answer": "Run summary: 5 events observed.\n..." }
```

### Test generate-workflow

```bash
curl -s -X POST http://localhost:3001/ai/generate-workflow \
  -H "Content-Type: application/json" \
  -H "x-org-id: default" -H "x-user-id: dev-user" \
  -d '{"prompt":"Fetch GitHub trending repos, uppercase the top name, and call our /webhook"}' | jq .
```

---

## 5. Use it from the UI

1. **Open** <http://localhost:5173>.
2. Start in **AI Copilot** and describe the outcome you want. With no key, Janusly loads a deterministic starter workflow; with a key, it drafts a workflow from the prompt.
3. Click **Explain current flow** to get a plain-language explanation of the canvas.
4. Click **Run** on the workflow.
5. Switch to **Run history** and ask Janusly what happened. Each reply tags `mode: "ai"` (LLM) or `mode: "fallback"` (deterministic) so you always know which path served the answer.

---

## 6. Cost expectations

Default model is `claude-haiku-4-5-20251001` (Anthropic). Typical costs per call (Anthropic list price, April 2026; tokens are illustrative):

| Endpoint | Tokens (typical) | Cost per call |
| --- | --- | --- |
| `/ai/generate-workflow` | 600 in / 400 out | ~$0.0007 |
| `/ai/explain-workflow` | 400 in / 250 out | ~$0.0004 |
| `/ai/review-workflow` | 700 in / 350 out | ~$0.0006 |
| `/ai/explain-run` (10 events) | 800 in / 350 out | ~$0.0006 |
| `/ai/explain-run` (200 events) | 6000 in / 600 out | ~$0.0030 |
| `/ai/patch-workflow` (1 suggestion)  | 900 in / 250 out | ~$0.0006 |
| `/ai/patch-workflow` (3 suggestions) | 900 in / 700 out | ~$0.0010 |
| `ai` node | 800 in / 250 out | ~$0.0006 |
| `agent` step | 300 in / 150 out | ~$0.0002 |

Cost is computed inside `packages/ai/src/pricing.ts` (`JANUSLY_LLM_PRICE_<MODEL>=<inputUsdPer1M>,<outputUsdPer1M>` overrides per model) and recorded on every LLM call as a `usage_events` row (`metric: "llm.completion"`, `metadata.costUsd`).

To switch model (e.g. for higher accuracy on workflow generation):

```env
ANTHROPIC_MODEL=claude-sonnet-4-5-20251001
```

---

## 7. Common issues

### `mode: "fallback"` on every call (with no `aiError`)
The API never saw `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY` if you set `JANUSLY_LLM_PROVIDER=openai`). Confirm with `GET /ai/health`. If it says `enabled: false`, the key is missing or the API didn't restart after editing `.env`.

### `mode: "fallback"` with `aiError: "...quota..." / "...credit..."`
The key is valid but the provider account has no billing/credit left. The API **gracefully falls back** to deterministic content and surfaces `aiError` so the UI can warn you. Add credit (Anthropic: <https://console.anthropic.com/settings/billing>; OpenAI: <https://platform.openai.com/account/billing>), retry — no restart needed.

### `mode: "fallback"` with `aiError: "Invalid API key" / "Unauthorized"`
The key is rejected. Generate a fresh one and update `.env`. Restart the API and worker.

### `mode: "fallback"` with `aiError: "Rate limit ..." / "429 ..."`
You're sending requests faster than your tier allows. Lower `WORKER_CONCURRENCY` and/or pause and retry; the fallback content is still served so the run continues. The org-level rate limiter (`AI_RATE_LIMIT_PER_MIN`) is independent and lives in Redis.

### `/ai/patch-workflow` returns `mode: "fallback"` with `aiError: "no_valid_suggestions"`
The LLM did emit suggestions but none survived `WorkflowSchema.safeParse` + `sanitizeAiWorkflow` + the engine's tool-input validation. With concrete per-type envelopes now covering 9 of the 11 supported node types (`http` / `tool` / `agent` / `transform` / `condition` / `ai` / `router` / `approval` / `loop`), the remaining causes are narrower: (a) the failure needs a **structural multi-node patch** (adding an upstream `approval` node, splitting one node into two) — the per-failing-node-config envelope can't express that, regardless of node type; (b) a tool's runtime input schema (the engine's `validateToolInput`) rejects the merged config even when the array patch parsed cleanly — happens when the patched fields don't match the registered tool's required field shape; (c) `multi_agent` or `noop` failures (still on the generic envelope) where the model emits an empty `patchedConfig: {}`. For now, manually edit the failing node in the Inspector before replaying; structural multi-node patches remain the next recovery gap.

### `/ai/explain-run` says "Run not found"
The run id is for a different org. The API enforces `org_members` scoping — check the `x-org-id` header.

### AI generates an "invalid workflow"
`/ai/generate-workflow` calls `llm.generateObject({ schema: WorkflowSchema })` so the model returns a typed object directly. The route then runs `sanitizeAiWorkflow` (`apps/api/src/index.ts`) which filters edge `condition` strings and `condition`-node expressions through the engine's limited grammar — non-grammar-valid expressions are dropped (edge condition stripped) or replaced with `"true"` (condition node). Schema-validation failures and sanitize throws degrade to `mode: "fallback"` with `aiError: "AI returned a workflow with validation issues: ..."`. Try a higher-tier model (`ANTHROPIC_MODEL=claude-sonnet-4-5-20251001`) for higher structural reliability if your prompts are complex.

### Worker calls `agent` with `planner: "openai"` but it still uses rules
The worker process needs its own restart after changing `.env`. The historical `planner: "openai"` field name resolves to the configured `ai.provider` at runtime — under the MVP Anthropic posture, `planner: "openai"` actually calls Anthropic. The fallback also fires when the LLM call throws — check the worker logs for the `aiError` payload on `agent.step.planned` events.

### `decisionEvent: "No decision event"` on `/causal`
The node you queried isn't a `router` / `router_llm`, or the run didn't reach that node. Causal replay needs an emitted `decision.made` event.

---

## 8. AI-first flow inside Janusly

```
Prompt
  → /ai/generate-workflow → typed DAG (generateObject + sanitizeAiWorkflow)
  → /ai/review-workflow   → readiness gate + AI semantic pass
  → POST /workflows/save  → versioned
  → POST /start           → execution
       ├ router/router_llm → decide() picks the route
       │   └ scoreCandidate + RL adjustments
       ├ ai → summarize or decide from run context
       ├ agent (rules|configured provider) → loop with reflection
       ├ tool / http / transform / loop / condition
       └ approval / webhook → human resume
  → run.status (terminal)
       ├ updateRoutingStats()  → RL learns which route paid off
       ├ computeConfidence()   → improvement vs. baseline
       ├ shouldRollback()      → auto-rollback if confidence < 30
       └ failure ⇒ DLQ
  → recovery loop (when DLQ entries exist)
       ├ /dlq/clusters         → group by failure signature
       ├ /ai/patch-workflow    → 1–3 alternative patches with confidence
       ├ /dlq/validate-fix     → sandbox replay (writes skipped)
       ├ /dlq/cluster-apply    → bulk replay across the signature cluster
       └ /workflows/rollback   → one-click rollback to any prior version
  → /ai/explain-run         → LLM answers the user's "why"
  → /causal                 → counterfactual replay of the decision
```

This is why we treat Janusly as an **AI operator**, not just a workflow engine: it plans, runs, decides, learns, recovers, rolls back, and explains.

---

## 9. Privacy notes

Janusly sends to the configured provider. The supported MVP deployment target is Anthropic (`JANUSLY_LLM_PROVIDER=anthropic`), even though the registry default remains OpenAI for backwards compatibility, by call:

- `/ai/generate-workflow` — only the user prompt.
- `/ai/explain-workflow` — the workflow DAG JSON (no run data).
- `/ai/review-workflow` — the workflow DAG JSON (no run data).
- `/ai/explain-run` — the run row + event list. Event payloads can include node outputs, so review what your `transform` and `http` nodes emit before pointing at production.
- `/ai/patch-workflow` — the workflow snapshot, the failing node id, the persisted error envelope, and the recent run events. All values pass through the `safe-persist` chokepoint (sensitive-key redaction + size cap) AND a secret-shape scrub (`sk-...`, `ghp_...`, `xox[baprs]-...`, `Bearer ...`, JWTs, AWS access keys) before leaving the API boundary. Defense in depth: never ship the prompt to a remote LLM with un-scrubbed payloads.
- `ai` node — the prompt plus current run context.
- `agent (planner: "openai")` — historical field name; at runtime it uses the configured provider. Sends the goal, the available tools list, and the loop history.

Never put live PII or secrets in node outputs. Use `{{secret.NAME}}` so values are resolved at run time and never persisted in events.
