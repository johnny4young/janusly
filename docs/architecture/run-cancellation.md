# Run cancellation semantics

## Goal

Allow operators to stop a workflow run safely and prevent additional node execution.

## Run lifecycle addition

A run may transition to `cancelled` from any non-terminal state.

```txt
created/running/waiting -> cancelled
```

## Node behavior

When a run is cancelled:

- `pending` nodes become `cancelled`.
- `queued` nodes become `cancelled` from the database perspective.
- `waiting` nodes become `cancelled`.
- `running` nodes are best-effort: the current worker may continue until the node cooperatively checks cancellation or finishes, but no downstream nodes should be scheduled.
- terminal nodes remain unchanged.

## Runtime guard

Before executing a queued node, the runtime should check the run status. If the run is `cancelled`, the node should not execute.

After a node succeeds, the runtime should also check whether the run was cancelled before enqueueing downstream nodes.

## API

```http
POST /runs/cancel
Content-Type: application/json

{
  "runId": "..."
}
```

The endpoint requires `editor` permission and writes an audit event.

## UI

The Runs panel should expose a `Cancel run` action for the current run.

## Future work

- Cooperative cancellation signal passed into node executors.
- Hard cancellation of queue jobs in BullMQ.
- Cancellation reasons.
- Per-node cancellation events.
