# Changelog

Notable user-facing and operational changes are recorded here. This document
follows the repository's Git history rather than assigning versions
retroactively.

## Versioning status

- Janusly has no Git tags in the current repository history as of 2026-07-20.
- **Unreleased** is therefore the only release section below. The dated sections
  are historical development milestones, not releases.
- A reasonable first public tag would be **v0.1.0** after the release checklist
  is complete. This is a recommendation, not a release that already exists.

## [Unreleased] — since 2026-07-20

### Changed

- The primary product navigation is now organized around six operator tasks:
  Home, Recover, Workflows, Runs, Connections, and Settings. Advanced authoring
  and administration remain available through contextual surfaces and the
  command palette, while saved deep links and permission checks remain intact.
- Recovery Center Home now reads one coalesced, permission-aware snapshot.
  Individual sections still fail independently, so a malformed or unavailable
  source cannot blank healthy recovery evidence.
- Supervised auto-healing now authorizes narrow autonomous publication only at
  the durable claim boundary. The server re-evaluates the immutable recovery
  policy, exact repair diff, validation strength, prior verified impact,
  one-execution blast radius, rollback availability, and effect-receipt posture;
  a failed factor keeps the candidate operator-gated.
- Recovery Center, Operations, and value exports now use a versioned
  production-only median time to verified recovery, with p90 as a guardrail.
  Validation runs and invalid recovery clocks are excluded from impact writes
  and windowed operational metrics; the legacy average `mttr` response field
  remains for compatible clients.
- Integration credential values now default to an organization-scoped encrypted
  PostgreSQL Secret Store protected by one external deployment root key.
  Environment-variable references remain an explicit migration mode, while
  runtime integrations, readiness, health, Slack, and external PostgreSQL tools
  share one asynchronous resolver.
  **Operator action:** set `JANUSLY_CREDENTIAL_MASTER_KEY` (or `_FILE`) — the
  same 32-byte key on every API and worker replica — before creating managed
  credentials; without it, `POST /credentials` with `secretValue` returns
  `credentials_secret_store_unavailable`, and a *configured but malformed* key
  now fails API/worker startup fast. The accompanying migration also enforces
  unique credential names per organization (pre-existing duplicates are kept
  but renamed with a `-dup-<id>` suffix; review them after migrating) and adds
  the `credential_secret_versions` table.
- The persistent local profiles now use one Supabase PostgreSQL database:
  Supabase owns `auth`, Janusly owns `public`, and the separate Compose
  PostgreSQL service has been removed.
- Normal local startup is data-empty. Provider credentials/configuration are
  installed only by explicit qualification commands; real-use configuration
  is created manually.
- Tenant actions now consume the selected organization's effective permission
  set in both API enforcement and browser affordances. Custom roles no longer
  inherit workflow, run, recovery, SCIM, or administration actions merely from
  a rank-equivalent built-in role.
- The persistent local lab can explicitly switch from its safe provider
  simulator to environment-backed GitHub, Slack, webhook, and email delivery.
  Secrets reach only API and worker containers, bootstrap-owned credential
  references switch idempotently, and simulator smoke commands refuse to run
  against external providers.
- Retention, calibration, upstream-health polling, repair reconcilers, and
  consent-revocation purges now run on an isolated low-concurrency BullMQ
  maintenance lane. Rolling upgrades preserve already-materialized jobs,
  shutdown drains both workers, and Operations/Prometheus expose workflow and
  maintenance pressure independently without widening public health details.
- The JavaScript toolchain now requires Node.js 24 and pnpm 11, with TypeScript
  7, Vite 8, Vitest 4, Oxlint, and Vercel AI SDK 7.
- CI, containers, workspace metadata, SDK metadata, and contributor
  documentation now describe the same Node.js 24 runtime boundary.
- CI now runs an explicit TypeScript 7 gate across every typed workspace; the
  web package checks both its production tree and its complete test tree.
- Recovery Center refreshes now follow platform and terminal-run invalidations,
  with a 10-second fallback during active failures, a 60-second healthy
  fallback, and no background-tab polling.
- The private Node SDK now consumes stable `/v1` envelopes and builds a normal
  ESM package with declarations, source maps, and an isolated tarball consumer
  smoke test. Registry publication remains disabled.
- The Python SDK's synchronous and asynchronous run/recovery resources now use
  the same stable `/v1` envelopes, typed protocol-drift errors, filters, and
  keyset cursor semantics as the Node SDK.
