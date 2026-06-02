# Janusly — Strategic & Engineering Plan

> A working document for the next 3–6 months. Written for a small team that is willing to make sharp choices instead of accumulating features.

---

## 1. Executive summary

Janusly is **an AI operator for business workflows** — a workflow engine where AI is part of the runtime, not glued on top. The thesis is that any sufficiently advanced workflow engine becomes an agent platform: you author intent in plain language, the system plans a DAG, decides routes with reinforcement signals, runs them on a durable queue, explains every failure, and proposes patches. We want to make Janusly the obvious choice for teams that are tired of stitching together "n8n + LangChain + their own retry logic" and want one system that actually learns.

What's already here is solid:

- A typed DSL (Zod 4), an in-house DAG runtime, BullMQ-backed scheduler, atomic node claims, transactional run setup, dead-letter queue with replay, OpenTelemetry traces, Prometheus metrics, Postgres persistence with multi-tenant `org_id` scoping.
- A decision engine (cost / latency / quality + RL adjustments), an improvement engine (auto-rollback under 30% confidence), causal reasoning over past decisions.
- Real AI mode end-to-end: prompt → DAG, DAG → explanation, run → conversational answer, agent loop with LLM tool selection, single-prompt `ai` step.
- Graceful fallback on every AI surface, with `aiError` surfaced to the UI and human-readable copy for quota / rate-limit / auth failures.
- A friendly AI-first UI: AI Studio, Run timeline, Step setup, Recovery queue, Recipes, Tools, Connections.

What's still missing to be "the one":

1. **Provider breadth is intentionally paused.** The Vercel AI SDK abstraction is in place, but the supported MVP runtime is Anthropic-only until product explicitly reopens multi-provider verification. OpenAI remains registered for future expansion, not current production posture.
2. **The tool catalog is useful but not business-complete.** Native text / JSON / CSV / time / crypto helpers exist alongside `http.request`; real teams still need revenue-grade tools such as email, Slack, SQL, vector search, file IO, GitHub, calendar, and PDF.
3. **MCP is now two-sided.** Janusly exposes workflow/run/recovery tools to MCP-aware clients through `packages/mcp-server`, and it consumes external MCP servers as `mcp_tool` workflow nodes through `mcp_connections` + `mcp_tool_descriptors`. Writes on both sides stay behind explicit consent gates.
4. **Memory exists, but its reach is narrow.** `memory_entries` + pgvector + Ollama BGE-m3 support recovery recall today; the live agent loop still reads only current-run events via `getRunMemory(runId)`, and explicit memory nodes / generic agent RAG are still future work.
5. **RL is a counter, not a full policy.** `routing_stats` tracks pulls and rewards and affects router scoring, but there is no Thompson-sampling / UCB / contextual-bandit policy across route, model, prompt, and retry choices.
6. **Recovery is real, but policy learning is next.** Janusly now proposes patches, previews diffs, validates in sandbox, captures operator feedback into memory when consent is enabled, applies across clusters, and rolls back. It still needs A/B testing, broader structural patches, and more places where accepted/rejected recovery history changes future decisions.
7. **Trigger surface is still narrow.** Manual run, cron schedules, webhook, approval, and replay cover the MVP. Production workflows still need file events, email/calendar/message-queue triggers, and SaaS event subscriptions.
8. **Distribution surface is thin.** HTTP API + local MCP are enough for development, but customers will want Node/Python SDKs, webhook receiver helpers, release bundles, and Terraform. The first concrete SDK slices are ENG-112 (TypeScript) and ENG-113 (Python + webhook helper).

The plan is structured so each item below is independently shippable and individually adds value, even if the next ones never happen.

---

## 2. Honest assessment of the current state

### Strengths

- Clean engine boundaries: `domain` is pure logic, `data` is repos, `engine` is runtime, `shared` is the contract. No DB calls in domain.
- Atomic semantics where they matter: `tryClaimNodeForQueue`, transactional `startRun`, DLQ-on-final-failure, audit on mutations.
- Graceful degradation everywhere AI is used. The `mode + aiError` contract is consistent.
- Broad test coverage for the project age: Vitest spans shared / engine / ai / domain / data / api / web / MCP surfaces, with browser-mode canvas coverage and Playwright e2e flows. Domain is well-tested for decision/RL/causal/improvement logic.
- Single-language stack. Postgres + Redis only. No Kubernetes-shaped complexity.

### Weaknesses (pivot points)

- **Workflow expressiveness ceiling.** Subworkflows, workflow inputs/outputs, loops, approvals, scheduled triggers, and sandbox replay exist, but event subscriptions and richer human forms are still thin.
- **AI is provider-neutral in code but Anthropic-only in posture.** The abstraction exists and every surface has fallback, but production support currently depends on Anthropic verification; `free_json` removes the generation route's structured-output blocker without making other providers supported. Multi-provider verification is intentionally deferred.
- **Tool input contracts are typed, but provider-native tool calling is still future work.** The in-tree registry validates Zod input/output schemas, AI Studio exposes metadata, and external MCP descriptors are cached/gated separately. What is still missing is a provider-native tool-call loop that lets the LLM call those tools directly instead of emitting workflow JSON.
- **Memory has two tiers.** Recovery uses durable, tenant-scoped `memory_entries` recall; the generic `agent` / `multi_agent` planner still only reads current-run events through `getRunMemory(runId)`. The gap is wiring durable recall into more runtime surfaces without weakening consent, retention, and prompt-injection framing.
- **The reinforcement layer doesn't influence model choice, prompt template, or retry strategy** — only `router` node candidate selection. Model routing should be RL-driven too: cheaper model for low-stakes, premium for high-stakes.
- **One template format.** No notion of parameterized templates ("Slack alert → fill in {channel}"), no template marketplace, no per-org template forks.
- **Some distributed posture is fixed, broader SaaS controls are still thin.** Rate limiting is Redis-backed, migrations are enforced at boot, and ENG-092 added AI budget guardrails; broader plan packaging, quota tiers, and payment/billing UX are still placeholders.
- **Cost governance exists for AI, but not yet for plans.** Every LLM call writes `usage_events` with provider/model/tokens/cost where known, and admins can configure org/workflow AI budgets. Per-plan limits and customer-facing billing workflows remain future work.
- **No SDK.** All integration today is via the HTTP API. Customers will want a Node/Python SDK, a webhook receiver helper, and Terraform.

---

## 3. Strategic positioning — what Janusly should be world-class at

Pick three. Reject the rest.

| # | Position | Why |
| - | -------- | --- |
| 1 | **Explainable failure recovery** | No other workflow engine treats "explain why this run failed and propose a patch" as a first-class loop. We already have run events, DLQ, causal replay, improvement engine. Wire it end-to-end and we own this niche. |
| 2 | **AI-authored, AI-reviewed flows** | The AI Studio drafts. A second-pass agent reviews for security, missing retries, missing approvals, exposed secrets, and produces a structured diff. This is not "AI generates code" — it's "AI proposes a workflow and another AI grades it." |
| 3 | **MCP-native** | Be both client and server. Authoring a workflow from Claude Desktop / Cursor is a one-prompt action. External MCP tools (Sentry, GitHub, Linear, Slack, Zendesk) become workflow steps for free. |

Anti-positions (reject):
- ❌ "Better Zapier UI." UX is a means, not the moat.
- ❌ "n8n with AI." Generic agent-platform race-to-the-bottom.
- ❌ "End-to-end RPA." Not our hardware story.

---

## 4. AI provider abstraction (Vercel AI SDK)

### Why Vercel AI SDK

- Stable provider abstraction (`ai` package + provider plugins): `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/mistral`, `@ai-sdk/ollama`, `@ai-sdk/groq`, `@ai-sdk/azure`.
- SDK support for `generateText`, `streamText`, `generateObject`, and `streamObject`; Janusly's shipped `LlmClient` intentionally exposes only `generateText` + `generateObject` today.
- Tool-call abstraction: `tool({ description, parameters: z.object(...), execute })`. Maps cleanly to our existing tool registry.
- Separate embedding surface: Janusly uses `generateEmbedding` in `@janusly/ai` for the memory substrate (v1 wired to Ollama BGE-m3); it is not part of `LlmClient`.
- Vendor-neutral telemetry: every call exposes `usage.promptTokens`, `usage.completionTokens`, `finishReason`. Drop into `usage_events`.
- Active maintenance, large community, no provider-lockin tax.

