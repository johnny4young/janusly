# Workflow deployments

Workflow versions may be assigned as baseline or canary candidates. Assignment
is deterministic and stored on each run and inbound event.

Automatic outcome handling uses terminal receipts and minimum sample gates.
Validation runs, recovery replay, and explicitly pinned subworkflows do not
consume canary traffic. Version writes and deployment updates use durable locks
so a run always records the exact evaluator and version pair used.

Rollback changes future assignment; it never rewrites existing run history.

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
