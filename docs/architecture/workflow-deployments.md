# Workflow deployments

Workflow versions may be assigned as baseline or canary candidates. Assignment
is deterministic and stored on each run and inbound event.

Automatic outcome handling uses terminal receipts and minimum sample gates.
Validation runs, recovery replay, and explicitly pinned subworkflows do not
consume canary traffic. Version writes and deployment updates use durable locks
so a run always records the exact evaluator and version pair used.

Rollback changes future assignment; it never rewrites existing run history.

While a rollout's canary is the latest saved version, these starts take the
assignment and record the rollout on the run, so its outcomes count toward
the guardrail:

- HTTP and MCP starts, keyed per start;
- webhook and trigger deliveries, keyed by the accepted event, which keeps its
  assignment when it is buffered and continued later;
- schedule ticks, keyed by the schedule entry and the tick's due time, so a
  retried tick lands on the same arm;
- subworkflow calls without a pinned version, keyed by the parent run and node.

Reruns, draft tests, validation runs, recovery replays and subworkflows pinned
to a version keep their exact version. No start falls back to the latest
version when its assignment fails:

- a failed read rejects an HTTP, MCP or webhook start and retries a schedule
  tick, which keeps its claim;
- an assigned version that cannot run (missing or no longer valid) drops a
  schedule tick with a `schedule.tick.dropped` audit row naming the rollout and
  version, and the entry moves to its next cron occurrence;
- an unpinned subworkflow call fails with an error naming the rollout and the
  version. Save a new version of the child, which ends the rollout's routing,
  or promote an active canary whose baseline is the broken version.

A promote or rollback decision does not wait for starts that are already
resolving their assignment: a start in flight at that moment can still take
the previous arm. The window is one start's resolution and applies equally to
HTTP starts and schedule ticks.

## Promotion

Saving a version makes it the latest, and the latest version takes production
traffic unless a rollout routes it. The Deployment panel and the workflow list
API (`productionVersion`, `rollout`) show that split. An active canary keeps
its baseline in production; a rolled-back or cancelled canary leaves the
baseline there until a newer version is saved; a promoted canary is
production.

Promote in the workflow's Deployment tools opens a dialog for the latest
version. It shows the version compare against the chosen baseline, the outcome
qualification for that pair, and the canary traffic, minimum sample and
success floor, then starts the same rollout as the API with the same
permission, audit, transition and qualification checks.

Janusly has one runtime and one credential set per organization: there is no
staging environment, and `{{env.NAME}}` reads the process environment, within
the operator allowlist, for every run. Per-environment variables or credentials would need an environment bound
to each run at start and server-side resolution of references by that
environment.

## Pause and resume

`workflows.status` is `active` or one of three pauses:

- `paused_manual`: a person (`POST /workflows/{id}/pause`) or an agent
  (`workflows.pause`) asked for it;
- `paused_circuit_breaker`: tripped by consecutive failures;
- `paused_upstream_degraded`: set and cleared by the upstream status poller.

While paused, starts are refused with a 409 (`workflow_paused`,
`workflow_circuit_breaker_paused` or `upstream_degraded`) and a production
subworkflow call fails its step instead of starting the child. Schedule ticks
are dropped and audited, inbound trigger events are buffered, a replay
campaign waits at the paused workflow's first item, and runs already in
progress continue. Draft tests keep the start gates and are refused too. A pause never touches versions, schedule entries or an
active rollout, which only an explicit rollout decision finishes.

A manual pause replaces a system pause, and each automatic resume only
matches its own status, so no automatic resume lifts a manual pause.
`POST /workflows/{id}/resume` (`workflows.resume`) lifts manual and breaker
pauses, then starts the buffered events oldest first in pages of 50. An
upstream pause is refused with a 409 `upstream_degraded` because it clears
itself; resuming a manual pause while a subscribed upstream is degraded hands
the workflow to that upstream pause instead. Pause reasons are one line of at
most 500 characters with secret-shaped literals removed.
Moving a workflow to the trash (`workflows.deactivate`) is a different
operation: it cancels the active rollout and removes the schedule entries.