- The stdio MCP server now consumes stable envelopes for every published
  workflow, run, recovery, report, memory, and outbound-connection operation.
- The stdio MCP server now exposes an agent-complete workflow lifecycle with
  structured tool results, risk annotations, recoverable `isError` failures,
  complete stable list filters, primitive JSON run inputs, durable run polling
  and usage tools, recovery/memory evidence, and outbound-connection updates.
  Patched failures can be continued on a saved version through idempotent run
  redrive, and circuit-breaker pauses can be resumed with bounded trigger
  backfill. Broad platform administration, workflow trash controls, and secret
  values remain deliberately outside the agent surface.
- Outbound MCP Streamable HTTP and legacy SSE connections now use the same
  connect-time DNS pin and redirect revalidation as Janusly HTTP tools,
  including cross-origin credential stripping and deterministic cleanup after
  failed initialization or long-lived streams.

### Added

- A privacy-bounded local moderated-usability kit records five pseudonymous
  task observations per participant, writes owner-only session files, produces
  a fail-closed acceptance report, and keeps automated browser readiness
  evidence explicitly separate from the required five unfamiliar human
  participants.

- Deterministic semantic outcome recovery through `RecoveryContractV2`.
  Expression/schema detectors can observe or quarantine an unacceptable output,
  durable Recovery Cases retain append-only transition evidence, and only a
  detector-valid replacement or explicit accepted loss can continue a
  quarantined workflow.
- A dedicated Recovery Case workspace and stable API/MCP operations for listing,
  inspecting, and resolving semantic cases without reconstructing the lifecycle
  across unrelated panels.
- Exact baseline/candidate semantic dataset qualification before canary traffic.
  Qualification runs no nodes or provider effects, rejects stale evaluator
  receipts, and never grants mutation authority to an LLM judge.
- Signed, idempotent shadow ingestion for externally executed workflows. The
  API, Operations UI, and Node SDK retain monotonic workflow/run/step
  projections and bounded scrubbed evidence while deliberately exposing no
  external control authority or Janusly verified-recovery credit.
- A committed 25-case, provider-free Recovery evaluation corpus covering nine
  deterministic production capabilities. Its fail-closed baseline pins the
  dataset hash and requires 100% overall, per-capability, and safety-critical
  pass rates with zero unsafe acceptances and zero secret leaks; CI runs the
  suite at no provider cost.
- An explicit Real Recovery Lab that creates and destroys one isolated local
  payment-retry tenant, injects a provider-boundary failure, reaches the real
  DLQ, validates an idempotent webhook repair through the normal engine path,
  persists a provider-scoped effect receipt, publishes and redrives the repair,
  verifies the recovery ledger, and proves duplicate delivery does not repeat
  the provider effect. English/Spanish browser evidence and a machine-readable
  result bundle are produced by one local command.
- Versioned `RecoveryContractV1` and `RecoveryCaseState` domain contracts. A
  workflow can retain operator-owned technical-failure, evidence, effect,
  repair, validation, approval/autonomy, verification, and recurrence policy;
  legal case transitions require actor-attributed evidence receipts. Historical
  V1 snapshots remain compatible and keep semantic detection disabled unless an
  operator explicitly adopts V2.
- Prompt-generated PagerDuty V3 workflows: recognized off-hours requests
  compile locally into a visible signed-trigger, authoritative-read,
  deterministic-policy, acknowledge, snooze, and evidence graph. Credential
  names and rules remain versioned in the workflow; secret values remain in
  the tenant Secret Store. Duplicate webhook deliveries converge on one run,
  local provider/browser smoke covers the complete graph, and optional AI
  summaries are appended only when explicitly requested.
- Provider-neutral account bootstrap for signed-in users: global profiles,
  first-organization creation, bounded organization selection, invitation
  acceptance, organization switching, and truthful viewer/editor/admin UI.
- Revocable WorkOS browser sessions backed by server rows and opaque HttpOnly
  cookies, explicit CSRF enforcement, logout and organization rotation, plus
  bounded maintenance cleanup of expired sessions and one-time SSO state.
- A persistent local Supabase PostgreSQL/Auth profile on ports 7432/7431 with a
  real owner/viewer/editor Playwright journey and persistence proof across a
  complete Janusly stack restart.
