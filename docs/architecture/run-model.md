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
| `run_nodes` | node × run | `status`, `attempts`, `state_json` (output / waiting metadata), `error_json`, `queue_publication_repair_after` (Postgres→BullMQ outbox/lease), `queue_publication_generation` (physical delivery identity), `started_at`, `finished_at`; unique on `(run_id, node_id)` |
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
- `claimNodeForExecution` — locks the parent run and claims the exact
  `queued → running` attempt/recovery generation. A terminal parent prevents
  execution; a failed parent atomically restores the consumed generation to
  `pending` with its durable queue-repair marker.
- `markWaitingNodeSucceeded` — `waiting → succeeded`, so a replayed resume
  submission cannot overwrite output or enqueue downstream work twice.
- `failStalledRunningNode` — `running → failed`, used only by the
  stalled-node reaper (below).

All in `packages/engine/src/persistence.ts`. Don't replace any of them with a
read-then-write.

## Execution lifecycle

1. **Start** — `startRun` inserts the `runs` row, ALL `run_nodes` rows, and the
   `run.started` event in **one transaction**, with the workflow snapshot
   persisted into `input_json`. Root nodes commit as `queued` with attempt 1,
   physical publication generation 1, and a due outbox marker; downstream
   nodes remain `pending`. Truth and initial publication intent therefore live
   in Postgres from the first instant—there is no post-commit root-claim gap or
   in-memory run state to lose. Validation, Replay Lab, and sandbox creators
   use the same atomic initial-generation posture for their executable nodes.
2. **Scheduling** — `enqueueReadyNodes` (`packages/engine/src/core/runtime.ts`)
   scans the DAG: a node is ready when ALL its incoming edges' sources are
   `succeeded`/`skipped` (readiness reads come from one run-context snapshot
   per scan, not per-node queries). Edge `condition` expressions route or
   skip. Ready nodes are claimed (`pending → queued`) and pushed to the
   BullMQ `workflow-nodes` queue (Redis). The queue transition writes a
   Postgres outbox marker first and clears it only after Redis accepts the
   deterministic physical-generation id, so a process crash cannot strand the
   row or confuse a required redelivery with an old retained BullMQ job.
3. **Execution** — the worker (`packages/engine/src/worker.ts`) validates the
   job payload with Zod, claims the exact `queued → running` generation while
   holding the parent-run lock, executes the node type's
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

### Subworkflow composition

A `subworkflow` node resolves an active child workflow in the same tenant.
Its optional `config.version` integer in PostgreSQL's 1..2,147,483,647 range pins an exact immutable
`workflow_versions.version`; absence deliberately means latest at execution
time. The child run stores the selected version row id and inherits the
parent trace id. The parent waits on the exact `childRunId`, receives the
child's declared `outputJson`, and preserves the earliest failed child node
and error when the child fails. Child creation and the parent's exact
`running → waiting` checkpoint plus `node.subworkflow.started` / `node.waiting`
events share one transaction; only after it commits may child roots publish.
Thus a fast child cannot terminate before its parent is durably resumable.

`runs.parent_link_kind` separates executable `subworkflow` invocation edges
from trace-only `replay` lineage. The recursion guard follows only contiguous
invocation edges and stops at a replay boundary, while a validation invocation
propagates `replay_mode='validation'` into every child so its write-side nodes
remain sandboxed.

Terminal child delivery is a second durable outbox. The same database write
that flips a linked child with `parent_link_kind='subworkflow'` to `succeeded`,
`failed`, or `cancelled` sets a millisecond-precision
`runs.parent_notification_after`; Replay Lab/validation source lineage is
excluded, but executable children inside validation still complete their
sandbox parent.
Legacy rows created before `parent_link_kind` remain executable when both
parent ids are present and `replay_mode` is null; the migration recursively
marks descendants of historical validation parents as `subworkflow` plus
`validation` before they can be replayed.
Immediate delivery clears the marker only after the exact parent node
transition and its DAG readiness or run rollup settle.
Successful parent-node state retains the child run id so a retry after the
node CAS can prove which handoff it repairs. A once-per-minute bounded
`system:subworkflow-terminal-reconciler` leases due markers with
`FOR UPDATE SKIP LOCKED`; failures remain eligible after two minutes. Recovery
that reopens the child clears the obsolete terminal marker, and every delivery
rechecks the current child status before touching the parent. A parent already
failed by one child still settles every exact waiting sibling failure before
acknowledgement, so a later child replay cannot reopen around an unresolved
wait. Reopen eligibility counts a sibling child that is already failed or
cancelled even while its durable handoff still leaves the parent node waiting.
Reopening also clears the parent's obsolete terminal marker in the same locked
status update.

Recovery is generation-bound. A successfully replayed child may repair only
the failed parent node whose `error_json.childRunId` still matches it. The
transaction locks the parent run, writes the child output, and reopens a
failed run only when no sibling failures remain; the same CAS also repairs a
child when a sibling replay already put the parent in `running`.
`claimNodeForExecution` takes the same run lock: a generation consumed before
the reopen is restored to `pending` with its exact attempt/token and durable
repair marker; a generation consumed after the reopen proceeds normally.
Before a recovered-parent transaction commits, it marks every still-pending
row for durable readiness reevaluation; this covers successors unblocked by an
earlier repaired sibling even if the immediate notifier process dies. The
once-per-minute queue-publication reconciler leases bounded compact due rows,
loads, processes, and releases one distinct pending-run workflow snapshot at a time, reruns readiness,
and republishes queued generations with
deterministic BullMQ ids. A new physical delivery increments the persisted
publication generation; retrying one publish reuses it. Exact execution claims
retain the attempt CAS, including legacy generation-zero jobs, and retry
markers retain the configured backoff. The
child's terminal recovery claim remains the only recovery-impact fact;
reattachment must not double-credit the parent.

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
