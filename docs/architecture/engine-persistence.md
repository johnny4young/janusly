# Engine Persistence Architecture

Janusly keeps workflow lifecycle state in PostgreSQL through bounded persistence
ports. The split is an internal maintainability boundary: it must not change
SQL predicates, transaction boundaries, compare-and-set semantics, persisted
payloads, live-event ordering, or the imports used by existing consumers.

## Sources of truth

- `packages/engine/src/persistence.ts` — stable compatibility barrel used by
  runtime adapters, workers, API recovery paths, and existing test doubles.
- `packages/engine/src/persistence-ports/run.ts` — run reads, cancellation, replay
  claims, subworkflow handoff, terminal rollup, and run-context projection.
- `packages/engine/src/persistence-ports/node.ts` — execution-generation claims,
  waiting checkpoints, retries, and ordinary node terminal transitions.
- `packages/engine/src/persistence-ports/event.ts` — append-only run-event persistence
  and best-effort live publication of the same redacted payload.
- `packages/engine/src/persistence-ports/publication.ts` — PostgreSQL-to-BullMQ node
  publication, overdue waiting-checkpoint repair, and terminal child-to-parent
  delivery claims and leases.
- `packages/engine/src/persistence-ports/recovery.ts` — atomic semantic-outcome
  detection, containment, operator resolution, and recovery impact writes.
- `packages/engine/src/persistence-ports/internal.ts` — shared payload bounds and pure
  projections used only by the lifecycle ports.
- `packages/engine/src/persistence-modules.test.ts` — compatibility export,
  closed-inventory, and acyclic dependency contract.

The internal directory deliberately uses the `persistence-ports` name rather
than `persistence`: Node ESM deep imports such as
`@janusly/engine/src/persistence` must resolve the compatibility file, never an
extensionless directory entry. Consumers may continue importing
`packages/engine/src/persistence.ts`. New engine code should import the narrow
lifecycle port when doing so does not break an established test or adapter
seam. No port imports the compatibility barrel.

## Dependency direction

The allowed internal imports are closed and enforced by the architecture test:

- `event` and `internal` have no persistence-port dependencies;
- `publication` depends only on `internal`;
- `run` depends on `event`, `internal`, and `publication`;
- `recovery` depends only on `internal`;
- `node` depends on `internal`, `publication`, `recovery`, and `run`.

`run` may append events and acknowledge parent publication; `recovery` uses
only shared internals; `node` may delegate semantic completion to `recovery`
and terminal notification to `run`. `run` must not import `node`, and no cycle
is allowed.

The subworkflow notifier registration remains in `run.ts` because it is the
cycle-breaking seam between terminal run persistence and executable
subworkflow orchestration.

## Invariants by port

### Run

- Cancellation updates the run and cancellable nodes before publishing the
  terminal notification.
- Replay claims update the authoritative workflow snapshot and exact failed
  node generation in one transaction.
- Terminal rollup preserves the conditional status flip, declared-output
  projection, append-only event, rollout receipt, and parent notification
  sequence.
- Run and node reads remain scoped by `runId`; tenant authorization stays at
  the caller boundary.

### Node

- `claimNodeForExecution` serializes against the parent run and validates the
  exact attempt, recovery token, and publication generation.
- Waiting, retry, success, and failure transitions keep their existing
  compare-and-set predicates.
- Recovery impact is written in the same transaction as the generation-bound
  successful completion that earns it.

### Event

- `appendEvent` redacts once, persists first, and publishes that same object.
  Live delivery is a best-effort side channel; PostgreSQL remains truth.

### Publication

- `tryClaimNodeForQueue` is the only `pending -> queued` multi-worker claim.
- Queue and parent-notification leases use bounded batches and exact generation
  acknowledgement. A Redis or process failure leaves durable repair intent.
- Waiting-checkpoint repair never advances a node; it only recreates the
  delayed delivery whose node-generation CAS remains authoritative.

### Recovery

- Semantic node completion, case creation, transition receipts, quarantine,
  and impact attribution remain atomic.
- Operator resolution rechecks current case/run state and publishes live
  evidence only after the transaction commits.

## Changing persistence

1. Change the owning lifecycle port, not the compatibility barrel.
2. Preserve every SQL predicate and transaction boundary unless the behavior
   change has its own architecture decision and PostgreSQL integration test.
3. Export public helpers through `persistence.ts`; do not create a sibling
   `persistence/` directory and do not deep-import
   `internal.ts` outside the `persistence-ports` directory.
4. Extend `persistence-modules.test.ts` when adding or moving a public helper.
5. Run the engine unit suite, PostgreSQL integration suite, workspace lint,
   typecheck, build, and tests before committing.

A pure module refactor creates no database migration and changes no public API
or event payload.