- A loopback-only persistent Docker integration lab with Supabase PostgreSQL,
  named Redis, provider-evidence, and optional Ollama persistence; separate API
  and worker processes; one-shot migrations; deterministic GitHub, Slack,
  signed-webhook, and email simulation; controlled failure modes; restart
  persistence proof; and Chromium smoke evidence.
- Durable authenticated JSON webhook ingestion with stable caller event IDs,
  idempotent run creation, persisted replay anchors, selector ambiguity
  rejection, strict payload bounds, and authoring/UI coverage.
- Observable workflow result contracts: tool nodes can promote failed
  `{ ok: false }` envelopes, AI nodes can require schema-valid structured
  output, human-form defaults are schema checked, and readiness reports unsafe
  side-effect paths before execution.
- Solution Packs now declare real inbound webhook contracts, strict templates,
  structured AI outputs, fail-closed side effects, and explicit workflow
  outputs, with runtime and UI qualification evidence.

- An Observability Starter Kit with pinned Grafana Alloy, Prometheus, Tempo,
  and Grafana profiles for local operation, plus a Grafana Cloud forwarding
  profile, provisioned operations dashboard, starter alert rules, safe
  loopback defaults, and an end-to-end configuration guide.

- Progressive baseline/canary workflow deployments with deterministic traffic
  assignment across manual starts, inbound triggers, schedules, and unpinned
  production subworkflows; immutable version capture, strict trigger
  compatibility, idempotent terminal evidence, bounded repair, and
  minimum-sample automatic rollback are included with responsive
  English/Spanish Inspector controls.
- Signed Slack recovery actions that let explicitly mapped operators
  acknowledge, assign, or open recovery work from Block Kit alerts. Exact-body
  HMAC verification, team binding, normal recovery authorization, atomic
  replay protection, audit parity, text-only fallback, and responsive
  English/Spanish administration are included.
- Paced replay campaigns for 2–100 matching Recovery Queue failures, with a
  server-derived cohort preview, durable per-item progress, 1–60 second
  pacing, cancellation, Redis publication repair, audit evidence, and
  responsive English/Spanish controls.
- A unified Runs workspace with accessible Overview, Timeline, and Agents
  views, preserving direct expert access to the full reasoning and multi-agent
  surfaces through the command palette.
- Selectable Recovery Drills in Solution Packs for credential availability and
  expiry, malformed AI output, rate limits, upstream contract drift, and
  provider outages. Drill runs retain durable source evidence and enter the
  real recovery queue without exposing raw fixture errors in the catalog.
- A controlled worker-interruption drill that creates one scoped stale claim,
  honors the configured reaper threshold, exercises the production CAS/DLQ
  path, and reports measured scan, reap, dead-letter, and runtime evidence.
- Measured Recovery Drill outcomes in Recovery Queue, including elapsed time,
  verified terminal-success or accepted-loss evidence, replay-chain attempts,
  and seven-day production recurrence monitoring.
- A bounded Recovery Validation dossier in Recovery Center that aggregates
  controlled drills by completion, recovery rate, operator intervention,
  measured timing, failure mode, and recovery path, with tenant-scoped
  Markdown/JSON exports and explicit external-validation limitations.
- Stable `/v1` contracts and OpenAPI operations for starting, resuming, and
  cancelling runs, including runtime validation of strict JSON request bodies.
- Stable `/v1` contracts for outbound MCP connection management and the recipe
  and runtime-tool catalogs, including decoded dynamic-path validation and
  required OpenAPI path parameters.
- Stable `/v1` workflow validation, production-readiness, and health contracts,
  with the web and MCP clients migrated to versioned health and preflight calls.
- Stable `/v1` workflow save and rollback contracts with explicit request,
  response, conflict, validation, and authorization guarantees.
- Stable `/v1` DLQ summary, failure-cluster, and exact dead-letter replay
  contracts. The MCP server now uses those envelopes and requires
  `deadLetterId` for generation-bound replay attribution.
- A stable JSON-only `/v1/reports/run-explain` contract for deterministic run
  evidence. MCP uses the validated envelope while web and SDK artifact
  downloads keep their existing filenames and raw bytes.
- Stable `/v1` contracts for AI workflow generation and recovery patch drafts,
  including strict request validation, runtime response validation, and MCP
  migration without persisting suggestions.
- A Playwright + axe accessibility floor for Recovery Center, recovery queue,
  AI Studio, command palette, and mobile navigation across light English and
  dark Spanish states, with optional screenshot evidence.
- Database contracts that compare all Drizzle tables, columns, defaults,
  primary keys, and indexes with the latest migration snapshot and protect
  operationally critical index shapes.

