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

- The JavaScript toolchain now requires Node.js 24 and pnpm 11, with TypeScript
  7, Vite 8, Vitest 4, Oxlint, and Vercel AI SDK 7.
- CI, containers, workspace metadata, SDK metadata, and contributor
  documentation now describe the same Node.js 24 runtime boundary.
- The private Node SDK now consumes stable `/v1` envelopes and builds a normal
  ESM package with declarations, source maps, and an isolated tarball consumer
  smoke test. Registry publication remains disabled.
- The Python SDK's synchronous and asynchronous run/recovery resources now use
  the same stable `/v1` envelopes, typed protocol-drift errors, filters, and
  keyset cursor semantics as the Node SDK.

### Added

- Stable `/v1` contracts and OpenAPI operations for starting, resuming, and
  cancelling runs, including runtime validation of strict JSON request bodies.

### Fixed

- Structured AI generation now uses the stable AI SDK 7 output API while
  preserving validated object results and deterministic fallbacks.
- Repository ratchets that inspect TypeScript and TSX source now use the Oxc
  parser, preserving their binding and selector checks under TypeScript 7.

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
