# Engine core runtime boundaries

## Goal

Keep workflow orchestration portable and testable by separating pure runtime
semantics from infrastructure adapters. BullMQ and Postgres are the production
adapters, but `WorkflowRuntime` owns the lifecycle rules.

## Current shape

```txt
packages/engine/src/
  core/
    runtime.ts          # WorkflowRuntime orchestration
    types.ts            # adapter/runtime contracts
    events.ts           # event-type catalogue + builder
    retry-policy.ts     # pure retry classifier/delay logic
    timeout.ts          # per-node timeout primitive
  adapters/
    postgres-execution-store.ts
    bullmq-queue-adapter.ts
    dead-letter-queue.ts
    replay-lab.ts
    sandbox-run.ts
    sample-failure.ts
  testing/
    in-memory-execution-store.ts
    in-memory-queue-adapter.ts
    scripted-node-executors.ts
  worker.ts             # BullMQ process wiring
  start-run.ts          # transactional run bootstrap
  resume-run.ts         # waiting-node resume path
```

`worker.ts`, `resume-run.ts`, `subworkflow.ts`, replay-lab helpers, and
sandbox-run helpers all construct or call `WorkflowRuntime` rather than
duplicating graph scheduling rules.

## Adapter contracts

`ExecutionStore` is the persistence boundary. The production implementation is
`PostgresExecutionStore`, which wraps the existing run/node/event persistence
helpers.

`QueueAdapter` is the queue boundary. The production implementation is
`BullMQQueueAdapter`, which composes the DLQ adapter. Failed-beyond-retry jobs
must keep flowing through this adapter so dead-letter insertion stays part of
the queue contract.

`NodeExecutorRegistry` is the node-execution boundary. The registry delegates
to concrete node executors in `node-registry.ts`; runtime core does not import
executor-specific config schemas.

The concrete registry is a `NodeExecutorMap` keyed by executor-owned node type.
Each `NodeContext<T>.config` is inferred from `NodeConfigByType[T]`, so a field
that belongs to another node type or has the wrong authored shape fails during
TypeScript checking as well as at the post-template Zod parse. `executeNode`
uses the same narrowed type for parsing and dispatch; `executeRegisteredNode`
is the only dynamic dispatch seam. `router` and `router_llm` are intentionally
absent because `WorkflowRuntime` owns their decision, branch-skip, semantic,
and persistence sequence directly.

## In-memory integration testkit

Engine integration tests can import `packages/engine/src/testing` instead of
assembling a fresh object of mocked adapter methods. `InMemoryExecutionStore`
is stateful across a complete run and models node status transitions, queue
publication generations, recovery claim tokens, run rollups, event history,
terminal failure persistence, and deterministic semantic cases.
`InMemoryQueueAdapter` keeps separate pending-publication and append-only
publication/DLQ histories, while `ScriptedNodeExecutorRegistry` selects async
handlers by node id or node type.

The testkit deliberately runs the real `WorkflowRuntime`; it is not a second
orchestrator and must not copy readiness, retry, or semantic-evaluation logic.
Its compare-and-set behavior is deterministic within one process, which makes
it suitable for lifecycle integration tests. PostgreSQL integration tests
remain authoritative for transaction isolation, row locking, and SQL-specific
constraints; BullMQ integration tests remain authoritative for delivery and
Redis behavior.

## Runtime lifecycle

`WorkflowRuntime.executeQueuedNode(input)` owns one queued node:

```txt
queued -> running -> succeeded -> enqueueReadyNodes
queued -> running -> waiting
queued -> running -> failed -> retry or DLQ
queued -> skipped when run is already cancelled/failed
```

Important guards:

- Pre-execution run-status check prevents jobs from executing after a run is
  already `cancelled` or `failed`.
- Atomic `queued -> running` claim prevents a stale queued job from executing
  after another worker or cancellation path advanced the row.
- Post-success cancellation check prevents downstream enqueue after an operator
  cancels while a node body is running.
- Retry policy is pure and explicit: no policy means no retry.

`WorkflowRuntime.enqueueReadyNodes(input)` owns graph readiness:

```txt
pending + dependencies terminal + edge condition satisfied -> queued
pending + dependencies terminal + no satisfied edge -> skipped
```

`parallel_fork` / `join` fan-in behavior is handled here, so callers do not
need custom scheduling branches for parallel subgraphs.

## Status contract

Run and node statuses are exported from `packages/shared/src/status.ts` and
re-exported by `core/types.ts` so API, engine, and web read the same values.
Changing a status is a cross-layer migration: database rows, engine runtime,
API docs, and web comparisons must change together.

Current run statuses:

```txt
created, running, waiting, succeeded, failed, cancelled, timed_out
```

Current node statuses:

```txt
pending, queued, running, waiting, succeeded, failed, skipped, cancelled
```

## Run start and resume boundaries

`startRun` keeps the run row, all initial node rows, and the `run.started`
event in one transaction. After that transaction commits, it queues start
nodes. Do not split the transactional bootstrap back into per-node writes.

`resumeRun` is the only path that completes waiting `approval`, `webhook`, and
`human_form` nodes. `human_form` resumes require an engine-signed token and
schema validation. New tokens bind the org/run/node/purpose tuple and sign both
`issuedAt` and `expiresAt`; `runs.humanFormResumeTtlSeconds` controls only newly
issued links in the 300..604800-second range, while legacy tokens without an
explicit expiry keep the original seven-day boundary. `webhook` resumes capture
the inbound payload as node output; `approval` preserves the historical
empty-output behavior.

## Remaining portability work

The core runtime boundary and typed concrete dispatch exist today. Remaining
improvements are narrower:

- tighten still-loose optional config fields only when their executors are
  touched, preserving passthrough compatibility by default;
- preserve compatibility exports while callers finish moving to the runtime
  boundary;
- avoid adding new infrastructure calls inside `core/*`.

Non-goals remain unchanged: do not replace BullMQ, Drizzle/Postgres, or the
public API contract as part of runtime-boundary maintenance.
