# Run model

A run binds one organization, workflow snapshot, workflow version, resolved
input, creation actor, and execution mode. Tasks move through durable queued,
running, waiting, and terminal states.

Workers claim eligible tasks with bounded concurrency. Claims carry generation
identity; completion uses compare-and-set predicates. Downstream work becomes
eligible only after the upstream terminal write commits.

Eligible tasks are claimed oldest-first by the durable `run_nodes.enqueued_at`
clock, with the stable row ID used only to break timestamp ties. Every
transition into `queued` refreshes that clock; a retry writes its future
wake-up instant, so the clock always means **eligible since** rather than
merely **row entered queued**. A partial index over
`(enqueued_at, id)` contains only queued rows, so claim cost follows live queue
depth rather than accumulated terminal history. The claim still checks the
wake-up row as defense in depth, but queue health and wait latency remain
correct after the due wake-up row is cleaned up.
Janusly does not currently expose priority or named-lane policy: adding either
requires an operator-facing service contract and load evidence first.

PostgreSQL notifications wake workers and SSE readers. Polling and table state
remain authoritative after missed notifications or process restarts.

## Snapshot compatibility

A persisted workflow version pins the workflow document, not the executable
that will interpret it. Janusly does not route pending work to an older runtime
version. A changed executor can change behavior even when the DSL version stays
the same; qualify waiting runs and their evidence before adopting such a change.

A snapshot is invalid when it does not parse, declares an unsupported DSL
version, or contains a node type this executable cannot run. A claimed node or
a due `wait_until` timer with an invalid snapshot fails durably with a dead
letter, without dispatching an effect or scheduling downstream work. Manual
resume rejects an invalid snapshot with a conflict and leaves the waiting
checkpoint, deadline, events, and downstream readiness unchanged. These are
rejection guarantees for the current executable, not proof of compatibility
between two executable versions.

## Edge eligibility

Edges gate downstream eligibility. A conditional edge skips its target when
the expression is falsy. An on-error edge inverts the gate: it fires only when
its source node fails terminally. A failure with at least one on-error route
is handled — the run continues down the error branch, the success branch is
skipped as not taken, and no dead letter or recovery case is produced. A
failure without an on-error route fails the run and dead-letters, unchanged.

## Agent authority

Agent planning is not an authorization boundary. The dispatcher computes one
per-node write grant from process policy, tenant consent, workflow opt-in, run
mode, and graph-dominating human approval. That grant and the node's exact
literal HTTP target set travel to the executor; the executor rejects a planned
write or a different/dynamic URL even if a provider emits it. Dry-run and
validation modes always suppress writes.

One authorized `agent` node execution owns a single write-attempt lease. A
`multi_agent` crew shares that same lease across every sequential or parallel
child; it does not receive one mutation per child or per `maxSteps`. The lease
is consumed immediately before dispatch and remains spent after validation,
timeout, or an ambiguous transport result. Deterministic planners stop after
the attempt; an AI planner may use remaining steps only for read-side
verification. Another mutation requires a new approved run.

Approval ancestry means dominance, not mere reachability: every path that can
enter a write-enabled agent must cross an approval. Alternate unapproved paths,
missing predecessors, and malformed cycles fail closed. Explicit `http`,
`tool`, and `mcp_tool` nodes remain the preferred representation when the
mutation is known during authoring because their effect, inputs, retries, and
approval topology stay directly inspectable.

## Tool approval

The org setting `tools.approvalRequired` lists tool names whose every call
waits for a person. Admins change it with `org.config.write`: the tool
inspector adds or removes one tool through `POST /org/tool-approval-policy`,
which edits the list under a per-org lock so two admins never drop each
other's entries, and `POST /org/config` sets the whole list. Both are audited.
The setting accepts only names the gate can enforce: the built-in tools,
including `http.request`. Any other name, such as an MCP tool, is refused with
`tool_approval_unenforceable`.

The dispatcher reads the policy for `tool`, `http`, `loop`, `agent` and
`multi_agent` steps and fails closed when it is unreadable or malformed. It
matches the tool name rendered for the call (an `http` step is
`http.request`), so the step id, a decoy step, a replayed fix or a rerun
override cannot move a listed call out of the gate. A listed tool runs only as
an approved `tool` or `http` step. A `for_each` loop or an agent that reaches
it, including an agent's `http.request`, gets a `TOOL_APPROVAL_REQUIRED`
refusal. System deliveries go through `Engine.ExecuteIntegrationTool`, which
refuses a listed tool because nobody approves them: report delivery answers
409 `tool_approval_required`, and listing `email.send` stops the weekly digest.
Validation runs and draft tests keep suppressing writes as before, so the gate
waits only for listed calls that would really run there, which are reads.

Once a step has a live request, that request decides it whatever the policy
says later. Removing the tool from the list does not run a denied or expired
call, and an undecided request keeps waiting until it expires.

