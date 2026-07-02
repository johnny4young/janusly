# Deep review — 2026-07-02

A full-project audit across security, correctness, performance, architecture,
and maintainability, plus a forward roadmap. Method: four parallel review
passes (security, correctness bugs, performance, architecture/convention
drift), every finding re-verified against the actual code before being
accepted, quick wins implemented in the same PR, larger items written up here
with concrete designs so they can become `ENG-NNN` tickets.

Baseline at review time: `pnpm build` + `pnpm test` fully green
(3,143 tests across shared/ai/data/engine/api/web), roadmap §3b effectively
empty (only ENG-093, the private-beta experiment, remains Pending).

---

## 1. Implemented in this PR

### 1a. Safe-persist chokepoint now reachable from the data layer (security hardening)

**Finding.** AGENTS.md declares "every jsonb write to … `audit_logs.metadata`
goes through `safePersistPayload`", but six system-audit writers wrote raw
metadata because the chokepoint lived in `packages/engine` and
`packages/data` cannot depend on the engine (dependency cycle):
`rate-limit-degradation.ts` (which had to hand-roll `scrubSecretShapes`
up-front to compensate — the module's own comment says so),
`memoryEntriesRepo.ts` `writeAudit`, `autoHealingRepo.ts` `writeAudit`,
`stalled-node-reaper.ts`, `audit-logs-retention-scheduler.ts`, and
`scim-events-retention-scheduler.ts`.

**Fix.** `safePersistPayload` moved to `packages/shared/src/safe-persist.ts`
(deep import, deliberately NOT in the shared barrel — the barrel is consumed
by the browser bundle). `packages/engine/src/safe-persist.ts` is now a
re-export shim so every engine-internal import keeps working; `redactValues`
moved with it (engine `template.ts` re-exports). All six writers wrap their
metadata. Byte measurement switched from `Buffer` to `TextEncoder` so the
module stays runtime-neutral. The documented invariant is now structurally
enforceable across layers instead of aspirational.

### 1b. Performance quick wins (all verified against real query shapes)

- **`updateRunStatusFromNodes` status-only projection**
  (`packages/engine/src/persistence.ts`). Ran after every node completion and
  selected full `run_nodes` rows — dragging each node's `state_json` (up to
  1 MB) over the wire to inspect one column.
- **`enqueueReadyNodes` cheap context path**
  (`packages/engine/src/core/runtime.ts` + `persistence.ts`
  `getRunContext(runId, { statusesOnly })`). The readiness scan only needs
  node statuses unless an edge carries a `condition`; previously every
  completion re-loaded every node's full state. For a 50-node run with heavy
  HTTP outputs this was the dominant O(N²) transfer on the hottest engine
  path. Conditional-edge workflows keep the full load (expressions can reach
  into outputs).
- **`GET /runs` list no longer ships `inputJson`**
  (`apps/api/src/routes/runs-routes.ts`). Each run row carries the full
  workflow snapshot captured by `startRun`; a 100-row page shipped 100
  workflow JSONs the list never renders. Both list branches now use a shared
  summary projection (`outputJson` kept — the web renders it for the active
  run). `GET /run` detail is unchanged; `docs/api.md` updated.
- **`removeOnFail` on the BullMQ queue** (`packages/engine/src/queue.ts`).
  `removeOnComplete: 1000` was set but failed jobs were kept forever, each
  holding a full workflow payload. Postgres `dead_letters` is the durable
  failure record; Redis now keeps `{ count: 1000, age: 7d }`.
