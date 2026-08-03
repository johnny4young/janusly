# Janusly Go backend — agent onboarding

The Go implementation is the replacement candidate for the Node.js backend.
The implementation plan is complete, but production readiness is being proven
independently. Do not infer certification from a completed plan row.

## Read first

1. [`AUDIT.md`](AUDIT.md) — active certification bands, findings, and exit
   criteria.
2. [`ARCHITECTURE.md`](ARCHITECTURE.md) — lifecycle, module boundaries, claim
   ladder, and ADRs.
3. [`PLAN.md`](PLAN.md) and [`JOURNAL.md`](JOURNAL.md) — historical execution
   record and implementation rationale. These files are intentionally Spanish;
   new repository-facing documentation and code remain English.
4. The relevant root architecture document under `docs/architecture/` before
   changing that feature area. The preserved `nodejs-legacy` branch is the
   compatibility and rollback oracle.

## Review protocol

- Work one certification or repair band at a time.
- Begin with current code and runtime evidence. A historical report is not a
  substitute for re-running the gate against the exact candidate commit.
- End each band with focused tests, an evidence summary, and one Conventional
  Commit before moving to the next band.
- Keep unrelated worktree output untouched. In particular, the original
  `go-pilot` checkout contains raw performance artifacts under review.
- Never add AI attribution trailers. Source comments explain behavior and
  invariants; they do not mention internal plan or ticket identifiers.

## Branch and integration rules

- `nodejs-legacy` remains immutable as the Node compatibility/rollback line.
- Certification work starts on `codex/go-pilot-audit`.
- A reviewed candidate progresses through
  `go-pilot -> go-integration -> develop` only after the applicable gates pass.
- Keep remote `main` unchanged. The pull request to `main` is the final action
  and requires the explicit release decision after certification.
- Do not force-push or rewrite published history.

## Schema ownership

The Go binary owns Go-runtime databases through embedded goose migrations in
`internal/migrate/sql/`. `janusly-go migrate` is the only supported migration
command for those databases, and boot requires the exact embedded version plus
the completed Node runtime bridge. Active API/MCP startup also applies the
work-plane readiness gate; passive read/shadow startup does not.

The Node compatibility line still authors its schema with Drizzle. When a Node
schema change must be consumed by Go, mirror it deliberately as the next goose
migration and prove Node-created-data and rollback compatibility. Never run
`pnpm migrate` against a goose-provisioned database: its Drizzle journal is
present but intentionally empty, so the Node runner could replay the baseline.

`migrations/0001_go_pilot.sql` was folded into the goose baseline and removed.
Do not reintroduce a second migration runner.

## Local environment

```bash
cd go
make db-up       # PostgreSQL 18 on 127.0.0.1:4632
make migrate     # embedded goose migrations only
make verify      # generate/drift, build, lint, unit, integration, parity
```

The PostgreSQL 15 floor is exercised by `make test-pg15`. Toolchain versions
are pinned by `go.mod` (`go1.26.5`) and the repository package manifests
(Node.js 24 and pnpm 11 for frontend/reference tooling).

Default ports are API 4600, internal metrics/pprof 4601, and PostgreSQL 4632.
Do not expose the internal listener publicly.

## Runtime invariants

- PostgreSQL `run_nodes` plus due-clock tables are the Go work queue; Redis and
  BullMQ are not Go delivery dependencies.
- All claims, completions, replays, and terminal effects preserve their CAS and
  transaction boundaries.
- Every tenant read/write remains organization-scoped.
- AI paths preserve the deterministic fallback contract.
- Outbound HTTP and MCP URL transports retain SSRF validation and DNS pinning.
- Shutdown must drain supervised loops and release LISTEN, HTTP, MCP, and
  database resources. Resource regressions fail goleak/connection gates.
