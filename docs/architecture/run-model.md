# The run model: how a workflow execution is persisted, observed, and audited

This is the one-stop map of what a *run* is in Janusly — which tables hold it,
how its state machine advances, where the truth lives when a process dies, and
how an operator reconstructs a past run exactly as it happened. It ties
together the deeper docs:

- [`engine-core-runtime-boundaries.md`](engine-core-runtime-boundaries.md) — runtime/adapter seams.
- [`run-cancellation.md`](run-cancellation.md) — cancellation semantics.
- [`../workflows.md`](../workflows.md) + [`../nodes.md`](../nodes.md) — how to define a workflow (DAG JSON, node configs, templating).
- `AGENTS.md` (repo root) — the operational invariants, in exhaustive detail.

## Data model

Three tables carry every execution (`packages/db/src/schema.ts`):

| Table | One row per | Load-bearing columns |
| --- | --- | --- |
| `runs` | execution | `org_id` (tenant scope), `workflow_version_id`, `status`, `input_json` (the **workflow snapshot** + trigger input captured at start), `output_json` (declared-outputs projection at terminal), `replay_mode` (`NULL` = production; `"validation"` = sandbox/replay-lab), `parent_run_id`/`parent_node_id` (subworkflows), `trace_id` |
| `run_nodes` | node × run | `status`, `attempts`, `state_json` (output / waiting metadata), `error_json`, `started_at`, `finished_at`; unique on `(run_id, node_id)` |
| `run_events` | lifecycle event | append-only timeline (`node.queued`, `node.running`, `node.succeeded`, `node.failed`, `node.retry`, `node.skipped`, `decision.made`, …) with `(created_at, id)` keyset pagination |

There are intentionally **no foreign keys** (orphan-tolerant posture): a
deleted workflow leaves its historical runs inspectable, because the run
carries its own workflow snapshot in `input_json.workflow`.

## Status machine

The single source of truth for status values is
`packages/shared/src/status.ts` (shared by engine, API, and web):

- **Node**: open `pending → queued → running → waiting`, terminal
  `succeeded | failed | skipped | cancelled`.
- **Run**: open `created | running | waiting`, terminal
  `succeeded | failed | cancelled | timed_out` (`timed_out` is reserved for a
  future run-level deadline; nothing writes it today).

Every transition that could race is a conditional UPDATE (compare-and-set):

- `tryClaimNodeForQueue` — `pending → queued`, the **only** multi-worker
  double-claim guard for fan-in (two predecessors completing at once).
- `markNodeRunning` — `queued → running`, so a cancellation landing while a
  job sits in the queue can never be flipped back to running.
- `markWaitingNodeSucceeded` — `waiting → succeeded`, so a replayed resume
  submission cannot overwrite output or enqueue downstream work twice.
- `failStalledRunningNode` — `running → failed`, used only by the
  stalled-node reaper (below).

All in `packages/engine/src/persistence.ts`. Don't replace any of them with a
read-then-write.

## Execution lifecycle

1. **Start** — `startRun` inserts the `runs` row, ALL `run_nodes` rows
   (`pending`), and the `run.started` event in **one transaction**, with the
   workflow snapshot persisted into `input_json`. Truth lives in Postgres
   from the first instant; there is no in-memory run state to lose.
2. **Scheduling** — `enqueueReadyNodes` (`packages/engine/src/core/runtime.ts`)
   scans the DAG: a node is ready when ALL its incoming edges' sources are
   `succeeded`/`skipped` (readiness reads come from one run-context snapshot
   per scan, not per-node queries). Edge `condition` expressions route or
   skip. Ready nodes are claimed (`pending → queued`) and pushed to the
   BullMQ `workflow-nodes` queue (Redis) — async and durable, never blocking
   the API request path.
3. **Execution** — the worker (`packages/engine/src/worker.ts`) validates the
   job payload with Zod, claims `queued → running`, executes the node type's
   executor, then marks `succeeded` / `waiting` (approval, human form, wait
   timer) / retries with the node's `retryPolicy` backoff.