### Fixed

- Workflow save no longer strips documented `recovery` settings, and
  full-workflow AI improvement cannot invent or overwrite the operator-owned
  recovery policy.
- Opening Step setup no longer injects a three-node Sample workflow; a new
  workspace starts with an untitled, empty canvas and explicit add-step
  guidance.
- Identity and organization transitions now cancel prior in-flight API, SSE,
  and download work, clear tenant-owned notifications and projections, and
  ignore late bootstrap responses from a previous organization.
- Local Supabase lifecycle commands no longer print credential-bearing start
  or status output; status reports only service health and the local Auth URL.
- The production web bootstrap no longer renders the initial workflow name as
  `undefined` when the App chunk evaluates before the lazy locale catalog.

- Stalled-node recovery now commits the running-node claim, optional replayable
  DLQ row, causal node event, and parent-run failure in one transaction, so a
  process interruption cannot leave a failed node beneath a non-terminal run.
- Recovery Queue detail now labels controlled drills and their actual recovery
  path without changing classifier-facing errors or stable `/v1` summaries.
- Direct deterministic drills now create recovery ownership through the same
  post-commit seam as production DLQ writes, and selected DLQ detail refreshes
  after platform mutations instead of retaining stale evidence.
- Recovery-queue selections now keep the legacy full-detail `GET /dlq?id=`
  path instead of being misrouted through the bounded `/v1/dlq` list contract
  and failing with HTTP 400.
- Workflow rollback now requires `workflows.write`, rejects missing parents and
  malformed source snapshots, retries concurrent version allocation, and
  reconciles schedule entries after committing the new latest version.
- Workflow save and rollback now read only the latest version's bounded
  reliability projection instead of loading the complete immutable history.
- DLQ reads now enforce the existing `dlq.read` permission in addition to
  viewer rank, so custom roles cannot bypass a tenant's permission override.
- Run/value report exports and report delivery now enforce their existing
  `reports.read` and `reports.deliver` permissions in addition to role rank.
- Every LLM-backed HTTP surface now enforces the existing `ai.write`
  permission, and stable budget blocks retain a catalogued `budget_exceeded`
  code plus bounded scalar context.
- Structured AI generation now uses the stable AI SDK 7 output API while
  preserving validated object results and deterministic fallbacks.
- Repository ratchets that inspect TypeScript and TSX source now use the Oxc
  parser, preserving their binding and selector checks under TypeScript 7.
- Outbound MCP connection updates now pass through the same two-flag consent
  gate as every other MCP-originated connection mutation.
- Web API boundaries, React Flow adapters, asynchronous callbacks, and test
  fixtures now retain their concrete contracts under TypeScript 7 instead of
  relying on Vite's transpilation to hide static drift.
- Operator metadata, AI cost chips, active navigation, section kickers, and
  command-palette text now retain WCAG AA contrast in light and dark themes.
