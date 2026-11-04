# Changelog

## Unreleased

- Activity shows its sections as tabs: Runs, Recover with the number of open
  failures, Agent activity and Reports.
- Reports shows recovery trends for the last 7, 30 or 90 days: recovery KPIs,
  the activity heatmap, failure clusters, model calibration, AI spend, and
  Recovery validation and the Value dashboard with Markdown and JSON exports.
- Build opens with the sidebar collapsed to a rail for more canvas; the flow
  name and version move to the top bar.

- Canvas connections drop the repeated "default" label; named branches show a
  pill on the connection.

- A failed step on the run snapshot keeps its full title, shows its error in
  one line, and links to its item in the recovery queue.

- Run events opens on the latest failed run, with a run picker, and the
  breadcrumb reads Activity › Run events.

- Empty states end in a primary button instead of text that reads as a label.
- The Settings breadcrumb names the open pane, such as Settings › Access, and
  the pane follows its link: pasting a link, Back and Forward now change what
  is on screen.
- Find a setting cards show live status, such as 0 alert policies · 1 failure
  pattern. Attention dots in the Settings rail explain their reason on hover
  and to screen readers.
- The Home health score lists what drives it: success rate, open failures and
  longest downtime, each linking to where to act.

- Revoking a connection lists the workflows that use it and, when there are
  any, requires typing the connection name. If the list cannot be loaded, the
  dialog says so and still requires the typed name. A revoked connection now
  leaves the inventory without a reload.
- Rotate secret no longer crashes the Connections panel when a workflow uses
  the connection; its preview lists those workflows by name.
- The pending setup step is a row in What needs you with its progress, not a
  separate card repeating the next action.

- Solution pack buttons keep a readable label. Under Install, a pack now names
  the credentials to connect before running it, or says that your role can't
  install or run packs.
- AI Studio has a smaller header and a horizontal 1-2-3-4 stepper that marks the
  current step.
- The Tools catalog fits one screen: tools are grouped by namespace in a
  three-column grid, filterable by Read-only, May change external systems and
  Installed. Install state now survives a reload, and a tool's description and
  Install action open from its row.
- Each view has one header row with its section title and tabs; descriptions
  moved to a tooltip on the title, so content starts about 110 px higher.
- Headings that receive focus for screen readers no longer show a focus ring
  when a page opens.

- The language selector in the account menu is a compact row like Theme and
  Density, and the canvas zoom controls follow the dark theme.
- Buttons keep their icon and label on one row across the product.
- The Workflows list is a table with labelled Name, Status, Open failures,
  Health, Last run and Version columns. Open failures counts the flow's open
  dead letters, the run count moves under Last run, Health shows the change
  since the current version once enough runs exist, and header sorting replaces
  the Recent / Name / Failed first switch. Clicking the health score now opens
  its breakdown without leaving the list. `GET /v1/workflows` rows add
  `openFailureCount`, `lastRunAt` and `currentVersion`.
- Recovery failures open with a one-line cause such as "Host
  demo-ingest.invalid does not resolve", a cause chip and whether a retry can
  help; the raw error JSON stays collapsed below. DNS and connection errors from
  the Go runtime now cluster under Network instead of Other, and DNS failures
  get their own "DNS lookup failed" signature.

- Workflow generation audits retain bounded first-draft issue codes even when
  a repair succeeds, without storing model drafts or prompts.

- Local and hosted acceptance now share the frontend vulnerability audit;
  `make verify` uses a fresh, isolated PostgreSQL 18 project, applies the
  baseline twice, and cleans only resources it owns.
- `/healthz` remains process liveness while `/readyz` performs an opaque,
  bounded database readiness check suitable for routing and Railway
  healthchecks.
- Operator CLI traffic uses one bounded fixed-origin client with same-origin
  redirects, response limits, strict JSON, encoded paths, and explicit token
  precedence.
- Private metrics can be qualified across the same isolated network boundary
  required by a separate Alloy collector without publishing the privileged
  listener or contacting Grafana Cloud.
- Container, PostgreSQL, observability, and optional provider images are pinned
  by digest; CI Actions are pinned by commit. `make supply-chain` produces
  checksummed BuildKit provenance metadata, a saved image, and an SPDX 2.3 SBOM
  using digest-pinned generators. The evidence remains unsigned and local.

- Contextual authoring prefills release obsolete compilation/proposal loading
  and restore input focus without interrupting an in-flight Apply.

## New baseline — 2026-08-03

- Janusly is now a root-level Go module with a standalone React frontend in
  `/web`.
- Production ships one `janusly` executable that serves React, the public API,
  workflow execution, and maintenance loops.
- PostgreSQL 18 is the only supported database version. New installations use
  one fresh baseline migration and cannot upgrade databases from other schema
  generations.
- Runtime configuration uses `JANUSLY_*` names, with `JANUSLY_ENV=production`
  as the single production gate.
- Docker Compose contains Janusly, PostgreSQL 18, and optional Ollama services.
- CI validates frontend, backend, PostgreSQL 18 integration, the single-runtime
  browser journey, and provenance-bearing artifacts.
