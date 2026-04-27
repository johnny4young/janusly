# AI configuration (local)

Janusly runs as an **AI operator**: it plans workflows from prompts, decides which route to take when a `router` node fires, learns from past runs (RL), and explains every run in natural language. All of this works without a key (using deterministic fallbacks). Configuring an OpenAI key lights up the AI-native paths.

This guide covers local setup. For production secret management, point the same env var at your vault (Doppler, AWS Secrets Manager, Supabase Vault, etc.).

---

## 1. What AI powers in Janusly

| Feature | Endpoint / surface | Without key | With key |
| --- | --- | --- | --- |
| Generate a workflow from a natural-language prompt | `POST /ai/generate-workflow` | Returns the seeded `http-ai-summary` template | LLM emits a real DAG that conforms to the contract |
| Explain a saved workflow | `POST /ai/explain-workflow` | Plain-language local summary | Bullet-pointed walkthrough |
| Conversational chat about a finished run | `POST /ai/explain-run` + **AI Run Explainer** in the Runs tab | Deterministic summary (failures / retries / decisions / rollbacks counts) | LLM answers free-form questions ("why did this fail?", "what should I change?") |
| AI prompt step inside a workflow | `ai` node | Captures the prompt and returns a local fallback summary | LLM answers with run context |
| Agent planner inside `agent` / `multi_agent` nodes | `config.planner: "openai"` | Falls back to the rules planner | LLM picks the next tool per step |
| Causal reasoning over past decisions | `GET /causal?runId=...&nodeId=...` | Always available — pure logic, no LLM | Same |
| Health / introspection | `GET /ai/health` | `{ enabled: false }` | `{ enabled: true, model, timeoutMs, maxRetries }` |

Note: causal reasoning, decision engine, RL adjustments, and rollback are 100% deterministic and run without an OpenAI key.

---

## 2. Get an OpenAI key

1. Go to <https://platform.openai.com/api-keys>.
2. Click **Create new secret key**.
3. Copy the `sk-...` value. It is shown only once.

---

## 3. Wire it locally

`.env.example` lives at the repo root and is auto-loaded for development. Create a `.env` (gitignored) for real secrets:

```bash
cp .env.example .env
```

Edit `.env` and add:

```env
OPENAI_API_KEY=sk-xxxxxxxxxxxx

# Optional tuning
OPENAI_MODEL=gpt-4o-mini       # default
OPENAI_TIMEOUT_MS=30000        # default
OPENAI_MAX_RETRIES=2           # default
```

**Restart the API** after editing `.env` (the API reads env at boot):

```bash
pnpm --filter @janusly/api dev
```

The worker also picks up `OPENAI_API_KEY` for `agent` nodes with `planner: "openai"`.

---

## 4. Verify AI is live

```bash
curl -s http://localhost:3001/ai/health \
  -H "x-org-id: default" -H "x-user-id: dev-user"
```

```json
{
  "enabled": true,
  "model": "gpt-4o-mini",
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
{ "mode": "ai", "answer": "...", "model": "gpt-4o-mini" }
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

Default model is `gpt-4o-mini`. Typical costs per call (OpenAI list price, April 2026):

| Endpoint | Tokens (typical) | Cost per call |
| --- | --- | --- |
| `/ai/generate-workflow` | 600 in / 400 out | ~$0.0003 |
| `/ai/explain-workflow` | 400 in / 250 out | ~$0.0002 |
| `/ai/explain-run` (10 events) | 800 in / 350 out | ~$0.0004 |
| `/ai/explain-run` (200 events) | 6000 in / 600 out | ~$0.0020 |
| `ai` node | 800 in / 250 out | ~$0.0003 |
| `agent` step with `planner: "openai"` | 300 in / 150 out | ~$0.0001 |

To switch model (e.g. for higher accuracy on workflow generation):

```env
OPENAI_MODEL=gpt-4o
```

---

## 7. Common issues

### `mode: "fallback"` on every call
Either `OPENAI_API_KEY` is missing or you didn't restart the API after editing `.env`. Confirm with `GET /ai/health`.

### `mode: "error"` with a 401
The key is invalid or revoked. Generate a fresh one.

### `mode: "error"` with a 429
Quota exceeded or rate-limited. Add billing on the OpenAI dashboard or lower `WORKER_CONCURRENCY` so agents don't burst.

### `/ai/explain-run` says "Run not found"
The run id is for a different org. The API enforces `org_members` scoping — check `x-org-id` header.

### AI generates invalid workflow JSON
The endpoint returns HTTP 502 with `{ mode: "error", error: "..." }`. Try a more specific prompt; `gpt-4o` is more reliable than `gpt-4o-mini` for code-shaped output.

### `decisionEvent: "No decision event"` on `/causal`
The node you queried isn't a `router` / `router_llm`, or the run didn't reach that node. Causal replay needs an emitted `decision.made` event.

---

## 8. AI-first flow inside Janusly

```
Prompt
  → /ai/generate-workflow → DAG
  → POST /workflows/save  → versioned
  → POST /start           → execution
       ├ router/router_llm → decide() picks the route
       │   └ scoreCandidate + RL adjustments
       ├ ai → summarize or decide from run context
       ├ agent (rules|openai) → loop with reflection
       ├ tool / http / transform / loop / condition
       └ approval / webhook → human resume
  → run.status (terminal)
       ├ updateRoutingStats() → RL learns which route paid off
       ├ computeConfidence()  → improvement vs. baseline
       └ shouldRollback()     → auto-rollback if confidence < 30
  → /ai/explain-run         → LLM answers the user's "why"
  → /causal                 → counterfactual replay of the decision
```

This is why we treat Janusly as an **AI operator**, not just a workflow engine: it plans, runs, decides, learns, rolls back, and explains.

---

## 9. Privacy notes

Janusly sends to OpenAI, by call:

- `/ai/generate-workflow` — only the user prompt.
- `/ai/explain-workflow` — the workflow DAG JSON (no run data).
- `/ai/explain-run` — the run row + event list. Event payloads can include node outputs, so review what your `transform` and `http` nodes emit before pointing at production.
- `ai` node — the prompt plus current run context.
- `agent (planner: openai)` — the goal, the available tools list, and the loop history.

Never put live PII or secrets in node outputs. Use `{{secret.NAME}}` so values are resolved at run time and never persisted in events.