4. **Failure** — when attempts are exhausted, the node is marked `failed`,
   the exact failed job payload (workflow + node JSON, key-redacted, never
   truncated) lands in `dead_letters`, and the run rolls up to `failed`.
   `POST /dlq/replay` reconstructs the job byte-for-byte; the Recovery dialog
   can sandbox-validate an AI-suggested patch first (`replay_mode =
   "validation"` runs skip write-side effects via the dry-run gate).
5. **Rollup** — `updateRunStatusFromNodes` flips the run terminal when no node
   is open: any `failed` → `failed`; all terminal → `succeeded` (projecting
   declared `workflow.outputs` into `output_json` in the same UPDATE).
6. **Worker death** — the one failure the claims can't self-heal: a worker
   killed mid-node leaves the row `running`. The stalled-node reaper
   (`packages/engine/src/stalled-node-reaper.ts`, every 5 min) CAS-fails
   nodes stuck past the threshold (default 60 min), dead-letters them
   best-effort, and terminates the run — failed-into-DLQ, never silently
   re-executed, because the node may have already run a non-idempotent side
   effect. The operator decides on replay.

## Observability

- **Timeline**: every lifecycle step appends a `run_events` row through
  `appendEvent`, which redacts ONCE via `safePersistPayload` and then both
  persists and publishes the same object — a streamed event can never expose
  a value the persisted row wouldn't.
- **Live**: `GET /runs/:runId/stream` (SSE over Redis pub/sub) streams events
  + terminal flips, with `Last-Event-ID` gap replay on reconnect; the web
  falls back to 1.5 s polling when the stream drops.
- **Logs**: the worker emits one structured JSON line per node event
  (`logNodeEvent`) carrying `runId`/`nodeId` — the correlation key joining
  logs ↔ UI ↔ rows. OTel tracer/meter run under `service.name="janusly"`.
- **Cost**: every LLM call writes a `usage_events` row (tokens, latency,
  cost) from the `LlmClient` chokepoint; integration/email/PDF/MCP tools do
  the same on success AND failure.

## Reviewability + auditability

- **Versioning**: saving a workflow appends an immutable `workflow_versions`
  row (the DAG is never edited in place; rollback inserts a new version).
  Editing a workflow therefore never invalidates history — old runs keep
  pointing at their version AND carry their own snapshot.
- **Audit trail**: `audit_logs` is append-only (the only deletes are the
  documented retention sweeps), written through typed audit actions with
  actor attribution (user, mode, service-token suffix, system sentinels).
  Read it via `GET /audit` (admin) or the Operations → Access panel.
- **Reconstruction**: a past run is rebuilt from durable rows only — the
  `runs` row (status, input, snapshot), its `run_nodes` (per-node output /
  error / timing), its `run_events` page (ordered timeline), plus the audit
  rows scoped to the run. `GET /reports/run-explain` exports that as a
  downloadable artefact; `POST /recovery/items/:id/evidence` bundles the
  incident view (run + DLQ + validation replay + audit + diff) for
  compliance handoff.
- **Replays are labeled**: sandbox/validation runs carry `replay_mode` and
  are excluded from production health/cluster rollups, so experiments never
  contaminate the operational record.

## Defining a workflow

A workflow is a JSON DAG — `nodes` (typed: `http`, `transform`, `condition`,
`ai`, `tool`, `agent`, `approval`, `loop`, `parallel_fork`/`join`, …) plus
`edges` (optionally guarded by a limited-grammar `condition` expression) and
optional declared `outputs`. Author it in the Studio, via
`POST /ai/generate-workflow`, or by hand against `WorkflowSchema`; validate
with `POST /workflows/validate`; check production-readiness (retries, bounds,
approval gates, secret hygiene) with `POST /workflows/readiness`. See
[`../workflows.md`](../workflows.md) for runnable examples and
[`../nodes.md`](../nodes.md) for every node type's config contract.
