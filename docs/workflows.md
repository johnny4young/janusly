# Workflows

A workflow is a versioned directed acyclic graph with declared inputs, task
nodes, edges, and optional outputs. `internal/domain` validates the graph and
`internal/engine` executes durable run state in PostgreSQL 18.

## Lifecycle

1. Save a workflow version through `/workflows/save`.
2. Inspect readiness through `/workflows/readiness`.
3. Start through `/v1/start`, a trigger, or a schedule.
4. Observe `/v1/run` and `/runs/:id/stream`.
5. Resume explicit waits through `/resume`.
6. Recover failed tasks through the recovery surfaces.

`JANUSLY_ENV=production` adds deterministic readiness enforcement before run
creation. A run always records the resolved input, selected workflow version,
and deployment assignment.

## Inputs and templates

Declared inputs may define typed defaults. Defaults are applied before
validation and persisted with the run. A provided value wins, including
`null` or `false` when permitted.

Templates use `{{context.input.name}}` for run input and
`{{context.<task>.output...}}` for earlier task results. Strict template policy
turns unresolved paths into failures; the default records bounded evidence and
uses an empty value.

## Deletion and retention

Workflow deletion is soft. Deleted workflows cannot be started or changed, but
versions remain inspectable and restorable until the retention sweep removes
them. Run, audit, and recovery evidence remains organization-scoped.