A tool step whose call is listed pauses before the executor runs, under the
run's completion lock. The request records:

- the tool;
- its parameters with resolved secrets and sensitive keys masked, plus the
  paths of the masked values (at most 64 KB, or the step fails);
- an HMAC digest of the full rendered call that also covers the id, kind,
  reference and revision of a named `credential`. The digest is computed under
  the lock, and the integration refuses a credential whose revision changed
  after the approval was spent;
- the requesters, who are the people who caused this call. `run_actors` records
  them by role:
  - anywhere in the run tree (the lineage up through subworkflow and rerun
    links, plus every subworkflow descendant): form submitters and resumes
    with input (`resume`), a redrive that replaced the document (`fix`), a
    person who created or applied a semantic output replacement (`output`),
    and a service-token starter (`service`);
  - in this run and the runs above it: a plain redrive (`redrive`), whose
    re-run steps can feed this call;
  - the creators up the lineage, and everyone an earlier request for the same
    step excluded;
  - whoever saved the versions the lineage runs, when no person started it (a
    `system:*` creator, a schedule or webhook trigger, or a service token), so
    the author of the parameters cannot approve them.

  A service token's user id is a free-form header, so its actions are recorded
  as `service-token:<suffix>`;
- how many members can approve: members who can start runs and are not
  requesters. When none can, the card says so.

The node then waits with `kind: "tool_approval"` and a 30-minute decision
deadline (`tool_approval_timeout` wake-up).

`POST /runs/tool-approvals/decide` takes the approval id, the digest the person
reviewed and `approve` or `deny`. It:

- needs `runs.start` and refuses service tokens;
- refuses the requesters, also with a database check;
- refuses a stale digest or a request past its decision deadline;
- serializes concurrent approvers on the run lock, so the first decision wins;
  repeating your own decision is a no-op.

A decision requeues the step, and the next claim spends it exactly once. An
approval may be spent up to 30 minutes after it was given, even past the
decision deadline, so a busy queue does not fail a timely approval. It runs only
when the freshly rendered call has the approved digest. A deny, an expiry or a
changed digest fails the step with a `ToolApprovalError` that never retries.

Any later claim of the step asks again: a retry, a redrive, a replay, or a
restart that reaches the gate. A retry or redrive also gives up an approval
nobody spent. Every redrive path records its operator: the HTTP user, the MCP
principal, or the user who started a replay campaign. The generic resume route
cannot complete a tool approval.

## Retry policy

`config.retry` uses one closed grammar at authoring and execution. A present
policy requires `maxAttempts` (the first execution counts as attempt one), with
a range of 1–10. Initial delay is limited to 1–600,000 ms, an authored maximum
to 1–3,600,000 ms, and the scheduler applies the one-hour ceiling even when the
author omits `maxDelayMs`. Backoff is fixed or exponential; jitter is boolean;
retry/ignore matcher lists are bounded. Invalid legacy policy data fails closed
to no retry rather than being partially interpreted.

`retryOn` and `ignoreOn` match labels derived from the failure: its name, its
code, the exact HTTP status, the status family (`5xx`), and two synthetic labels.
`network` covers resolver and connection failures, in Go wording (`connection
refused`, `no such host`, a transport `EOF`) or as Node codes (`ECONNRESET`,
`ENOTFOUND`). `timeout` covers timeout wording, `deadline exceeded`, and timeout
codes. A dial that times out carries both. An error with an HTTP status never
gets `network` from its message, because the peer answered. `internal/signature`
owns the wording, so retries and failure clusters read a failure the same way.

A failure marked `writeSide` never retries the whole node, whatever the policy
says: external effects may already have happened, so replay stays with an
operator. `http` marks non-safe methods once the request is dispatched, `tool`
marks write-side tools under `require_ok`, `loop` marks write-side `for_each`
failures, and `mcp_tool` marks every failure of a write-side descriptor. That
includes failures before the call is sent, such as the local rate limit. An
`agent` or `multi_agent` node observes tool failures as results and does not
raise them.

When a run flips to `failed`, its still-queued siblings go back to `pending`
in the same transaction: a failed run can never claim again, and queued rows
would otherwise sit at the head of the FIFO claim index forever, rejected by
the running-run join on every claim. A redrive re-queues them through the
ordinary readiness pass; cancellation marks its own nodes cancelled.

## Rerun from a step

`POST /runs/rerun` starts a new production run from one step of a finished run,
linked to it by `parent_link_kind = 'rerun'`, which is trace-only like a replay.
Only that step is queued, so only it and its downstream closure can execute.
The selected step must have succeeded, failed or been cancelled, and no source
step may still be running or waiting on a child run. A subworkflow child cannot
be rerun, because its writes rest on its parent's approvals and input.