### Migration plan

Current status: the provider-neutral `LlmClient`, default free-JSON workflow generation with a legacy constrained mode, usage-event recording, per-node model overrides, and org-level runtime config are already implemented. The operating posture has narrowed since the original migration plan: production, demos, evals, and smoke checks should use Anthropic (`anthropic/claude-haiku-4-5-20251001`) until provider breadth is explicitly reopened. OpenAI remains registered for compatibility and future verification, not as a supported MVP runtime target.

#### Phase A — Add a provider-neutral `LlmClient` interface (shipped)

`packages/ai/src/llm-client.ts`:

```ts
export type LlmInvocation = {
  /** Optional system prompt. */
  system?: string;
  /** User prompt body. */
  prompt: string;
  /** `"json"` maps to provider-specific JSON-mode hints for text generation. */
  responseFormat?: "json" | "text";
  /** Override the org/env default (`"<model>"` or `"<provider>/<model>"`). */
  modelHint?: string;
  /** Stable scope for usage telemetry. */
  context?: { orgId: string; userId?: string; runId?: string; nodeId?: string; workflowId?: string };
};

export interface LlmClient {
  generateText(args: LlmInvocation): Promise<{ text: string; usage?, provider: string; model: string; latencyMs: number; costUsd?: number | null }>;
  generateObject<T>(args: Omit<LlmInvocation, "responseFormat"> & { schema: ZodSchema<T>; schemaName?: string; schemaDescription?: string }): Promise<{ object: T; usage?, provider: string; model: string; latencyMs: number; costUsd?: number | null }>;
}
```

Implementation status:
- `packages/ai/src/llm-client.ts` is the single provider-neutral chokepoint.
- The registry keeps OpenAI and Anthropic entries, but supported runtime use is Anthropic-only until verification expands.
- API and engine call sites route through `LlmClient`, preserve fallback mode, and record usage through the shared recorder.

The client must preserve the existing `mode: "fallback" | "ai"` + `aiError` contract.

#### Phase B — Structured workflow generation envelope (shipped)

`/ai/generate-workflow` now defaults to `free_json`: `llm.generateText({ responseFormat: "json" })` emits JSON text that the API parses through `AiGenerationWorkflowSchema` server-side. The legacy `constrained` mode still calls `llm.generateObject({ schema: AiGenerationWorkflowSchema })`. Both modes return one of Janusly's capped node shapes through the provider abstraction, then run `sanitizeAiWorkflow`, `WorkflowSchema.safeParse`, and the workflow validator because the engine's expression grammar and runtime contract are stricter than the AI-facing generation envelope.

#### Phase C — Add provider config

Current env block in `.env.example`:

```env
# AI provider routing
JANUSLY_LLM_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-haiku-4-5-20251001

# Registered for future provider verification, not a supported MVP runtime target.
# OPENAI_API_KEY=sk-...
# OPENAI_MODEL=gpt-4o-mini
```

Rationale: provider/model selection should remain a runtime setting, but the supported release surface needs one verified provider. Tenant-level `ai.provider` and `ai.model` values live in `org_configs`; secrets stay in env or vault-backed credential references.

#### Phase D — Per-org / per-workflow override

Provider/model selection now resolves through:
- `org_configs` for tenant runtime defaults (`ai.provider`, `ai.model`, limits).
- `agent.config.model` and `ai.config.model` for node-level overrides.

Resolution order: node config -> org config -> env defaults.

#### Phase E — Cost/usage capture and AI budget guardrails

Every LLM call writes one `usage_events` row with `metric: "llm.completion"`, token counts, latency, model/provider, optional node/run context, and best-effort cost. ENG-092 adds the first governance layer: org/workflow AI budgets, warn/block policy, API and engine budget gates, Recovery Center visibility, and a 402 banner for blocked AI calls. Broader pricing plans, invoices, and payment-provider UX remain product work.

#### Migration risk register

| Risk | Mitigation |
| ---- | ---------- |
| Provider JSON behavior differs | The generation route defaults to `free_json` text output parsed by Janusly, with `constrained` structured output retained as a config fallback. All providers still converge through sanitize + engine validation + fallback. |
| Token counting differs per provider | The SDK normalizes `usage.promptTokens` / `completionTokens`. Cost-per-token table is in our config. |
| Latency differs | Surface model & p95 latency per-surface in the UI's AI readiness card. |
| OpenAI / open-weights models vary in workflow quality | Keep them unverified until they pass the eval harness and release smoke against the same `free_json` + repair path. |
| Vendor adds breaking SDK changes | We pin `ai` and provider package versions in lockfile. |

---

## 5. MCP integration

### 5.1 Janusly as MCP server (the chat-authors-flows experience)

Current status: `packages/mcp-server` is implemented as a stdio server that proxies to the Janusly API. The server has no DB access and writes no audit rows itself; tenancy, RBAC, audit, rate limits, and consent live on the API side.

#### Current tool surface

| MCP tool | Maps to | Notes |
| -------- | ------- | ----- |
| `workflows.list` | `GET /workflows` | Paginated workflow list. |
| `workflows.get` | `GET /workflows/latest?workflowId=...` | Latest DAG + version metadata. |
| `workflows.versions` | `GET /workflows/versions?workflowId=...` | Version history for rollback/compare. |
| `workflows.health` | `GET /workflows/health?workflowId=...` | Workflow health rollup. |
| `workflows.validate` | `POST /validate` | Shape + graph validation; no persistence. |
| `workflows.readiness` | `POST /workflows/readiness` | Safety/approval/secret pre-flight; no persistence. |
| `recipes.list` | `GET /templates` | Built-in demo/template catalog. |
| `tools.list` | `GET /tools` | Native runtime tool catalog. |
| `runs.list` | `GET /runs` | Recent runs, optional workflow filter. |
| `runs.get` | `GET /run?runId=...` | Run state + paginated events. |
| `dlq.list` / `dlq.clusters` | `GET /dlq*` | Recovery queue and failure clusters. |
| `recovery.metrics` | `GET /recovery/metrics` | Recovery/value dashboard data. |
| `reports.run_explain` | `GET /reports/run-explain` | Markdown/JSON run report export. |
| `ai.patch_workflow` | `POST /ai/patch-workflow` | Suggests patches for a DLQ entry; does not save. |
| `workflows.save` | `POST /workflows/save` | Gated write tool; advertised only when `JANUSLY_MCP_WRITES_ENABLED=true`, and the API still requires tenant `mcp.writeConsent`. `dryRun: true` routes to `/validate`. |

#### Auth and consent

- Local stdio mode uses dev headers (`JANUSLY_API_ORG_ID`, `JANUSLY_API_USER_ID`) or a service token via `JANUSLY_API_SERVICE_TOKEN`.
- `x-janusly-source: mcp` is accepted only in service-token mode, so browser users cannot self-assert MCP source.
- `workflows.save` is the only advertised write tool today. Adding another write requires the API-side MCP consent helper, per-tool rate limit, audit metadata with `source: "mcp"`, and tests in both the MCP server and API.

See `packages/mcp-server/README.md` for the exact JSON Schema descriptors and dispatch rules.

### 5.2 Janusly as MCP client (external tools become steps)

Every MCP server (filesystem, GitHub, Linear, Slack, Sentry, Zendesk, Notion, Postgres, Atlassian) exposes tools. Janusly can consume those servers as workflow steps without writing a bespoke integration for every vendor, but each connection/tool remains tenant-scoped, operator-enabled, rate-limited, and write-consent gated.

#### New node type: `mcp_tool`

```ts
{
  id: "n1",
  type: "mcp_tool",
  config: {
    connectionAlias: "github",   // org-scoped alias in mcp_connections
    toolName: "create_issue",    // tool name from mcp_tool_descriptors
    input: { title: "{{context.fetch.output.title}}", body: "..." },
    timeoutMs: 30000,
  }
}
```

#### Org-level MCP connections

New schema entity:

```sql
create table mcp_connections (
  id text primary key,
  org_id text not null,
  alias text not null,                         -- "github", "slack", "sentry"
  transport text not null,                     -- "stdio" | "sse" | "http"
  command text,                                -- for stdio
  url text,                                    -- for sse/http
  env_refs jsonb,                              -- maps env names to credentials.secret_ref
  enabled boolean default true,
  expose_to_ai boolean default false,
  created_at timestamptz default now(),
  unique (org_id, alias)
);
```

