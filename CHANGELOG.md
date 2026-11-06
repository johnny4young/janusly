# Changelog

## Unreleased

- Admins can make a tool require approval in every workflow (Require approval
  for this tool in every workflow, in the tool inspector). Each call of that
  tool pauses right before it runs, and the paused step shows the tool, its
  exact parameters with secrets masked and where masked values sit, and the
  policy. Approve runs exactly those parameters once; Deny, or no decision
  within 30 minutes, fails the step so it takes its error route. The person who
  started the run, anyone who submitted a form or redrove the step, and, for
  scheduled and webhook runs, whoever saved the workflow cannot decide. The card
  says when nobody else can. HTTP request steps follow the same rule, and a
  listed tool cannot run inside a loop or an agent.
- Building a proposal with a registered example no longer drops the Reuse or
  Adapt review when the database is slow to write to disk, and Apply no longer
  rejects a reviewed copy for the same reason.
- Failures in What needs you on Home have an Investigate action. It opens a side
  panel that checks four causes for the failed step, network, credential,
  upstream status and a version change, and marks each one Validated, Ruled out
  or Inconclusive with the run it is based on. A cause the stored data cannot
  settle stays Inconclusive. Steps lists the checks in order and Tree shows them
  under the question. When a cause is validated and your role can use recovery,
  Fix in Recover opens the failure in the Recover queue. The checks follow fixed
  rules and work without an AI provider.
- A recovery case's history lists its steps in the order they happened, even
  when two land in the same millisecond.
- The experiment comparison lists metrics by row, with either arm as the
  baseline. Each change says Better or Worse according to whether higher or
  lower is better for that metric. Diff only hides metrics that did not change.
  A notice appears when control and candidate finished a different number of
  examples, and the metrics that then get no verdict are named. Score and latency
  get no verdict when the LLM judge fell back, and score changes under the 5-point
  noise floor get none either. Changes are taken between the values shown, and a
  cost the run did not measure stays Unknown and gets no change.
- The step Inspector has a Test data section that shows the output of the step
  and of every step before it from the open run. Pin a step's output or type a
  mock, then Run this step or Test draft: those steps return the pinned or mocked
  value instead of running, so earlier AI and tool calls are not repeated. Test
  runs never change external systems, never publish a version and do not count
  in reports, recovery or the circuit breaker. The run is marked Test data and
  the canvas marks pinned and mocked steps. Pins come from production runs only,
  stay in this browser tab and workspace, and approvals, forms and routers cannot
  be pinned or mocked.
- Saved step outputs, run events and model-facing copies now also mask values
  under API, access, refresh and ID token fields, `X-Auth-Token`, `Set-Cookie`,
  `Proxy-Authorization`, `credentials`, `passwd` and API secret fields.
- Sandbox and test runs no longer change the success rates routers learn from,
  and redriving one of their failures no longer opens a recovery item or alert.
- Experiments now start from the dataset. Run a comparison has three steps,
  Dataset, Control vs candidate, and Scorer and run, and the dataset form lives
  in the first step. A disabled Run comparison names the missing step and field,
  and selecting that message takes you there. Roles that can only read are told
  so and no longer see the dataset form. Names and references over the API's
  byte limits are flagged where you type them, and a dataset deleted before a
  run reloads the list.
- Login has Forgot password?, which emails a reset link that ends at the
  set-password step. The answer is the same whether or not the email has an
  account, including when the auth server limits how often it sends.
- Settings > Usage now reports input served from cache as a share of all input
  tokens. It used to divide by uncached input only, so it could read 100 % when
  half the input came from cache.
- Recover has a Recovery jobs view beside the queue. Name a paced replay after
  the incident; before it starts you see how many failures and runs it touches,
  the failed steps and later steps that may change external systems, and the
  estimated time. Each job shows live progress and how many replays started,
  could not start or were cancelled, with Abort while it runs and View runs to
  open any run it touched. A started replay is not yet a recovered run, so check
  the runs for their outcome. Janusly shows a notice when a job you have seen
  running ends, even after you leave Recover. These jobs moved here from
  Automation and patterns.
- Solution packs show a Before installing checklist with each required credential,
  its state and how many are ready. Connect opens the new connection dialog with
  the name and kind filled in, and the row turns ready without leaving the page.
  A credential that has expired, has no secret set on the server or is held under
  another kind says so and offers Review, which opens Connections. Install becomes
  the primary action once every credential is ready, and it still installs a draft
  before then.
- Failed actions that go through the platform's shared error toast now show the
  message in your language when one exists, instead of the server's English.
- The AI budget in Settings now meters this month's spend against the limit,
  with the warning threshold marked on the bar. An Off / Limit switch replaces
  entering 0 to turn the budget off. A limit must be at least $0.01 and a warning
  threshold at least 1%. Workflow overrides are table rows with their limit,
  warning, policy and spend, edited in place, and can be set back to the Org-wide
  budget.
- Reports has an Estimated AI cost section for the selected window: the most
  expensive steps and the cost by model, with uncached, cached and output tokens.
  A step opens its run and a model lists its steps. With no usage it says why;
  failed or simulated calls show no cost instead of $0, and simulated calls add no
  tokens. Totals cover the whole window; when a busy window has more calls than the
  steps list reads, the section says how far back the steps reach. Settings > Usage
  links to it, labels its dollars as estimated, and no longer shows "no usage" while
  its read is loading or after it failed.
