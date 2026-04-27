# Engine core runtime boundaries

## Goal

Move the workflow engine from a BullMQ/Postgres-coupled implementation toward a portable runtime with explicit ports and adapters.

The target architecture is:

```txt
packages/engine
  src/
    core/                 # pure orchestration rules and runtime contracts
      execution-context.ts
      runtime.ts
      types.ts
    adapters/             # infrastructure implementations
      bullmq/
      postgres/
    nodes/                # node executors and registries
```

## Current coupling

The worker currently coordinates node state transitions, event emission, execution, scheduling, and queueing in one place. That is productive for the MVP, but it makes the engine harder to reuse outside BullMQ and harder to test without Redis/Postgres.

## Design principles

1. The core runtime owns workflow execution semantics.
2. Infrastructure is injected through small interfaces.
3. Node execution is pluggable through a typed executor registry.
4. The runtime should be testable in memory without Redis or Postgres.
5. BullMQ workers should become an adapter, not the engine itself.

## Proposed ports

```ts
type NodeTerminalStatus = "succeeded" | "failed" | "skipped" | "cancelled";
type NodeStatus = "pending" | "queued" | "running" | "waiting" | NodeTerminalStatus;
type RunStatus = "created" | "running" | "waiting" | "succeeded" | "failed" | "cancelled" | "timed_out";
```

```ts
interface ExecutionStore {
  getRunContext(runId: string): Promise<RunContext>;
  getNodeStatus(runId: string, nodeId: string): Promise<NodeStatus>;
  markNodeQueued(runId: string, nodeId: string): Promise<void>;
  markNodeRunning(runId: string, nodeId: string): Promise<void>;
  markNodeSucceeded(runId: string, nodeId: string, output: unknown): Promise<void>;
  markNodeFailed(runId: string, nodeId: string, error: SerializedError): Promise<void>;
  markNodeWaiting(runId: string, nodeId: string, metadata?: unknown): Promise<void>;
  markNodeSkipped(runId: string, nodeId: string, metadata?: unknown): Promise<void>;
  appendEvent(event: WorkflowEvent): Promise<void>;
  updateRunStatusFromNodes(runId: string): Promise<void>;
}
```

```ts
interface QueueAdapter {
  enqueueNode(input: EnqueueNodeInput): Promise<void>;
}
```

```ts
interface NodeExecutorRegistry {
  execute(input: ExecuteNodeInput): Promise<NodeExecutionResult>;
}
```

## Proposed runtime orchestration

The runtime should expose two main operations:

```ts
interface WorkflowRuntime {
  executeQueuedNode(input: ExecuteQueuedNodeInput): Promise<void>;
  enqueueReadyNodes(input: EnqueueReadyNodesInput): Promise<number>;
}
```

`executeQueuedNode` owns the node lifecycle:

```txt
queued -> running -> succeeded -> schedule downstream
queued -> running -> waiting
queued -> running -> failed
```

`enqueueReadyNodes` owns graph readiness:

```txt
pending + all dependencies terminal + edge condition satisfied -> queued
pending + all dependencies terminal + no edge condition satisfied -> skipped
```

## Execution semantics

### Dependency readiness

A node is ready when all inbound dependency nodes are terminal. In the first implementation, `succeeded` and `skipped` count as satisfiable terminal statuses. `failed` blocks by default unless a future `continueOnError` policy is added.

### Edge conditions

Multiple inbound edges are treated as OR for execution eligibility. If at least one unconditional edge or true conditional edge exists after dependencies are terminal, the node is queued.

### Start nodes

Nodes with no incoming edges are start nodes. They should be queued when a run is created.

### Waiting nodes

A node may return `{ status: "waiting" }`. Waiting nodes do not schedule downstream nodes until an explicit resume action transitions them back into execution.

### Failed nodes

A failed node should emit `node.failed`, update the run status, and leave downstream nodes pending unless recovery semantics are explicitly configured.

## Migration plan

### Phase 1: Introduce contracts

Add `core/types.ts` and `core/runtime.ts` with interfaces only. Keep existing worker behavior unchanged.

### Phase 2: Wrap existing infrastructure

Create adapters that delegate to existing persistence and queue modules:

```txt
adapters/postgres/execution-store.ts -> wraps persistence.ts
adapters/bullmq/queue-adapter.ts      -> wraps queue.ts
```

### Phase 3: Move scheduling into runtime

Extract current `enqueueNextNodes` behavior into `WorkflowRuntime.enqueueReadyNodes` and let `scheduler.ts` become a compatibility facade.

### Phase 4: Move worker orchestration into runtime

Make `worker.ts` call `runtime.executeQueuedNode(...)` instead of manually orchestrating status transitions.

### Phase 5: Add in-memory test adapter

Add an in-memory `ExecutionStore` and `QueueAdapter` to test graph semantics without Redis/Postgres.

## Non-goals for this branch

- Rewriting all node config schemas as discriminated unions.
- Replacing BullMQ.
- Replacing Drizzle/Postgres.
- Changing the public API contract.
- Implementing a plugin marketplace.

## Risk controls

- Keep compatibility exports during migration.
- Add tests around scheduler behavior before changing it deeply.
- Prefer small commits that preserve `pnpm test` and `pnpm build`.