`mcp_tool_descriptors` caches each discovered remote tool with `enabled`, `writeSide`, per-tool rate-limit override, and AI-exposure flags. Discovery happens at connection create time and on explicit admin re-discovery; runtime invocation resolves `(orgId, connectionAlias, toolName)` through the cached descriptor before any SDK transport is constructed.

#### Tool catalog auto-population

The `Tools` view in the UI should list:
- Native tools (`http.request`, `text.uppercase`, etc.)
- Tools discovered from each connected MCP server

When the LLM drafts a workflow, the system prompt may include sanitized descriptions for explicitly exposed MCP tools. Exposure is opt-in at both connection and descriptor level. The model still emits `noop` placeholders (`mcp_<connectionAlias>_<toolName>`), not direct `mcp_tool` nodes; the operator promotes the node in the Inspector.

#### Roadmap

1. `mcp_tool` executor, connection tables, admin routes, Inspector branch, and `McpConnectionsPanel` are shipped.
2. Stdio, SSE, and Streamable HTTP transports are shipped; URL transports share the documented v1 DNS-rebinding caveat.
3. Pre-packaged GitHub / Slack / Filesystem connection presets remain a follow-up.
4. Automatic noop → `mcp_tool` promotion remains a follow-up; manual Inspector promotion is the current safe UX.

### §5.2.0 Status Update (2026-05-14)

**v1 shipped via ENG-094.** The `mcp_tool` node type, `mcp_connections` + `mcp_tool_descriptors` tables, transport-agnostic client (stdio + SSE, now plus Streamable HTTP), per-call executor with two-flag write consent + per-tool rate-limit + dry-run gate + audit + usage telemetry, and the admin `McpConnectionsPanel` + dedicated Inspector branch are all live. **Current intentional deviations from the original §5.2 sketch:**

- **URL transports share the same v1 SSRF perimeter.** Both SSE and Streamable HTTP validate through Janusly's outbound target policy before SDK transport construction; the SDK fetch path still owns the final connect, so the known DNS-rebinding caveat remains documented in `docs/architecture/mcp-client.md`.
- **Tool catalog exposure to the LLM is opt-in only at two levels.** `mcp_connections.expose_to_ai` and `mcp_tool_descriptors.expose_to_ai` both default to `false`; `/ai/generate-workflow` receives only enabled descriptors where both exposure flags are true, with prompt-facing labels and descriptions Unicode-hardened, secret-scrubbed, framed as data, and bounded. The LLM still emits `noop` placeholders, not `mcp_tool` nodes; operators promote them manually in the Inspector.

Pre-packaged connections (GitHub / Slack / Filesystem) remain a follow-up.

---

## 6. Node catalog evolution

### 6.1 Keep & invest

| Node | State | Investment |
| ---- | ----- | ---------- |
| `http` | Healthy. SSRF policy is correct. | Add OAuth token auto-refresh, circuit breaker, response size cap. |
| `condition` | Works, expression grammar is intentionally narrow. | Add a "natural language" mode that compiles to the safe expression via LLM. |
| `transform` | Mapping only. | Add jq-style operations (with a safe interpreter, not eval). |
| `loop` | Basic for-each. | Add parallelism cap, accumulate-vs-stream, early-exit predicate. |
| `tool` | Static native registry. | Keep native tools small and audited; external vendor breadth goes through `mcp_tool`. |
| `agent` | Rules planner + provider-neutral LLM planner (legacy config value `"openai"` resolves through `ai.provider`). | Add tool-result-aware re-planning and memory injection (§7). |
| `multi_agent` | Sequential / parallel. | Add a "team lead" coordinator pattern, role-based delegation, conflict-resolution voting. |
| `agent_reflection` | Simple result acceptance gate. | Rebuild on top of `generateObject({ schema })` — return structured `{ accepted, reason, retry_input }`. |
| `ai` | Single-shot prompt. | Add streaming output, citation back to context inputs, structured-output mode. |
| `webhook` | Waits for external resume. | Add timeout-with-fallback, signed webhook payloads, replay protection. |
| `approval` | Waits for human. | Add SLAs, reminder schedule, role-restricted approvers, mobile push. |
| `human_form` | Waits for structured human input and resumes with validated form data. | Improve generated form ergonomics and role-targeted assignment. |
| `subworkflow` | Calls another workflow by id with input mapping. | Add richer output contracts and version pinning. |
| `wait_until` | Pauses by ISO duration. | Add natural-language authoring and calendar-aware waits. |
| `parallel_fork` / `join` | Explicit fan-out/fan-in primitives. | Add stronger branch previews and partial-join UX. |
| `schedule` | Cron trigger persisted through `schedule_entries` and BullMQ schedulers. | Add timezone presets, next-fire previews, and natural-language interval authoring. |
| `mcp_tool` | External MCP tool invocation with transport gates, write consent, dry-run, rate-limit, audit, and usage telemetry. | Add connection presets and optional noop auto-promotion. |
| `email_received` / `file_dropped` / `mcp_server_event` | Event-driven triggers. | Broaden provider coverage and add richer setup UX. |
| `noop` | Useful as start/end markers. | Keep. |

### 6.2 Refactor

| Node | Change |
| ---- | ------ |
| `router` | Today's deterministic scorer. Rebuild as an explicit **policy** (UCB / Thompson sampling) over `routing_stats`. |
| `router_llm` | Currently the same scorer with a different name. Make it a true LLM-routing node with structured output `{ candidate, reason }`. |

### 6.3 Add (high priority)

| Node | Why |
| ---- | --- |
| `event_subscribe` | Subscribe to internal Janusly events (run completed, DLQ entry created, audit log) — enables workflow-of-workflows. External event triggers already exist separately. |
| `vector_search` | RAG primitive. Query the org's vector store, return top-k. |
| `vector_upsert` | Write to vector store from any context value. |
| `db_query` | Execute parameterized SQL against an org-registered customer Postgres connection (read-only by default). Still gated until concrete customer pull. |

### 6.4 Add (lower priority but distinctive)

| Node | Why |
| ---- | --- |
| `ai_judge` | Pass two outputs and a rubric, return a winner with reason. Used in eval/A-B harnesses. |
| `human_in_the_loop_chat` | A multi-turn chat with a human, scoped to one node, structured into the run. Like `approval` but conversational. |
| `policy_guard` | Run a configurable policy check (PII scrub, content moderation, business rules) before a downstream node. |
| `ai_decompose` | Take a coarse prompt, split into N atomic prompts that downstream `ai` nodes consume. |
| `http_streaming` | Long-lived SSE consumer (Stripe events, etc.). |
| `cron_window` | Run only between H1:M1 → H2:M2; otherwise skip (different from `wait_until`, which delays). |

### 6.5 Remove or merge

| Node | Action | Why |
| ---- | ------ | --- |
| `noop` | Keep but **document as "marker only"** | Today the AI sometimes uses it as a step. The system prompt should say it has no behavior. |
| `agent_reflection` | Merge into `agent` as a `reflection: true` flag | It's literally an extra step on top of an agent call. Two nodes for one concern. |

### 6.6 Workflow-level features (not nodes, but adjacent)

- **Workflow hooks**: `onStart`, `onSucceed`, `onFail`, `onCancel`. Today this is faked via DAG topology.
- **Workflow inputs schema**: declarative typed inputs (Zod), surfaced in the UI as a form before "Run."
- **Workflow outputs**: explicit terminal-node-output → workflow-output mapping.
- **Workflow tags + folders**: organization at scale.
- **Workflow-level rate limit**: "no more than 5 concurrent runs of this workflow."

---

## 7. AI / RL / Self-learning improvements

### 7.1 Memory (cross-run, vector-backed)

Current state has two distinct memory surfaces:

- `packages/engine/src/memory.ts:getRunMemory(runId)` is run-local context for the live `agent` / `multi_agent` loop. It reads selected `run_events` from the current run only.
- `packages/data/src/memoryEntriesRepo.ts` is the durable memory substrate: tenant-scoped `memory_entries`, pgvector similarity, write/read scrubbing, two-flag consent, retention, usage telemetry, and recovery-prompt recall.