- Permission grants is one matrix with permissions in rows and roles in
  columns, a filter, and one Save for every edited role. Cells that differ from
  the built-in default are tinted. If only some roles save, the panel says which
  failed and keeps their edits to retry. Switching workspace during a save stops
  it, so grants never land in the other workspace, and the panel reports which
  roles saved.
- A custom role named `constructor` or `__proto__` no longer crashes the
  permissions panel.
- Revert to defaults now appears on built-in roles that have saved changes.
- Rerun a run from any step that ran, from the Timeline tab. Earlier steps reuse
  their saved outputs, so nothing before the step repeats. The step's input is
  edited beside the original, the steps with side effects are listed before you
  confirm, and the run sheet links the new run to its source run. A step behind
  an approval reruns from that approval when anything after it can write.
- Suggest fix now opens with the failed step, the attempts and whether AI is
  connected. Without an API key it says so and leads with Replay in Lab; Review
  evidence still shows the deterministic evidence, with no patch. Once a
  suggestion is under way, the dialog shows Patch, Validate and Apply, and marks
  Validate done only after a sandbox run passes.
- Build can compare versions on the canvas. In Versions, pick two versions and
  choose Open on canvas, or use Compare draft to check unsaved edits against the
  version they started from, including when only one version is saved. Steps and
  paths are marked new, modified or deleted, a counter steps through each change,
  and each one shows its before and after JSON with secrets masked.
- Run detail is one sheet. Its header shows the workflow, the actions and a data
  row with status, duration, start, version, trace and run ID, and it stays in
  place across the tabs Overview, Timeline, Events, Agents and Ask. Timeline now
  groups this run's attempts by step on one time scale and marks retries; the
  event list moved to Events, and the conversation with Janusly to Ask, where it
  survives a look at another tab. View timeline is gone in favor of the tabs,
  Cancel run only appears while a run can still stop, and a Close button returns
  to the activity feed.
- Recover is now a list and a detail side by side. Filters stay above the queue,
  the failures sit on the left and the selected failure on the right, each pane
  scrolling on its own, so moving with J/K keeps both on screen and the action
  bar in view. Actions are grouped: Suggest fix, Retry and Replay in Lab; Copy
  error and Export; Close without recovery.
- The recovery queue groups failures by cluster by default, with a switch to All
  items. Each cluster shows its signature, category, occurrences and affected
  workflows, plus Investigate, which opens the fix for every open failure in the
  cluster, and Replay cluster, which starts a recovery job after its preview.
- Home's Operator prompt is now one compact field at the bottom of What needs
  you, and answers open in a side panel instead of pushing Home down. The panel
  links the run the answer is based on and opens its recovery case in one click.
  Without an AI provider it says so and shows the root cause, failed step, error
  and next action, with the full report one click away. A question typed on Home
  with no draft loaded now answers about the most recent open failure instead of
  sending you to AI Studio. The five suggested questions moved to the panel.
- Templates now filters recipes by category, with a chip and a count for each
  category in the catalog, and shows them in compact three-column cards whose
  icons trace each recipe's steps. Solution packs moved to a Packs view next to
  Recipes on the same page; the search covers both, and each view's count
  follows it.
- Build shows a workflow's problems on the canvas. The Flow map card has a
  Problems chip with the count, workflow-level problems appear in a band above
  the steps, and a step with a problem has a dot on its corner. Each one opens
  what needs fixing: the step, the path, the Outputs section or Versions.
  Outputs and Versions problems also open from the Problems tab, whose count now
  lists a problem reported by two checks once. Add step no longer overlaps the
  Flow map card in Spanish.
- Retrying on Network errors now covers connection refused, connection reset and
  DNS failures, and retrying on Timeouts covers deadline exceeded. A policy that
  ignores `network` now stops retries for those failures too. A write-side MCP
  tool no longer retries after a failure, even with no retry filter: replay it
  from the failure instead. The recovery dialog describes these failures the
  same way.
- Closing a failure without recovery now shows its workflow, step and
  occurrences and requires a short reason. The reason is saved to the audit log
  and appears in the audit log's details.
- Workflow rows open with a click and keep delete behind a ⋯ menu. Move to
  Trash happens at once and its toast offers Undo for six seconds.
- Active and Trash are now a segmented control with counts above the workflow
  list. Deleted workflows appear in the same table, with their expiry date and
  Restore.
- New workflow opens a menu with Describe it, Start blank and Use a template,
  selectable with keys 1 to 3. The empty list shows the same three choices.
- Activity shows its sections as tabs: Runs, Recover with the number of open
  failures, Agent activity and Reports.
- Reports shows recovery trends for the last 7, 30 or 90 days: recovery KPIs,
  the activity heatmap, failure clusters, model calibration, AI spend, and
  Recovery validation and the Value dashboard with Markdown and JSON exports.
- Home keeps only what needs a decision now: the collapsed Insights and history
  section is gone, replaced by a Today strip with today's runs and success, open
  failures and pending approvals, plus the Operator prompt and a link to Reports.
  An AI budget banner appears only at the warning threshold.
- Build opens with the sidebar collapsed to a rail for more canvas; the flow
  name and version move to the top bar.
- Connections is now a table with type, health, the workflows known to use each
  connection, last used, expiry and owner. A header counts connections that are
  expiring or expired, with errors, and unused for 30 days. Long lists now scroll
  when Settings is opened directly.
- The Build panel opens on Step, Workflow and Problems. Its section tabs moved
  to the top bar, and Generate, Explain, Review and Fix sit on one line that
  fits in English and Spanish.

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
