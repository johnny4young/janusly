# Workflow Deployments

> Operational deep-dive for progressive baseline/canary delivery. Keep the
> summary in `AGENTS.md` synchronized with these invariants.

## Durable model

`workflow_rollouts` binds one immutable baseline version to the newest saved
canary version. A partial unique index permits at most one `active` rollout per
organization/workflow. Configuration is deliberately bounded: 1–50% canary
traffic, a 5–100 canary-run minimum sample, and a 1–100% minimum success rate.
External trigger node ids, types, and configurations must be semantically
identical across both versions so either assignment can safely receive the
same event.

Assignment is a deterministic SHA-256 bucket of `(rolloutId, assignmentKey)`.
The chosen rollout id, variant, and workflow version are persisted on the run;
they are never recomputed by node retries. Production entrypoints use stable
keys appropriate to their lifecycle:

- `POST /start` mints one key for the requested production run.
- Inbound trigger ingestion mints the trigger-event id before allocation and
  persists the exact version/variant on `trigger_events` before starting work.
- BullMQ schedule deliveries use the stable delivery job id; their original
  job timestamp is retained across retries.
- Unpinned production subworkflows use the parent run/node pair. Explicit
  version pins and validation runs bypass rollout allocation.

Trigger relay retries and buffered-event backfill load the exact persisted
version and assignment. Operator-triggered event replay intentionally starts
from current deployment state instead. Validation runs, run replays, node
retries, and explicit subworkflow pins never consume canary traffic.

## Lifecycle and guardrails

An active rollout blocks workflow save and version rollback. Rollout creation,
save, and rollback all lock the same parent workflow row before inspecting
deployment/version state, so concurrent replicas cannot append a version under
live split traffic. Soft deletion atomically tombstones the workflow and
cancels active deployment control while preserving rollout history.

When either immutable rollout version carries `RecoveryContractV2`, creation
also requires a passing pre-deployment outcome qualification for the exact
baseline/candidate pair and current evaluator dataset version. V1→V2 uses a
bootstrap comparison against the candidate fixtures; V2→V2 additionally
replays the candidate detector against the baseline fixture snapshot; V2→V1
fails because it removes semantic protection. The pure comparator executes no
workflow nodes or effects. Its bounded receipt is durable in
`workflow_recovery_qualifications`, but the rollout transaction remains the
authorization boundary and rejects absent or stale evidence.

Every terminal production run contributes at most one
`workflow_rollout_outcomes` receipt. Success/failure counters update in the
same transaction. Cancelled runs retain a receipt but do not bias success
rates. Once the canary reaches its configured minimum sample, a success rate
below the threshold atomically returns traffic to baseline and writes
`workflow.rollout.auto_rolled_back` evidence. A once-per-minute bounded
reconciler retries terminal runs whose immediate observer missed its receipt;
the run-id primary key keeps concurrent repair idempotent.

Manual promotion sends all traffic to the canary. Manual or automatic rollback
sends all traffic to the baseline. The decision remains authoritative while
the canary is still the newest saved version. After a finished rollout permits
a newer version to be saved, ordinary latest-version semantics resume and a
new baseline/canary pair can be created.

## Control plane and UI

The read-only `GET /workflows/:id/rollout` requires `workflows.read`. Creating
or deciding a rollout requires both admin rank and `workflows.write`:

- `GET /workflows/:id/rollout/qualification`
- `POST /workflows/:id/rollout/qualification`
- `POST /workflows/:id/rollout`
- `POST /workflows/:id/rollout/:rolloutId/promote`
- `POST /workflows/:id/rollout/:rolloutId/rollback`

The Inspector's `WorkflowRolloutPanel` lists immutable versions, bounds every
input to the server contract, requires and explains outcome-dataset evidence,
shows baseline/canary outcome counts, and uses accessible confirmations for
promotion and rollback. The server remains the authority for eligibility,
authorization, assignment, and guardrail decisions.

## Do not break

- Never allocate from mutable latest state after an inbound event is accepted.
- Never derive tenant scope or version authority from a queue/webhook payload.
- Never count validation/replay outcomes toward rollout health.
- Never update counters without the run-id receipt in the same transaction.
- Never allow a version write while the active rollout owns deployment state.
- Never accept a semantic qualification from another version pair or evaluator
  dataset version.
- Never execute workflow nodes, providers, or effects during deterministic
  outcome qualification.
- Never remove the maintenance repair path because the immediate terminal
  observer is intentionally best-effort and must not unwind a committed run.