What is still missing is broader use of the durable substrate:

- **Episodic memory** — what happened in past runs of this same workflow (top-k by recency).
- **Semantic memory** — knowledge embedded from documents, run outputs, user feedback.
- **Procedural memory** — successful tool sequences for similar goals.

Implementation status:
- ENG-114 landed the privacy and retention policy first — see [`docs/memory-policy.md`](memory-policy.md) for the canonical doc covering eligibility, the two-flag opt-in consent model, per-kind retention, deletion/export, embedding provider posture, prompt-injection framing, the `org_configs.memory.*` catalog, audit actions, DPA language, and incident response.
- ENG-115 shipped the `memory_entries` substrate: `id, org_id, workflow_id?, run_id?, kind, scrubbed content, embedding, provider/model/dimension metadata, bounded metadata jsonb, created_at, retain_until`, plus `commitMemory(entry)`, `recallMemory({ orgId, kind?, query })`, `deleteExpiredMemory({ orgId? })`, and purge helpers.
- ENG-116 feeds recalled recovery memory into `/ai/patch-workflow` via `extraContext.memorySnippets`, with the same data-framing / suspicion-framing posture as other AI prompts.
- Still future: durable recall for generic `agent` / `multi_agent` planners, explicit memory nodes such as `vector_search` / `vector_upsert`, export UI/API, and provider implementations beyond the v1 Ollama embedding path.

### 7.2 RL — make it actually decide

Today `routing_stats` is updated but only used by the basic decision engine (a deterministic scorer with a small bandit-flavored bonus). Upgrade:

#### Multi-armed-bandit policies as first-class
- **Thompson sampling** policy as default for `router`/`router_llm` nodes.
- **UCB1** policy as alternative (tunable `c`).
- **Epsilon-greedy** for users who want deterministic exploitation.
- **Contextual bandits** — store `routing_stats` keyed by `(node_id, context_hash)` rather than `node_id` alone. Lets the same node pick different routes for different inputs.

#### RL-driven model routing
The `agent`/`ai` nodes should use the same policy to pick *which model* to invoke. `routing_stats` extended with `(org_id, model, surface)` rows. Cheaper model wins on low-stakes; expensive model wins on high-stakes. Reward = run success * inverse-cost.

#### Off-policy evaluation
Causal reasoning is already there. Use it: every time we change the policy, replay the last N runs and report "if we had used policy B, expected reward Δ". UI surfaces this in `improvements` view.

### 7.3 Self-learning improvement loop (close the loop)

The `improvementEngine` already computes confidence and triggers rollback. Extend it:

- **DLQ pattern detection**: cluster recent dead letters by error message + node type. If 5+ failures in 24h match the same pattern, auto-open a `workflow_improvement` row with a structured suggestion ("add retry with exponential backoff to node X", "add condition guard before node Y"). Surface in UI as an operator-reviewed apply path.
- **Supervised auto-healing queue**: ENG-117 turns repeated DLQ patterns into queued, sandbox-validated recovery proposals. Production auto-apply remains off by default and requires explicit process + tenant flags, successful validation, loop breakers, a kill switch, and audit.
- **A/B harness**: every saved version is a candidate. New endpoint `POST /workflows/{id}/ab-test` runs 50% on v3, 50% on v4 over the next M runs. The first version should recommend promotion on confidence > 70% and rollback on confidence < 30%; automatic promotion is a later guarded mode, not the default.
- **Eval harness**: define golden inputs + expected outputs per workflow. CI gate that runs evals against any AI-driven node change.
- **Training/export hook**: successful runs may become candidate evaluation or training examples only after the ENG-114 memory/privacy policy defines explicit opt-in, retention, deletion/export, and provider posture. Runtime memory and customer data are not training data by default; no provider-specific fine-tuning job is part of the current backlog.

### 7.4 Agent improvements (immediate)

- **Multi-step reasoning** with chain-of-thought hidden from the user but stored in `run_events` for the run explainer.
- **Tool-use error recovery**: if a tool returns an error, the agent re-plans instead of failing.
- **Tool-result reflection**: after each tool call, the agent can pause to reflect on whether the result advances the goal.
- **Memory write-back**: at the end of an agent loop, distill the conversation into a memory entry tied to the workflow.

### 7.5 Prompt management (templates, versions, evals)

- ENG-111 owns the first PromptOps slice. New `prompts` + `prompt_versions` tables should be org-scoped, append-only by version, audited, and referenced from AI nodes without breaking existing inline prompts.
- UI page: "Prompts" — browse, version, eval, fork.
- Eval = run prompt against a goldens set, compare against a previous version.

---

## 8. Tool catalog expansion

The native tool catalog is the bridge between LLM-drafted workflows and useful business automation. Strategy:

**Layer 1: native essentials** (build in-tree).
- `http.request` — already there.
- `text.transform` (regex, slug, normalize, trim, case).
- `text.uppercase` / `text.lowercase` (already there).
- `json.pick` / `json.merge` / `json.diff`.
- `csv.parse` / `csv.stringify`.
- `markdown.render` / `markdown.parse`.
- `time.now` / `time.format` / `time.diff` (timezone-aware).
- `crypto.hash` / `crypto.hmac` (no `crypto.encrypt` — too easy to misuse).

**Layer 2: stateful primitives** (need org-level config).
- `email.send` (Resend / SES / Mailgun adapters).
- `sms.send` (Twilio).
- `pdf.generate` (Markdown or sanitized HTML to PDF via `pdfkit` + `htmlparser2`; no Chromium or hosted renderer dependency).
- `image.transform` (Sharp).
- `db.query.read` and `db.query.write` (separate to keep audit clear; gated until concrete customer pull and schema discovery).
- `vector.search` / `vector.upsert` (§7.1).
- `embedding.create`.

**Layer 3: SaaS adapters** (lean on MCP §5.2).
Every connector below is an MCP server we either consume from upstream or write thin (50-line) ones for:
- `slack.post_message`, `slack.lookup_user`
- `discord.post`, `telegram.send`
- `github.create_issue`, `github.create_pull`, `github.add_comment`
- `linear.create_issue`, `linear.update_status`
- `notion.create_page`, `notion.append_blocks`
- `stripe.charge`, `stripe.refund`, `stripe.subscription_update`
- `salesforce.upsert`, `hubspot.upsert`
- `zendesk.create_ticket`, `intercom.send`
- `calendar.create_event`, `calendar.list`
- `drive.upload`, `s3.put`, `s3.get`

**Layer 4: agent-only tools** (LLM uses, never user-clicks).
- `web.search` (Tavily / Brave Search).
- `browser.fetch_text` (Playwright pool, isolated network).
- `code.run_python_sandbox` (E2B / fly.io firecracker microvm).

### Tool-input contract

ENG-023 moved the static registry to typed `ToolDefinition` entries with Zod
input + output schemas. `validateToolInput` now pre-flights through
`safeParse`, `executeTool` parses input and validates executor output before
returning, and `listTools()` derives the AI Studio metadata from the schema.
The next step is provider tool-call integration (ENG-011/ENG-014), not another
manual registry rewrite.

### §8.0 Status Update

ENG-035 shipped the first native expansion in-tree: text transforms, JSON set/merge/jq, CSV parse/stringify/filter, time parse/format/diff/add, and crypto hash/HMAC/UUID helpers are now registered with Zod input/output schemas. The remaining gap in this section is no longer another manual registry rewrite; it is wiring these definitions into provider-native tool-call APIs and adding stateful or SaaS tools behind explicit credentials/audit.

```ts
const httpRequestTool = defineTool({
  name: "http.request",
  description: "Make an HTTP request.",
  inputSchema: z.object({
    url: z.string().url(),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.unknown().optional(),
  }),
  outputSchema: z.object({
    statusCode: z.number(),
    ok: z.boolean(),
    body: z.string(),
  }),
  execute: async (input) => { /* ... */ },
});
```

This lets:
- Vercel AI SDK pass tool definitions directly to provider tool-call APIs.
- Pre-flight validation before runtime.
- Auto-generated docs.

---

## 9. Use cases — what we should be obviously good at

Each case is concrete enough that we could ship it as a recipe. The first three are "starter," the rest are revenue-grade.

