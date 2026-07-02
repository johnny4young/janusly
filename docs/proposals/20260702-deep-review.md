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

1. ~~DLQ list detail-split.~~ **Implemented in this PR (second batch):**
   `listRecoveryQueue` projects summary columns (+ `nodeType` /
   `workflowName` one-field extractions) instead of spreading the full
   `dead_letters` row; the existing `GET /dlq?id=` detail read returns the
   full snapshots, and the web (`DeadLettersPanel`) fetches it on row
   selection / before opening the Recovery dialog, with the summary row as
   graceful fallback. Cuts a 200-row queue page from potentially tens of MB
   to KBs.
2. ~~BullMQ job payload slimming.~~ **Implemented (follow-up PR).**
   `enqueueNode` now writes a SLIM `{ runId, nodeId, attempt }` payload; the
   worker reloads the workflow once per job from `runs.inputJson.workflow`
   (the authoritative snapshot) via `loadRunWorkflowRaw` + the existing
   content-addressed `parseWorkflowCached`, and resolves the node by id. The
   sandbox / replay-lab / validation run creators now store the workflow RAW
   in `inputJson` (was `safePersistPayload`, which key-redacts + truncates and
   would corrupt a reloaded executable DAG). `replayDeadLetter` writes the
   replayed workflow to the snapshot (`setRunWorkflowSnapshot`) BEFORE
   enqueueing, so an auto-healing / recovery replay against a PATCHED workflow
   has its downstream cascade reload the patched DAG — matching the pre-slim
   behaviour where the replayed workflow flowed in-memory into
   `enqueueReadyNodes`. A missing run row degrades to a benign skip; genuine
   corruption throws `UnrecoverableError` → DLQ.
3. ~~Node-output double-write.~~ **Implemented (follow-up PR).** The
   `node.succeeded` event no longer repeats a large output that already lives
   in `run_nodes.state_json`. Below an 8 KB cap the event still carries the
   full output (the live SSE Inspector stays byte-identical to a refetch);
   above it the event carries `{ outputBytes, outputTruncated }`, so a 1 MB
   http body isn't written twice and `GET /run` doesn't ship both copies. The
   web SSE consumer already degrades a missing output to an empty preview and
   fills the full value from the node row on refetch.
4. ~~Node completion round-trips.~~ **Implemented (follow-up PR).** In
   addition to the `Promise.all` on the independent routing-stats + event
   writes, `markNodeSucceededWithEvent` now commits the `run_nodes`
   `succeeded` UPDATE and its `node.succeeded` `run_events` INSERT in ONE
   transaction (one round-trip instead of two; commit-or-rollback together;
   the SSE publish fires only after commit).
5. ~~Alerts scanner fan-out.~~ **Implemented in this PR (batches 5–6):**
   org scans run through a bounded worker pool (concurrency 4), and
   `scanScheduleAnomalies` now makes ONE batched query per org
   (`queryScheduleFiresByWorkflow`, per-workflow newest-first cap preserved
   via `ROW_NUMBER() OVER (PARTITION BY workflow_id ...)`) instead of up to
   ~200 sequential per-workflow queries per cron tick.

### 2b. Architecture / maintainability

6. ~~Split `apps/api/src/routes/ai-routes.ts` and add route tests.~~
   **Implemented (follow-up PR).** `ai-routes.ts` (1,148 lines) is now a
   33-line composition point spreading six per-route arrays
   (`ai-health-route`, `ai-generate-route`, `ai-explain-route`,
   `ai-review-route`, `ai-patch-route`, `ai-improve-route`) in the original
   first-match order; shared `withBudgetWarning` moved to
   `ai-route-helpers.ts`. Four new test files (explain / review / patch /
   improve, +23 cases) mirror the `audit-routes` `vi.mock` harness — auth
   gate, AI-mode happy path, and the AI-fallback path (asserting the audit
   row still fires). No route behaviour, response shapes, audit actions, or
   role declarations changed.
7. ~~Split `packages/engine/src/tool-registry.ts` (1,486 lines).~~
   **Implemented (follow-up PR).** Tools moved into
   `tools/{http,text,json,csv,time,crypto,pdf,email}.ts`, each exporting its
   `ToolDefinition` record; `defineTool` + the `ToolDefinition` /
   `ToolExecutionContext` types live in `tools/tool-types.ts` (no import
   cycle); the registry keeps `validateToolInput` / `executeTool` /
   `listTools` and assembles the `tools` object by spreading the domain
   records. Registry shrank to ~271 lines.