Readiness accepts a skipped predecessor, so every step upstream of the closure
must have succeeded with a saved output and is cloned with zero attempts. A branch
the source did not take stays skipped. Anything else upstream refuses the rerun.
A step with no path into the closure is cloned if it succeeded, otherwise skipped.

`POST /runs/rerun/preview` returns the step's config with sensitive keys masked
and the reused, rerun, not-run and side-effect steps. Side effects are classified
from the document that will run, with static tool capability metadata, treating a
subworkflow or unknown tool as effectful, and the start must acknowledge them, so
an edit that adds a write returns 409 with the new list. Only agents check
approval at dispatch, so a side effect with an approval or human form upstream
that is not in the closure refuses the rerun until it starts at that step: one
person's answer covers one execution, and an override could change what they
reviewed. A reused subworkflow upstream of a side effect refuses the same way
when its child run, or any run below it, has an approval or human form that was
not skipped. The child is found through the step's saved `childRunId`, which a
rerun clones, and a child that cannot be identified or read, or a tree past 100
child runs, counts as decided. A webhook, timer or subworkflow without such a
step stays reusable. A webhook is usually the run's trigger, whose payload nobody
would send again.

`inputOverride` replaces the step's authored config in a copy of the run's
snapshot. Rendered per-node input is not persisted, because it can hold resolved
secrets, so operators edit references rather than values. A masked value keeps
the authored one, unless it sits in an array whose length or element changed,
because masks restore by position. Sensitive keys accept only references, with an
optional `Bearer`, `Basic` or `Token` scheme, and values that are not text. An
override cannot enable `allowWriteTools`. The copy then passes `runstart`, the
same admission as any start, with no rollout reassignment. An edited document is
unbound from its version, so saved-only tenants refuse it. An `Idempotency-Key`
is bound to the source, step and override, so an edited resubmit starts its own
run. Validation runs cannot be rerun, which keeps a sandbox from becoming
production. The audit row records whether the input was edited, never its values.

Replays of a step are checked across the whole rerun lineage, siblings included,
because no provider idempotency key would stop a write repeating. A replay returns
a conflict if a later run in the lineage ran or will run the step, or if any other
run in it completed the step. A step no other run executed stays replayable, and
so does the newest failed attempt. A superseded dead letter stays open until an
operator closes it. A rerun start and a redrive of the same run serialize on its
completion lock, where the start also refuses if the selected step's row moved
since planning. A source with a live subworkflow child cannot be rerun.

A rerun itself cannot pause production: it neither counts in the circuit breaker's
failure streak nor resets it, and its failure does not evaluate the breaker,
because it is an operator-initiated attempt. A subworkflow child started by a rerun
is an ordinary child run and counts as usual for its own workflow. Only those runs,
production runs and redrives of them move a streak.

## Draft test runs

`POST /runs/draft-test` runs the editor's draft of a saved workflow as a
validation run with no version, so every executor gate suppresses writes, and
reports, recovery and the circuit breaker ignore it like any sandbox run. Its
evidence level is `writes_skipped`, which no playbook or recovery check accepts.
It enters through `runstart` like any start, so validation, production
readiness, the breaker pause, the saved-only policy and the start rate limit all
apply; it only skips rollout assignment and never claims a version. An
`Idempotency-Key` is bound to the request, so a double submit starts one run.
No run with a replay mode updates routing rewards, and redriving one of its dead
letters opens no recovery item and sends no alert.

The request may give a step a stand-in output: `sourceRunId` copies that step's
saved output from a production run of the same workflow in the organization, and
`mock` takes a JSON value. The document is validated first, and pinned outputs
and mocks together are capped at 256 KiB. Both are masked by sensitive key before they are stored in
the run's `input_json.draftTest`, never in the workflow document. The worker
completes a step with a stand-in without calling its executor, and only when the
run's `replay_mode` is `validation`, so the same envelope on a production run is
ignored. Approvals, human forms and routers cannot take one. `stepNodeId` runs that step and its
ancestors and starts every other step skipped. The audit row names the steps with
stand-ins, never their values.

Wake-ups carry a count: `janusly_wake` notifications and the wake sweeper
say how many nodes just became claimable, and that many workers wake,
rotating through the pool. Waking one worker left a fan-out waiting on the
poll fallback; waking every worker made each start open a claim
transaction per worker. The claim itself is a semi-join over the FIFO
partial index, so a grown `runs` table cannot steer the planner into
walking running runs first.

Outcome transactions (complete, fail, retry, waiting) are compare-and-swap
guarded, so a worker replays one that a lock wait cancelled, a deadlock or
serialization decision lost, or a dropped connection interrupted — up to six
attempts over roughly eight seconds, each counted in
`janusly_outcome_persist_retries_total{op}`. A permanent error still leaves
the node `running` for the stalled-node reaper; a transient one no longer
does.