### 9.1 Starter — visible in the AI Studio

1. **Watch-and-summarize-and-approve**: webhook → http.request (fetch detail) → ai (summarize) → approval → notify.
2. **Form → SQL → email**: human_form → db.query.write → email.send.
3. **Schedule → fetch → vector_upsert**: schedule (daily) → http.request (RSS feed) → ai (extract) → vector_upsert.

### 9.2 Revenue / customer ops

4. **Refund triage**: customer_form → ai (classify reason) → router (auto-approve <$10, agent-review medium, human_form >$100) → stripe.refund or zendesk.create_ticket.
5. **Churn save**: schedule → db.query.read (cancelled subs) → ai (score reactivation likelihood) → email.send (personalized offer) → wait_until (3 days) → db.query.read (did they reactivate?) → vector_upsert (learn).
6. **Revenue alerts**: stripe webhook → condition (failed charge?) → agent (decide retry strategy from past stats) → wait_until (3 days) → http.request (Stripe retry endpoint) → ai (compose customer email) → email.send.

### 9.3 Engineering / DevOps

7. **Incident triage**: pagerduty_webhook → ai (classify severity from alert) → router (low: github_issue, high: slack_post + page on-call) → log to vector store for postmortem search.
8. **Sentry → ticket → fix-PR**: sentry_webhook (new error) → ai (group with similar past errors via vector_search) → linear.create_issue → ai (read code via mcp_tool: filesystem) → ai (draft fix) → github.create_pull (with [DRAFT] label) → human approval before merge.
9. **Dependency updates**: schedule → http.request (npm registry) → loop (per-package) → ai (read CHANGELOG, classify risk) → condition (low risk: github.create_pull, high risk: linear.create_issue for human review).

### 9.4 Sales / GTM

10. **Lead enrich + route**: webhook (form fill) → http.request (Clearbit) → ai (score ICP fit) → router (high: salesforce.upsert + slack.post AE channel; low: hubspot.upsert + email.send nurture).
11. **Meeting follow-up**: calendar.event_ended (event subscription) → mcp_tool (Granola/Otter transcript) → ai (summarize, extract action items) → notion.append_blocks (CRM page) → email.send (recap).

### 9.5 Content / marketing

12. **Article rewriter**: schedule (weekly) → http.request (analytics, top underperforming pages) → loop → ai (rewrite hook) → ai_judge (rubric: clarity / SEO / brand voice) → human_form (approve copy) → http.request (CMS publish API).

### 9.6 Internal ops / HR

13. **Onboarding orchestrator**: human_form (new hire data) → parallel_fork → mcp_tool (Okta create) → mcp_tool (GitHub invite) → mcp_tool (Slack invite) → join (all) → email.send (welcome) → schedule (30-day check-in).
14. **PTO request**: human_form → condition (manager auto-approve <5 days) → calendar.create_event → slack.post_message (team channel).

### 9.7 Compliance / governance

15. **PII redaction**: file uploaded → ai (detect PII spans with `generateObject({ schema: SpansSchema })`) → policy_guard (pass/fail) → s3.put (redacted) → audit_log.
16. **Quarterly access review**: schedule (quarterly) → mcp_tool (Okta list users) → loop (per user) → human_form (manager confirm/revoke) → mcp_tool (apply changes) → audit_log.

### 9.8 Showcase what's *only possible because of Janusly*

17. **Failure-driven self-improvement**: any workflow → on DLQ entry → improvement_engine (cluster failure) → ai (suggest patch) → human approval → save as new version → A/B test → recommend promotion for operator approval.
18. **Counterfactual replay**: pick a `router` decision in any past run → "what would have happened on the other branch?" → causal_reasoning runs the alternative → render side-by-side. (No competitor has this.)

---

## 10. Engineering quality commitments

### 10.1 Security (immediate, do before plan execution)

- [x] Rate limiter moved to Redis in ENG-019. API uses a dedicated request-path `ioredis` client with bounded retries instead of BullMQ's `maxRetriesPerRequest: null` connection.
- [ ] CORS is `*` for some headers — audit and lock to known origins in production.
- [ ] DLQ stores the full `workflow_json` and `node_json` — these can contain resolved secrets if the engine substitutes `{{secret.X}}` before storage. Verify substitution happens AT the HTTP/tool boundary, NOT before persistence.
- [ ] Legacy `webhook` / `approval` resume metadata is still the predictable `<runId>:<nodeId>` checkpoint coordinate; authenticated `/resume` gates it today. `human_form` is already HMAC-signed via `JANUSLY_RESUME_TOKEN_SECRET` because submitted form data becomes node output. Remaining hardening is deciding whether webhook / approval links also need signed, purpose-bound tokens.
- [x] Audit metadata redaction: audit writes flow through the safe persistence/redaction posture shipped in ENG-049; new audit metadata must avoid raw secrets and route through the existing chokepoints.
- [ ] `expression.ts` is a custom evaluator. Add a fuzzer in CI that throws random strings at it for 60s to verify no path leads to crash / infinite loop.
- [x] AI prompt injection baseline — run/event payloads are redacted and bounded before persistence (`safePersistPayload`), evidence rows re-scrub at read time, `/ai/explain-run` frames question/run/event JSON as untrusted data and states it cannot execute tools, and `/ai/generate-workflow` self-repair frames validator issues + broken workflow JSON as untrusted data. New AI prompts that embed operator/runtime data must keep the same data-boundary wording.

### 10.2 Build / DX

- [x] CI: GitHub Actions workflow exists with build + jsdom test, browser test, e2e, and high+ dependency audit jobs.
- [x] Drizzle migrations: ENG-008 shipped checked-in SQL migrations, root `pnpm migrate`, and API/worker startup guards via `assertMigrationsApplied()`. The runtime `ensureDatabaseSchema()` bootstrap was removed.
- [ ] Containerize end-to-end: `docker-compose.full.yml` that runs api + worker + web + Postgres + Redis + Ollama. Today only the infrastructure tier is composed; API/worker/web are still local Node processes.
- [x] `pnpm dev` boots Compose (`redis` / `postgres` / `ollama`) + migrate + api/worker/web through `scripts/run-dev.mjs` (ENG-017). It uses pure Node orchestration instead of `concurrently`.
- [ ] Storybook for the UI components (especially the DAG node renderer + Right Panel sub-panels).
- [ ] `package.json` `engines.npm` should also pin pnpm version.

### 10.3 Observability

- [x] `service.name` is `janusly` — ENG-022 adds `service.namespace = "janusly"` and env-derived `service.instance.id` through the shared OTel Resource.
- [ ] Custom spans on every node execution with `node.type`, `attempt`, `org.id`, `workflow.id` attributes. Today only node-level event logs exist.
- [ ] Frontend: Sentry (or selfhosted Glitchtip) for client errors. The `addToast(error.message)` swallows + displays but doesn't capture.
- [ ] Slow-query log: drizzle `logger` option in dev.

### 10.4 SDKs

- [x] ENG-112: `@janusly/sdk` — workspace-private TypeScript source package over the HTTP API; DTOs are hand-typed against the current route/docs surface with package build + tests as the guard.
- [x] ENG-113: Python SDK — same core surface after the TypeScript SDK stabilizes.
- [x] ENG-113: Webhook receiver helper — a small FastAPI/plain-Python helper plus docs for receiving Janusly webhooks with HMAC verification.

### 10.5 Testing

- [ ] Coverage report in CI; aim for 80% on `engine` and `domain`.
- [ ] Property-based tests on `expression.ts` and the post-generation `sanitizeAiWorkflow` / workflow-validator path (use `fast-check`). The old `parseAiWorkflow` looser is gone.
- [x] Vitest browser mode for the React Flow canvas — `<WorkflowCanvas>` covered locally and wired in CI via the `test_browser` job in `.github/workflows/ci.yml` (ENG-010 + ENG-015).
- [x] LLM eval harness: ENG-018 adds `evals/generate-workflow.jsonl` and `pnpm evals` for `/ai/generate-workflow` shape checks.

### 10.6 Multi-tenancy maturity

- [ ] Per-org plan limits (concurrent runs, daily AI tokens, max workflows). Today `organizations.plan` exists but is unused.
- [ ] Soft delete + retention windows on `runs`, `run_events` (default 90d, override per plan).
- [ ] Per-org isolation tests — can a user with `x-org-id: a` ever see data from org `b`? Test every endpoint.