8. ~~Type the agent loop.~~ **Implemented in this PR (fourth batch):**
   `LlmPlannerReplySchema` (Zod) gates the LLM planner's JSON reply — a
   malformed plan shape now degrades to the rules planner with `aiError`
   attribution instead of flowing untyped into `executeTool`; `runAgentLoop`
   takes a typed `AgentNodeConfig` (schema gains the `name`/`role`/
   `persona`/`reflection`/`model` fields it already read via passthrough),
   steps are `AgentLoopStepRecord[]`, and the `worker.ts`
   `node as any, workflow as any` casts are gone (`validateJobData` returns
   real types).
9. **Standardize on `errorEnvelope`.** **Partially implemented (follow-up
    PR):** the named `sendError(res, code, message, status, params?)`
    chokepoint now exists in `http.ts` and the already-coded
    `sendJson(res, errorEnvelope(...))` sites route through it. The remaining
    free-form `sendJson(res, { error: … })` sites are left as the deliberate
    staging `error-codes.ts` already documents ("~150 lower-traffic envelopes
    stay free-form in v1 … picked up in a future pass") — coding them is a
    product-copy effort (each needs a closed-catalog entry + EN/ES i18n with
    the parity gate), not a mechanical sweep, and mass-adding untranslated
    codes would dilute the closed catalog. Tracked as its own ticket.
10. ~~Split `WorkflowsDashboard.tsx` + `orgConfigRepo.ts`.~~ **Implemented
    (follow-up PR).** `WorkflowsDashboard.tsx` (1,649 → 1,265 lines) extracted
    `TrashPanel`, `FlowRow`, and `FlowsFilterBar` (the container keeps all
    state / data-fetching / mutations and passes them down; no markup /
    class / aria / i18n changes). `orgConfigRepo.ts` (1,430 → 588 lines)
    extracted the ~600-line `ORG_CONFIG_DEFINITIONS` catalog + forbidden-name
    / forbidden-value guards + the pure normalize/validate pipeline into
    `orgConfigCatalog.ts` (no DB access, no import cycle); every moved symbol
    is re-exported so `@janusly/data` consumers are unaffected.
11. ~~`@types/node` pin.~~ **Implemented in this PR (third batch):** all ten
    packages now declare `^24.10.1`, matching `engines: node >=24` and the
    Node 24 CI lanes.
12. ~~i18n key typing.~~ **Implemented in this PR (sixth batch):** the 13
    scattered `t(key as any)` casts collapsed into one documented
    `tServerCode(key, options)` seam. Full static typing is impossible here
    by design — the key's code half originates on the server — so the win is
    a single, deliberate escape hatch (with the `MISSING`-sentinel fallback
    built in) instead of 13 unreviewed casts.
13. ~~Permission catalog nit.~~ **Implemented in this PR (sixth batch):**
    the empty `plugins` member is gone — `PermissionCategory` now declares
    exactly the 19 active categories AGENTS.md documents.

### 2c. Operations / deployment

14. ~~Production container images.~~ **Implemented in this PR (fourth
    batch):** `Dockerfile.prod` with `api` + `worker` targets — frozen
    lockfile, non-root user, `NODE_ENV=production`, no watch mode, and a
    `HEALTHCHECK` against `GET /health` on the api target. The workspace is
    TS-first (tsx runtime), so images keep the full install by design; the
    dev images stay dev-oriented. Prune-to-prod-deps remains open if the
    workspace ever moves to emitted JS.
15. ~~Graceful-shutdown parity for the API.~~ **Verified already done** —
    `apps/api/src/index.ts` drains on SIGTERM/SIGINT with a force-close
    timer (`API_SHUTDOWN_GRACE_MS`) and closes the auto-healing/alerts/
    run-stream subsystems. No action needed.

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
21. ~~Cost-aware Best-of-N.~~ **Implemented in this PR (second batch):**
    `budgetAwareCandidateCount` collapses the configured N to single-shot
    once monthly spend crosses the budget's warning threshold; no budget
    configured keeps N untouched. Wired into `/ai/generate-workflow` using
    the envelope its budget gate already loads.
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