- The runs list, Flows list, and Trash list keysets are now backed by
  sort-aligned indexes (org, timestamp DESC, id DESC — NULLS FIRST to match
  the queries' ORDER BY), replacing strict-prefix indexes that forced Postgres
  to re-sort the organization's entire run history on every page. Operators
  deploying to production apply the migration's sibling `production-rollout.sql`
  (concurrent index creates/drops) before `pnpm migrate`.

## Development milestone: recovery platform hardening

**Date range:** 2026-07-19 to 2026-07-20

**Release status:** merged development work; not tagged

### Added

- A recovery runtime with transient retries, circuit breaking, trigger
  buffering, durable queue publication, stalled-node repair, production
  redrive, and rollback.
- A Recovery Center with resilience authoring, playbook scorecards, operational
  deep links, and a versioned API contract surface.
- Public and administrative observability for queue pressure, rate-limiter
  degradation, workflow health, recovery outcomes, costs, and audit evidence.

### Fixed

- Hardened replay claims and terminal transitions against stale workers,
  duplicate publication, and interrupted trigger backfills.
- Removed private planning material from the tracked repository and added
  repository-hygiene enforcement.

**Traceability:** [pull request #18](https://github.com/johnny4young/janusly/pull/18),
[pull request #19](https://github.com/johnny4young/janusly/pull/19)

## Development milestone: recovery completion and API hardening

**Date range:** 2026-07-02 to 2026-07-06

**Release status:** merged development work; not tagged

### Added

- Full workflow operability through the stdio MCP server, with tenant scoping,
  consent gates, and route-level coverage for write operations.
- Configurable recovery SLA targets, SLA-attainment reporting, credential
  expiry warnings, billing usage export, recovery trends, and downtime views.
- Real-Postgres integration lanes plus an end-to-end recovery journey covering
  failure, dead-letter handling, sandbox validation, and replay.

### Changed

- Centralized API error envelopes and split large API, engine, data, and web
  modules into focused boundaries.
- Reduced queue payloads and persistence round trips for node execution.

### Fixed

- Recovery replay now applies the selected repair before starting the new run,
  and cluster repair can apply the same fix to matching workflow failures.
- CSV exports guard against spreadsheet-formula injection.

**Traceability:** [pull request #15](https://github.com/johnny4young/janusly/pull/15),
[pull request #16](https://github.com/johnny4young/janusly/pull/16)

## Development milestone: operator UX and accessibility

**Date range:** 2026-06-24 to 2026-06-28

**Release status:** merged development work; not tagged

### Added

- Accessible recovery workflows with focus management, screen-reader context,
  meaningful canvas labels, error boundaries, loading skeletons, and inline
  validation.
- Soft-deleted workflow pagination, richer panel discovery, recovery failure
  explanations, and fresher run and infrastructure status indicators.
- Virtualized run history and first-run guidance for a faster operator UI.

### Fixed

- Improved status and muted-text contrast to meet WCAG AA expectations.
- Prevented duplicate sidebar submissions and recovered the canvas safely when
  switching workflows after a rendering error.

**Traceability:** [pull request #7](https://github.com/johnny4young/janusly/pull/7)
through [pull request #13](https://github.com/johnny4young/janusly/pull/13)

## Development milestone: scale, organization, and enterprise controls

**Date range:** 2026-06-01 to 2026-06-23

**Release status:** historical development work; not tagged

### Added

- Workflow folders and tags with server-side filtering, keyset pagination,
  drag-and-drop organization, inline editing, and bounded bulk operations.
- A server-filtered recovery queue, evidence delivery, audit-log access,
  custom roles, directory synchronization, and enterprise identity controls.
- Property-based workflow-generation tests and additional data, API, browser,
  and integration coverage.

### Changed

- Code-split the canvas and heavy operator panels, persisted canvas viewports,
  and reduced initial web bundle work.
- Moved capped recovery filtering and sorting to the server so important older
  incidents remain discoverable.

## Development milestone: product expansion and AI quality

**Date range:** 2026-05-14 to 2026-05-31

**Release status:** historical development work; not tagged

### Added

- Installable solution packs, first-recovered-run onboarding, event-driven
  triggers, retention controls, recovery operations, and richer AI Studio tools.
- Local workflow-generation evaluations, free-JSON generation, prompt caching,
  model routing, few-shot guidance, and quality-selection strategies.
- English and Spanish localization, live run streaming, operational reports,
  typed SDKs, and reusable workflow capabilities.

### Changed

- Improved web rendering and data-query performance through code splitting,
  batched stream updates, memoized canvas rendering, and collapsed N+1 reads.

## Development milestone: recovery and governance foundation

**Date range:** 2026-05-01 to 2026-05-13

**Release status:** historical development work; not tagged

### Added

- Recovery diagnosis, structural repair proposals, sandbox Replay Lab,
  run-explanation reports, and a recovery-focused home experience.
- AI budget governance, provider-neutral completion boundaries, organization
  membership resolution, and production authentication gates.
- Scheduled workflows, parallel branches, human forms with signed resume
  tokens, email and PDF tools, and MCP write consent.

### Changed

- Split the API registry into focused route modules and strengthened typed
  runtime boundaries.

## Development milestone: initial platform foundation

**Date range:** 2026-04-25 to 2026-04-30

**Release status:** historical development work; not tagged

### Added

- The pnpm monorepo, workflow DAG engine, API, worker, Postgres persistence,
  Redis-backed queues, scheduler, and React visual workflow builder.
- Workflow versioning, retries, dead-letter handling, OpenTelemetry,
  AI-assisted workflow generation and run explanation, a read-only MCP server,
  and a local evaluation harness.
- Formal database migrations, browser-mode canvas coverage, continuous
  integration, Redis-backed AI rate limits, and one-command local startup.

### Security

- Added API authentication and authorization hardening, atomic workflow saves,
  outbound HTTP SSRF controls, and DNS-rebinding protection.