---

## 11. Roadmap operating model

This plan no longer carries a second sprint queue. It explains strategy and
decision boundaries; [`docs/ROADMAP.md`](ROADMAP.md) owns ticket status,
pick order, and the ARCHIVED shipped history.

Current execution focus:

1. **Private-beta proof** — ENG-093 once three design partners are ready.
2. **Generation reliability** — shipped through ENG-193; use the eval baseline
   as the provider-comparison floor.
3. **Provider breadth** — ENG-194 only after generation reliability has a
   stable baseline.
4. **Generation refinements** — ENG-195 and ENG-196 after reliability/provider
   decisions land.
5. **Deferred/gated context** — ENG-025, ENG-026, ENG-087, and ENG-038 remain
   non-pickable until their blockers change.

Historical phase framing is now descriptive only:

- **Foundations for AI scale:** shipped provider-neutral `LlmClient`, usage
  telemetry, free-JSON generation, migrations, CI, and Janusly-as-MCP-server.
- **Workflow expressiveness:** shipped most core runtime primitives; remaining
  work is customer-pulled integration depth and richer authoring UX.
- **Self-learning loop:** recovery suggestions, memory substrate, sandbox
  validation, and feedback capture are real; policy learning, durable agent
  recall, and A/B promotion remain future work.
- **Operator-grade ergonomics:** SDKs, reports, solution packs, auth hardening,
  and recovery-center surfaces exist; private-beta evidence decides the next
  commercial polish.

Rule: if a line below starts to look like an acceptance-criteria ticket, move it
to ROADMAP §3b. If it is shipped evidence, move it to ROADMAP §3c ARCHIVED.

---

## 12. Risk register