- **Two hot-path indexes** (schema + two-file migration
  `20260702042722_dapper_crusher_hogan`, with `production-rollout.sql`
  runbook per the AGENTS.md pattern):
  - `run_nodes_running_started_idx` — partial index
    `(started_at) WHERE status = 'running'` for the stalled-node reaper,
    whose sweep (`status='running' AND started_at < cutoff`) was a
    sequential scan of the system's largest table.
  - `dead_letters_org_created_idx` — `(org_id, created_at DESC, id DESC)`
    backing the recovery queue's default `newest`/`oldest` sorts when no
    status filter is applied (the existing index has `status` in the middle,
    so Postgres re-sorted the org's whole DLQ per page).
- **Recovery memory hint: one embedding instead of two**
  (`packages/data/src/memoryEntriesRepo.ts` + `apps/api/src/ai-recovery-memory.ts`).
  `recallMemory` gained `kinds: MemoryKind[]` (one embedding round-trip, one
  pgvector query with `kind IN (...)`); `composeRecoveryMemoryHint` recalls
  `recovery_rationale` + `patch_rationale` in a single call. Per
  `/ai/patch-workflow` this removes a duplicate embedding network call and
  ~2 redundant `org_configs` reads.

### 1c. Maintainability

- **Keyset-cursor parser unified** — `parseKeysetCursor` in
  `apps/api/src/run-pagination.ts` is now the single implementation of the
  `<iso>|<id>` wire format; `parseEventsCursor` and the Flows-list
  `parseBeforeCursor` delegate to it. (The DLQ cursor is a genuinely
  different base64url format and stays separate.)
- **Unused `openai` dependency removed** from `packages/ai` — only
  `@ai-sdk/openai` / `@ai-sdk/anthropic` are imported anywhere; embeddings go
  through raw fetch. AGENTS.md stack-baseline line corrected ("OpenAI SDK 6"
  → Vercel AI SDK 6).
- **Docs drift fixed in AGENTS.md** — safe-persist location, and
  `withAuditTx` consumers (it's also used by credential rotation and
  `orgMembersRepo`, not just `commitMemory` + SSO).

---

## 2. Verified findings, deferred with designs

Ordered by value. Each is scoped to be a single ticket.

### 2a. Performance

1. **DLQ list detail-split** (high value, needs a small web change — why it's
   not in this PR). `/dlq` + `/dlq/queue` spread `...dl` per row, shipping the
   uncapped `workflow_json`/`node_json` (persisted with `maxBytes: Infinity`
   for replay fidelity) to render a table. But the web's `RecoveryDialog` and
   `DeadLettersPanel` consume `workflowJson` straight off the LIST row today.
   Design: add `GET /dlq/:id` returning the full row; list endpoints project
   summary columns + a bounded `errorJson` excerpt; the dialog fetches detail
   on open. Cuts a 200-row queue page from potentially tens of MB to KBs.
2. **BullMQ job payload slimming.** `enqueueNode` serializes
   `{ runId, workflow, node }` per node job — a 100-node workflow writes its
   full JSON into Redis 100+ times per run, and `worker.ts` re-runs
   `WorkflowSchema.safeParse` on every job. Design: enqueue
   `{ runId, nodeId }`; worker loads + validates the workflow once per run
   behind a small LRU keyed by `runId` (`runs.input_json` already holds the
   snapshot; DLQ rows keep their own copy so replay is unaffected). Interim
   step with most of the CPU win and none of the contract change: per-run
   parsed-workflow cache in the worker.
3. **Node-output double-write.** Every success persists the output in
   `run_nodes.state_json` AND repeats it in the `node.succeeded`
   `run_events.payload` — up to 2× write amplification on the hottest write
   path, and `GET /run` ships both copies. Design: event payload carries
   `{ attempt, outputBytes }` (or a small preview); audit web timeline
   consumers first (they already fetch node rows).
4. **Node completion round-trips.** The success path is ~7–9 sequential DB
   RTTs (`markNodeRunning` → event → metadata → context → execute →
   `markNodeSucceeded` → routing stats → event → status → enqueue scan).
   Safe batching without touching the atomic-claim invariants:
   `Promise.all` the independent writes (routing stats + event), and combine
   `markNodeSucceeded` + its event in one transaction.
5. **Alerts scanner fan-out.** Sequential per-org iteration ×
   per-scheduled-workflow `queryScheduleFires` (up to ~200/org) can outlast
   the cron interval at fleet scale. Design: one grouped query
   (`GROUP BY workflow_id, day, hour`) + bounded concurrency (4–8) over orgs.

### 2b. Architecture / maintainability

6. **Split `apps/api/src/routes/ai-routes.ts` (1,141 lines, 7 routes) and add
   route tests.** The `/ai/patch-workflow` handler alone is ~437 lines and
   gates spend (budget) + recovery patching; the route files
   (`ai-routes`, `workflows-routes` 811, `recovery-items-routes` 694) are the
   largest untested surface in the repo — sibling route files
   (`audit-routes`, `mcp-routes`) show the established `vi.mock` pattern to
   copy. One module per route; `index.ts` already composes arrays.
7. **Split `packages/engine/src/tool-registry.ts` (1,486 lines)** by tool
   domain (`tools/{http,text,json,csv,time,crypto}.ts`, each exporting
   `ToolDefinition[]`), keeping `defineTool`/`validateToolInput`/
   `executeTool`/`listTools` in the registry. `vector-tools.ts` /
   `db-query-tools.ts` are the in-repo precedent.
8. **Type the agent loop.** `runAgentLoop` (`node-registry.ts`) takes
   `agentConfig: any` and casts `(plan as any).done/.finalAnswer` — LLM
   planner output flows untyped into tool execution. Zod plan schema (house
   style everywhere else) + remove the `worker.ts` `node as any,
   workflow as any` casts at the queue→execution boundary.
9. **Standardize on `errorEnvelope`.** The canonical helper has 83 call
   sites, but ~280 inline `sendJson(res, { error: … })` sites bypass it, so
   the `code` field the web localizes against is inconsistently present.
   Mechanical sweep behind a `sendError(res, code, message, status)` helper.
10. **Split `WorkflowsDashboard.tsx` (1,649 lines, 62 hooks)** —
    `TrashPanel`, `FlowsFilterBar` (pure logic already lives in
    `flows-filters.ts`), `FlowRow`. And **`orgConfigRepo.ts` (1,430)** —
    extract the ~600-line `ORG_CONFIG_DEFINITIONS` catalog + guards from the
    DB read/write layer.
11. **`@types/node` pin.** Workspace declares `^25.9.2` against
    `engines: node >=24` / Node 24 CI — typings from a newer major can admit
    APIs absent at runtime. Pin `^24`.
12. **i18n key typing.** `apps/web/src/i18n/server-events.ts` has 13×
    `t(key as any)`; typo'd keys ship silently (mitigated by `defaultValue`).
    Type the key union.
13. **Permission catalog nit.** `PermissionCategory` declares 20 categories
    but `plugins` has zero entries — drop it or land its first key (AGENTS.md
    says "19 active categories", which is correct only by accident).

### 2c. Operations / deployment

14. **Production container images.** `Dockerfile.api` runs `pnpm dev` as
    root with no `HEALTHCHECK` and installs dev deps — fine for local, not a
    deploy artifact. Design: multi-stage build (install → build → prune to
    prod deps), non-root `USER`, `HEALTHCHECK CMD wget -qO- localhost:3001/health`,
    `NODE_ENV=production`, and a worker-mode variant (same image,
    different command).
15. **Graceful-shutdown parity for the API.** The worker drains on
    SIGTERM/SIGINT; give the API the same treatment (`server.close()` +
    in-flight request grace) so rolling deploys don't drop requests.

### 2d. Security posture (verified — no criticals found)

Checked and solid: timing-safe compares on the service token
(`constantTimeBearerMatch`) and resume-token HMAC (`timingSafeEqual` with
length guard); JSON body caps (`readJson` 413s over `API_MAX_JSON_BODY_BYTES`);
the DB-tool SQL validator is conservative in the right direction (single
statement, no comments, no semicolons anywhere including inside strings, CTEs
rejected wholesale, verb-class allowlists, contiguous-placeholder checks);
SSRF policy pins validated DNS into the undici connect; keyset cursors split
on the LAST `|` (UUID/ISO parts can't smuggle a separator); tenancy scoping is
consistently `eq(<table>.orgId, auth.orgId)` inside handlers with the
documented run-gate exception commented in place. Remaining recommendations
are hardening, not holes: the container work above (14), and periodically
re-baselining the `SECRET_VALUE_PATTERNS` catalog against new provider token
formats.

---

## 3. Toward world-class — 30 realizable feature proposals

Grouped; each is buildable on the existing architecture (route registry,
tool registry, org_configs catalog, memory substrate, alerting seams) without
new infrastructure unless noted.

**Recovery & reliability (the wedge)**

1. **Recovery SLA policies per severity** — org-configurable
   time-to-acknowledge/time-to-resolve targets; breach → alert policy
   trigger; SLA attainment on the value dashboard.
2. **Runbook attachments on failure clusters** — pin a `runbook_fragment`
   memory entry to a cluster signature; the recovery dialog surfaces it
   before the AI patch (deterministic help first, LLM second).
3. **Bulk cluster replay with canary** — replay 1 of N cluster members in
   validation mode, auto-promote to the rest on success (extends
   `cluster-apply`).
4. **Scheduled chaos drills** — a `system:` cron that re-injects a solution
   pack's failure fixture into a sandbox run monthly and verifies the
   recovery path still works; report to the health rollup ("recovery
   readiness score").
5. **MTTR budgets & burn alerts** — per-workflow MTTR target in
   `org_configs.runs`; the health rollup tracks rolling attainment and fires
   the alert seam on burn.
6. **Postmortem generator** — one-click export of a resolved recovery item
   (timeline, evidence, patch diff, feedback) as Markdown via the existing
   report-delivery channel.

**Workflow authoring**

7. **Sub-second workflow lint-on-type** — run `checkWorkflowReadiness` rules
   client-side (they're deterministic; `@janusly/shared` already ships to
   the browser) for instant badge feedback before save.
8. **Workflow templates from history** — "save run as template": snapshot a
   successful run's workflow + input shape into the snippets library.
9. **Node-level cost annotations in the canvas** — join `usage_events`
   per nodeId to show $/run per LLM node; surfaces expensive prompts
   visually.
10. **Version diff on save confirmation** — reuse `computeWorkflowDiff` +
    `WorkflowDiffView` to show the structural diff before `POST /workflows/save`
    commits a new version.
11. **Input presets per workflow** — named input payloads stored in
    `workflow_metadata`; the run dialog offers them (typed-inputs UX).
12. **Undo/redo history in the canvas** — bounded local snapshot stack;
    pairs with the existing viewport persistence.

**Integrations & tools**

13. **Webhook signature verification presets** — per-credential HMAC config
    (header, algo, tolerance) enforced at `/triggers/<kind>/ingest`, reusing
    the SCIM/WorkOS verification pattern.
14. **`s3.put`/`s3.get` object-store tools** — the pdf.generate object store
    already exists; expose it (and external S3-compatible targets) as
    write-side/read-side tools with the standard envelope.
15. **`sheet.append` tool (Google Sheets/CSV-compatible)** — the most
    demanded business-workflow sink; rides `fetchHttpTarget` + credentials.
16. **Slack two-way approvals** — `approval` nodes post to Slack with
    signed action buttons that hit `/resume` (resume-token HMAC already
    binds org/run/node/purpose).
17. **MCP marketplace manifest** — a curated, versioned list of vetted MCP
    servers (name → transport/command/consent defaults) importable per org;
    builds on the existing discovery + consent chokepoints.
18. **Credential expiry watch** — `credentials.health` already exists; add
    expiry metadata + a `system:` cron that warns N days ahead via alert
    policies.

**AI pipeline**

19. **Per-workflow prompt overrides via PromptOps** — let a workflow pin a
    registered prompt version for its `llm` nodes (registry + pinning
    already exist; wire the lookup into the node executor).
20. **Eval-set auto-harvest from recovery feedback** — accepted patches +
    operator feedback become labeled eval cases (opt-in, consent-gated) in
    `eval_datasets`.
21. **Cost-aware Best-of-N** — dynamic N from remaining budget
    (`checkBudget` already returns headroom): full N when cheap, N=1 near
    the gate.
22. **Semantic run search** — embed run-explain summaries into the memory
    substrate (`run_summary` kind exists) and expose "find runs like this
    failure" in the Recovery Center.
23. **Confidence-calibrated auto-apply** — when patch-confidence calibration
    (already tracked) exceeds a threshold for a failure signature, offer
    one-click "apply + validation replay" instead of the full dialog.
24. **Prompt-injection red-team eval lane** — extend `pnpm evals` with
    adversarial workflow-generation prompts asserting the DATA-framing
    escape holds; gate on the baseline like ai-mode rates.

**Platform & operations**

25. **Org-level usage exports** — monthly `usage_events` rollup (tokens,
    $, per-workflow) as CSV via report delivery; the billing-page
    placeholder becomes real without Stripe.
26. **Run archival tier** — `system:retention` gains an archive step:
    export terminal runs older than N days to the object store as JSONL
    before deletion (compliance + cheap history).
27. **Read-only status page** — unauthenticated, org-scoped signed URL
    showing workflow health rollup (green/amber/red) for stakeholders;
    reuses the two-tier health snapshot pattern.
28. **Multi-region worker awareness** — `service.instance.id` already
    disambiguates processes; add per-instance heartbeats + a worker fleet
    panel in Operations (stale worker detection).
29. **Terraform/Pulumi provider via the Python SDK** — declarative
    workflow-as-code applying through `/workflows/save` + readiness gate;
    the SDK and idempotent save semantics already exist.
30. **Public API versioning & OpenAPI spec** — generate an OpenAPI document
    from the route registry (method/path/role/permission are already
    declarative) and serve `/openapi.json`; unblocks typed third-party
    clients and contract tests.

---

## 4. Suggested sequencing

1. This PR (chokepoint move + perf quick wins + hygiene).
2. §2a items 1–2 (DLQ detail-split, queue payload slimming) — the two
   remaining scale cliffs.
3. §2b items 6–8 (ai-routes split + tests, tool-registry split, typed agent
   loop) — biggest maintainability leverage.
4. §2c (production images + API graceful shutdown) before any real deploy.
5. Feature work: recovery items (1–6) first — they compound the wedge the
   roadmap already bet on.