| Risk | Likelihood | Impact | Mitigation |
| ---- | ---------- | ------ | ---------- |
| Vercel AI SDK has a breaking change | Medium | Medium | Pin `ai` version, write smoke tests against each provider, treat the abstraction layer as our boundary. |
| MCP spec changes (it's young) | High | Medium | Pin `@modelcontextprotocol/sdk`, only adopt stable surfaces, contribute upstream where we hit gaps. |
| pgvector becomes a bottleneck | Medium | Low | Start with pgvector for simplicity; have a documented migration path to Pinecone/Qdrant if vector volume crosses 10M rows. |
| LLM cost spirals on a workflow with a `loop`+`agent` step | High | High | Per-org `daily_token_budget` enforced at LLM-client layer; surface in UI with predicted spend. |
| Self-improvement loop ships a patch that breaks production | Medium | High | Patches are *suggestions* until human-approved. A/B test + auto-rollback < 30% confidence. Audit log every applied patch. |
| MCP-discovered tools have unbounded surface | High | Medium | Descriptor discovery defaults tools to disabled and write-side; operators enable per tool, writes require two consent flags, stdio commands are allowlisted, URL transports pass the SSRF gate, and LLM exposure is opt-in at connection + descriptor level. |
| Bigger tool catalog → bigger attack surface | High | High | Layer 3+ tools always ship as MCP servers (process-isolated). Native tools stay minimal and audited. |
| RL policy converges to a local optimum | Medium | Medium | Force epsilon-greedy floor; periodic reset of low-confidence stats; off-policy evaluation in CI. |
| LLMs produce malformed or graph-invalid workflow JSON | High | Low | Default `free_json` parses through `AiGenerationWorkflowSchema`, promotes supported noop placeholders, then runs engine validation with bounded self-repair before falling back to `mode: "fallback"` with `aiError`; provider compatibility stays gated by the eval harness. |

---

## 13. Open questions (need decisions, not answers right now)

1. **Pricing model**: per-run, per-token, or per-workflow-version-saved? The `usage_events` design needs to support whichever we pick.
2. **Self-host vs cloud**: which is the canonical product? The architecture supports both today; pick one to optimize for first.
3. **License**: AGPL, BSL, MIT, or commercial? Affects MCP server bundling story and contributor pipeline.
4. **Web UI vs API-only**: do we sell the canvas, or is the canvas a free showcase and the value is the runtime + MCP?
5. **Tenancy size**: which org-size do we optimize for — 1-5 user startups, 50-person ops teams, or 1000-person enterprises? Each has different demands on RBAC, audit, retention.
6. **AI training data**: do we use customer run data to improve our models / prompts? Need an explicit opt-in policy + DPA.
7. **MCP marketplace**: should we host one (like the npm registry), or stay agnostic and let users plug in any MCP server? Hosting one is a moat but a maintenance burden.

---

## 14. Quick wins

This section is intentionally short. Completed quick wins belong in
[`docs/ROADMAP.md`](ROADMAP.md) §3c ARCHIVED, not in a second DONE list here.

Open quick win:

- Add property-based tests for `expression.ts` and the post-generation
  sanitize/validate path. The old `parseAiWorkflow` looser was deleted, so the
  fuzzer should target the current guards instead of a removed pre-parser.

These don't require strategic alignment and unblock everything later.

---

## 15. Review-derived execution plan — hardening, recovery, and product focus

This section folds the external review findings into the existing roadmap. The core recommendation is to make Janusly the **self-healing AI workflow operator**: observable DAGs that fail safely, explain root cause, propose patches, version changes, and replay/evaluate improvements.

### 15.1 Product focus

Janusly should avoid competing as a generic automation catalog. The strongest wedge is:

> **Run critical workflows, explain failures, propose safe fixes, and evolve workflow versions with auditability.**

Keep the strategic positions from §3, but sequence them more narrowly:

1. **Self-healing failure recovery** — DLQ -> explanation -> patch -> diff -> replay.
2. **AI-authored and AI-reviewed flows** — generation plus structured review before save.
3. **MCP-native operations** — read-only first; write tools only after consent/audit policy.

### 15.2 Sequencing

The original sprint list (ENG-042..057) has shipped and now lives in
`docs/ROADMAP.md` §3c ARCHIVED. Do not repick from that historical list. The current
execution queue is intentionally short and mirrors `docs/ROADMAP.md` §3a:

1. **Private-beta proof:** pick ENG-093 once three design partners are ready.
   The shipped playbook in `docs/marketing/private-beta-playbook.md` is the
   operating manual for this sprint.
2. **Generation reliability:** shipped through ENG-193; the stable eval
   baseline is now the floor for provider comparisons.
3. **Provider breadth:** pick ENG-194 only after reliability is stable enough
   to compare OpenAI / open-weights endpoints honestly against Anthropic.
4. **Generation refinements:** ENG-195 and ENG-196 stay lower-priority until
   the reliability/provider decisions land.
5. **Gated/deferred context:** ENG-025, ENG-026, ENG-087, and ENG-038 remain
   non-pickable until their blockers change.

Tactical rule: `docs/ROADMAP.md` is the live sprint/backlog surface. §3b is the
active pool, §3c ARCHIVED is the archive. PLAN explains strategy; it should not carry a
second, competing ticket queue.

### 15.3 Engineering invariants added by the review

- Any payload persisted to `run_events`, `run_nodes`, DLQ, or audit must pass through a safe persistence sanitizer.
- `{{env.*}}` must be treated as sensitive or removed from the template grammar.
- Cancellation is a runtime invariant, not only an API helper: queued jobs must check run status before execution, and completed nodes must not schedule downstream work after cancellation.
- Runtime learning must use explicit run metadata; it must not depend on node-output context to contain `orgId`, `workflowId`, or `rlStats`.
- MCP writes on both sides require explicit consent, audit, and server-side role checks. `workflows.save` is the only MCP-server write tool today and remains gated; external `mcp_tool` writes require the engine/client write-consent flags and descriptor-level opt-in.
- Outbound HTTP execution must be bounded by timeout, response-size cap, and redirect revalidation.
- The product should not overstate “RL/self-learning” until `routing_stats`, decision replay, and improvement records are wired through tested runtime paths.

### 15.4 Demo strategy

The next public-facing demos should be:

1. **Incident triage** — webhook -> AI classify -> route -> GitHub/Linear issue -> Slack -> explain failure.
2. **Refund triage** — form/webhook -> risk classification -> approval/human form -> action -> audit.
3. **Failed workflow recovery** — intentionally failing node -> DLQ -> explanation -> patch suggestion -> diff -> replay.

Each demo should show observability, human control, auditability, and recovery.

#### §15.4 Status Update

The canonical demos and recording-ready beat sheets are shipped. Keep the
operational details in [`docs/demos/`](demos/) and
[`docs/marketing/recording-scripts/`](marketing/recording-scripts/); the
roadmap archive carries the ENG-055 / ENG-069 closing evidence. The next action
is ENG-093: run the private-beta MTTR experiment with design partners.

---

## 16. Market differentiation plan — make Janusly unique and sellable

Janusly should not try to win by having more integrations than Zapier or by being a visual clone of n8n with an AI button. The memorable category is:

> **Self-healing AI workflow operator.**

The product promise is:

> Janusly does not just automate a process. It operates it: every run is observable, every failure is explainable, every proposed fix is reviewable, and every production change is replayable before rollout.

### 16.0 Positioning thesis (review-derived)

The §15 review consolidated the product story around a single sentence. This subsection hardens that sentence into the canonical thesis every downstream marketing artifact (landing copy, ICP, pricing, brand narrative, competitive packet) cites instead of reinventing. New marketing tickets should link to §16.0 rather than restate the four anchors below.

**Category & one-sentence pitch:**

> Janusly is the **self-healing AI workflow operator**: every run is **observable**, every failure is **explainable**, every proposed fix is **reviewable**, and every production change is **replayable before rollout**.

**The four product anchors** — what each anchor names, plus the engineering reality that grounds the claim:

1. **Observable DAGs.** Every workflow runs through a Postgres-backed runtime that emits structured `run_events` per node lifecycle transition. The Recovery Center (`apps/web/src/components/RecoveryCenterPanel.tsx`) surfaces open DLQ items, failure clusters, pending approvals, and recommended next actions as the authenticated home screen. The OpenTelemetry tracer + meter carry `service.name="janusly"` end-to-end, and `usage_events` rolls up per-org spend across LLM / PDF / email / integration tools.
2. **Failure explanation.** When a node fails, the runtime captures a structured `errorJson` envelope; `POST /ai/explain-run` produces a root-cause narrative grounded in `run_events`; failure-signature normalization (`packages/shared/src/error-signature.ts`) clusters DLQ rows so the operator sees "47 workflows failed for the same reason," not 47 individual rows.
3. **Patch suggestions.** `POST /ai/patch-workflow` proposes 1–3 alternative fixes with self-rated confidence (0–100) and an `approachLabel` per suggestion. Two patch families ship: **config-only envelopes** (per-node-type bounded shapes for `swap_secret_ref`, `add_retry`, `raise_timeout`, etc. — provider-safe base in ENG-086, non-resilience envelopes in ENG-088, headers/tool-input expansion in ENG-089) and a **structural envelope** (multi-node patches like `insert_approval_upstream`, from ENG-083). The recovery feedback loop (ENG-081) feeds operator accepts/rejects back into the prompt so the suggestions adapt to the workflow's history.
4. **Safe version evolution.** Sandbox-validation runs (`replayMode: "validation"`) prove a patch works end-to-end BEFORE save, with the dryRun gate skipping write-side tool calls so no external state mutates. `workflow_versions` makes prior versions one click from rollback (ENG-079, `RollbackConfirmDialog`); the before/after delta card (ENG-082) surfaces the measurable impact of every applied patch.

**What we are NOT** (mirror of §3, with a one-line "why" per item so downstream copy never has to choose between three variants of the rejection):

- **Not "better Zapier UI."** Recovery, not integration breadth, is the wedge. Zapier wins on integration count; Janusly wins on what happens when an automation fails in production.
- **Not "n8n with AI."** AI is part of the engine — the patch-suggestion route, the explain-run route, the multi-agent primitive — not a button glued on top of a visual builder.
- **Not generic RPA.** We operate AI workflows. We do not click-record desktop UI scripts. The runtime is a DAG, not a screen-recorder.
- **Not "agents that do everything."** Human approval gates and the recovery dialog are first-class primitives. The operator stays in the loop; the AI proposes, the human decides.

**Primary metric:** The number we hold ourselves to is **Mean Time To Recovery for failed automations**. Every demo loops back to it; every business-case slide cites it; every private-beta measurement (ENG-093) anchors on it.

**Brand-voice consolidation:** the same anchors above, written for marketers / founders / sales conversations rather than engineers, live in [`docs/marketing/narrative.md`](marketing/narrative.md). Downstream marketing tickets (ENG-066 landing, ENG-067 ICP, ENG-095 competitive) cite `narrative.md` for voice and §16.0 for substance.

**Operational competitive packet:** the sales-ready competitive long-form — comparison table across the seven AC competitors, "where Janusly intentionally does not compete," buying triggers, per-competitor sub-blocks with objection-handling lines, demo mapping, and the anti-positioning principle that keeps recovery/MTTR the wedge — lives in [`docs/marketing/competitive-positioning.md`](marketing/competitive-positioning.md). The packet cites `narrative.md` for voice, `icp.md` for segment definitions, and `pricing.md` for pricing-related objections; every "where Janusly is stronger" claim carries an inline citation to a shipped route, table, or AGENTS.md invariant.

**Operational private-beta playbook:** the operational handbook that enables ENG-093 — recruitment + intake form template, baseline-MTTR survey + measurement methodology grounded in the engine's `ErrorCategory` enum, 60-minute kickoff script, weekly cadence (report template + standing-call agenda), willingness-to-pay discovery conversation (bands not points, conversation not Typeform), exit interview with explicit permission capture, and the private-beta report skeleton — lives in [`docs/marketing/private-beta-playbook.md`](marketing/private-beta-playbook.md). Every instrument is copy-pasteable so the founder runs the experiment from the doc without inventing copy mid-flight. Cross-links consume `icp.md` (segments), `pricing.md` Section G (pricing release plan), `competitive-positioning.md` Section E (buying triggers as qualification heuristics), and `recording-scripts/failed-workflow-recovery.md` (week-1 demo bootstrap).

### 16.1 Positioning

Building on the §16.0 thesis above, the tactical tagline + alternative short pitches:

Preferred tagline:

> **AI workflows that explain, recover, and safely evolve.**

Alternative short pitches:

- “The recovery layer for AI-powered business workflows.”
- “Durable AI workflows with failure explanation and safe replay.”
- “Operate AI automations you can trust in production.”

Anti-positioning:

- Not “better Zapier UI.”
- Not “n8n with AI.”
- Not generic RPA.
- Not “agents that do everything.”

### 16.2 Differentiating product bets

The market-facing product should concentrate around seven distinctive surfaces:

1. **Recovery Queue as the home screen** — failed runs, grouped by pattern, with root cause and next action.
2. **Workflow Review Agent** — AI-generated workflows get reviewed before save/run.
3. **Replay Lab** — replay failed runs with the same input and compare patched versions safely.
4. **Workflow Health Score** — reliability, safety, cost, latency, maintainability, and AI-risk score per workflow.
5. **Visual Workflow Diff** — operator-readable version/patch diff, not just JSON.
6. **Run Explain Report** — exportable root-cause and recovery report for Slack/Linear/GitHub.
7. **MCP operator experience** — inspect and operate Janusly from chat with dry-run/consent guardrails.

The original surfaces are tracked by ENG-058..ENG-073 in the roadmap. The market/auth readiness extension is tracked by ENG-091..ENG-101.

### 16.3 ICP and sales motion

Initial ideal customer profiles:

| ICP | Pain | Janusly pitch |
| --- | --- | --- |
| B2B startups with ops workflows | Manual support, billing, onboarding, and escalation workflows break often. | “Automate ops workflows without losing control when AI is involved.” |
| Engineering/support teams | Incidents, customer bugs, and escalations require triage across Slack/GitHub/Linear. | “Turn incidents and escalations into explainable workflows with recovery built in.” |
| AI builders/agencies | They build agents for clients but lack durable runtime, audit, and recovery. | “Ship client AI workflows with a runtime, visual ops, MCP, and recovery.” |

**Operational long-form:** the sales-team operational doc — per-segment pain points, buyer/user, demo angle, objection handling, first outreach copy, success metric, plus a sales-motion overview and a persona-to-segment lookup table — lives in [`docs/marketing/icp.md`](marketing/icp.md). Downstream marketing tickets (ENG-066 landing, ENG-068 pricing, ENG-095 competitive) cite `icp.md` for segment definitions and §16.3 for the strategic seed.

### 16.4 Commercial templates

Prioritize templates that sell a story:

1. Failed payment recovery.
2. Refund triage with approval.
3. Incident triage to Linear/GitHub.
4. Customer escalation router.
5. Lead enrichment + handoff.
6. Churn risk follow-up.
7. Bug report summarizer -> GitHub issue.
8. AI support answer with human review.

Each template should include sample input, required credentials, expected output, and a failure/recovery path.

### 16.5 Minimum integration set

Do not chase hundreds of integrations. Keep the list split between demo-ready core tools and gated candidates.

Demo-ready core:

- `slack.post`
- `email.send`
- `github.create_issue`
- `linear.create_issue`
- `webhook.signed`
- `json.merge`, `json.diff`, `time.now`, `time.format`

Gated until concrete customer pull:

- Generic `db.query.*` / `db.query.read`.
- Stripe payment/refund/retry primitives.

### 16.6 Landing page structure

Hero:

> **Self-healing workflows for AI operations**

Subcopy:

> Build business workflows as observable DAGs. When they fail, Janusly explains why, proposes a patch, previews the diff, and safely replays the run.

Primary CTAs:

- “Watch 3-minute recovery demo”
- “Run locally”
- “Book technical demo”

Sections:

1. The problem — AI automations break silently; logs are messy; fixes are manual.
2. The Janusly loop — Prompt -> DAG -> Run -> Observe -> Explain -> Patch -> Replay -> Learn.
3. Recovery demo — one failed run, one patch, one replay.
4. For technical teams — Node, Postgres, Redis, BullMQ, Zod DSL, MCP, self-host.
5. Use cases — incident triage, refund triage, payment recovery, support routing.
6. Security and control — RBAC, audit logs, secret refs, approvals, replay before apply.
7. Deployment/pricing — self-host and managed cloud.

**Live copy + design brief:** the bilingual landing-page design brief (English + Spanish, with hero/CTA variants for A/B test, SEO metadata, navigation, footer, forms, and Claude Design handoff notes) lives in [`docs/marketing/landing-page.md`](marketing/landing-page.md). The brief consumes [`docs/marketing/narrative.md`](marketing/narrative.md) for voice, [`docs/marketing/icp.md`](marketing/icp.md) for segment pain quotes, and the existing demo recording scripts under [`docs/marketing/recording-scripts/`](marketing/recording-scripts/) for CTA targets.

### 16.7 Packaging

Suggested packaging:

| Package | Audience | Included |
| --- | --- | --- |
| Developer / Self-host | Technical builders | Local workflows, core runtime, basic recovery. |
| Team Cloud | Startups | Managed runtime, templates, Slack/GitHub/email, Recovery Queue. |
| Business | Ops teams | RBAC, audit logs, MCP, approvals, usage/cost reporting. |
| Enterprise | Compliance-heavy teams | SSO, retention, isolated environments, advanced audit, support. |

Add-on:

| Add-on | Value |
| --- | --- |
| AI Recovery Pack | Failure explanation, patch suggestions, replay/evals, model usage. |

**Operational long-form:** the operational pricing strategy — per-tier feature lists with shipped/roadmap honesty tags, free/self-host boundary, value-metric candidates with pros/cons + recommendation matrix, tier-to-segment mapping, enterprise controls deep dive, and pricing release plan tied to ENG-093 — lives in [`docs/marketing/pricing.md`](marketing/pricing.md). Numbers are intentionally TBD until ENG-093 closes; sales conversations name "tier + value metric candidate", not dollar amounts.

### 16.8 Sales demos

Flagship demos:

1. **Workflow fails, Janusly fixes it** — missing secret or broken HTTP call -> Recovery Queue -> explanation -> patch -> diff -> replay.
2. **Refund triage** — request -> AI risk classification -> approval/human gate -> action -> audit -> recovery if Stripe/tool fails.
3. **Incident triage** — webhook -> AI summary/severity -> GitHub/Linear issue -> Slack -> recovery if integration fails.

The primary business metric should be:

> **Mean Time To Recovery for failed automations.**

Marketing copy should say:

> “Cut workflow recovery time from hours to minutes.”

### 16.9 Market and Enterprise Readiness Strategy

Janusly's near-term roadmap should consolidate three fronts into one product story: recovery/MTTR as the wedge, commercial demos as proof, and enterprise auth as the minimum trust layer for B2B buying.

| Track | Decision | Why it matters |
| --- | --- | --- |
| Positioning | **AI workflows that explain, recover, and safely evolve.** | This keeps Janusly out of the commodity "automation builder" category and anchors the product around operating workflows after they fail. |
| North-star metric | **Mean Time To Recovery for failed automations.** | MTTR makes the value measurable in demos, private beta, and production accounts. |
| Initial market | B2B startups with ops workflows, engineering/support teams, and AI builders/agencies. | These buyers feel workflow failures directly and can evaluate Janusly on recovery speed, auditability, and operational control. |
| Auth strategy | Keep Supabase, dev headers, and service-token modes as the current base; add WorkOS as an enterprise add-on for SAML/OIDC SSO, SCIM, Admin Portal, and enforced SSO. | This avoids a premature auth rewrite while adding the identity features enterprise buyers expect. |
| Authorization model | Janusly remains the source of truth for `org_members`, roles/permissions, audit logs, and tenant scope. | Identity providers authenticate users; Janusly decides what each user can do inside an org. |

Product defaults for this strategy:

- Do not replace Supabase in the short term. WorkOS is enterprise identity plumbing, not a wholesale auth rewrite.
- Do not build SAML/OIDC/SCIM directly in v1; use WorkOS for those protocols and keep Janusly focused on workflow operations.
- Keep `/ai/generate-workflow` capped at the current 11 AI-generation node shapes: `noop`, `http`, `transform`, `condition`, `ai`, `tool`, `agent`, `router`, `approval`, `human_form`, and `loop`. In default `free_json` mode this cap is enforced locally by `AiGenerationWorkflowSchema`; in legacy `constrained` mode it is also the provider grammar cap.
- Keep advanced/operator-only node types on the placeholder-promotion path. Selectively add Pass-2 promotion only when the schema stays provider-strict and the generated workflow quality improves.
- Raise the practical priority of canonical demos: failed workflow recovery, refund triage, and incident triage. These demos should show the Recovery Queue, explanation, patch, diff, replay, health, audit, and MTTR story.
- Keep broad integration bets such as generic `db.query.*` and Stripe primitives gated until there is concrete customer pull. The commercial wedge is recovery and operational trust, not a large catalog.

Roadmap implications:

- ENG-091 makes Recovery Center the product home so operators start from failures, health, MTTR, and recommended actions.
- ENG-092 adds AI cost governance so enterprise buyers can operate LLM-heavy workflows with budget limits and spend visibility.
- ENG-093 validates the wedge with design partners and real workflows before the product over-invests in broad platform scope.
- ENG-094 extends MCP from "Janusly as a server" toward "safe external MCP tools as workflow steps" without opening arbitrary execution.
- ENG-095 packages the market narrative against Zapier, Make, n8n, Workato, Pipedream, Relay, and Gumloop.
- ENG-096..ENG-101 add the enterprise-auth path: shared `AuthContext`, hardened membership resolution, WorkOS SSO, SCIM, org auth policies, and fine-grained permissions.

### 16.10 Planning input archive

Three May 2026 proposal docs remain useful planning inputs, not live status
surfaces:

- [`docs/proposals/20260520-product-improvement-plan.md`](proposals/20260520-product-improvement-plan.md)
  curates candidate work and rejection rationale.
- [`docs/proposals/20260520-world-class-product-plan.md`](proposals/20260520-world-class-product-plan.md)
  sets the recovery/control-plane product direction.
- [`docs/proposals/20260520-world-class-execution-plan.md`](proposals/20260520-world-class-execution-plan.md)
  translates that direction into waves and candidate AC.

Use those docs during quarterly planning, then promote concrete work into
`docs/ROADMAP.md` §3b. Once shipped, preserve evidence only in ROADMAP §3c
ARCHIVED. Do not duplicate candidate ticket lists in this plan.
