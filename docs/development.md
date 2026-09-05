# Development guide

How to run, test, change and qualify Janusly locally. Operational
invariants live in `CLAUDE.md`; feature architecture lives under
`docs/architecture/`. This page is the working reference: commands, lanes,
procedures and the gotchas that cost time before.

## Run it

```bash
make db-up        # PostgreSQL 18 on 127.0.0.1:15473 (compose project "janusly")
make migrate      # apply the single baseline migration
make dev          # API on :3001, Vite dev server with the proxy, workers in-process
```

One executable serves the API, the React assets, the workers and the
maintenance loops. `JANUSLY_ENV=production` is the only production gate. The
web package is `web/` (pnpm); run its commands from that directory. In a
nested worktree use `pnpm --ignore-workspace` so a parent checkout cannot
capture the project.

Reset the development database (destroys the `janusly` compose volume only):

```bash
make db-reset CONFIRM=reset && make db-up && make migrate
```

## Test lanes

| Lane | Command | Needs |
|---|---|---|
| Go unit (race) | `make test` | nothing |
| Go integration | `make test-integration` | `JANUSLY_DATABASE_URL` pointing at a migrated PostgreSQL; runs `-p 1` |
| Web unit (jsdom) | `cd web && pnpm test` | nothing; CSS is not parsed |
| Web browser (Chromium) | `cd web && pnpm test:browser` | Playwright browsers |
| Web scripts | `cd web && pnpm test:scripts` | nothing |
| Web e2e | `make test-e2e` | Docker (fresh compose stack, built image) |
| Everything | `make verify` | Docker |

`make verify` (`scripts/verify-isolated.sh`) creates a fresh PostgreSQL
compose project, migrates twice (the second run must be a no-op), regenerates
`schema.sql` and checks it for drift, runs `make generate` drift, lint, vuln,
Go unit and integration, the web verify (`audit:ci`, lint, typecheck, unit,
scripts, browser, build, `bundle-check`) and the e2e lane, then ends with
`git diff --exit-code`. Commit first, verify after, and do not touch tracked
files while it runs.

A throwaway database for local integration runs, isolated from the dev one:

```bash
COMPOSE_PROJECT_NAME=janusly-w1 JANUSLY_POSTGRES_HOST_PORT=15499 \
  docker compose -p janusly-w1 up -d --wait postgres
make migrate DB_URL='postgres://janusly:janusly-local@127.0.0.1:15499/janusly?sslmode=disable'
JANUSLY_DATABASE_URL='postgres://janusly:janusly-local@127.0.0.1:15499/janusly?sslmode=disable' \
  go test -tags integration -p 1 ./internal/engine/ -run 'Diamond|Claim'
docker compose -p janusly-w1 down --volumes   # when done — do not leave it running
```

Any Janusly process on the same database (a soak, `make dev`) claims queued
nodes: tests that `StartRun` and then `claimBatch` race with it. Seed rows by
SQL when a test must own a specific node.

## Lint gates

Go: `golangci-lint` with the standard set plus `bodyclose`, `depguard`,
`modernize`, `rowserrcheck` and `unparam` (`.golangci.yml`). `depguard`
keeps the workflow core free of transport and persistence, forbids importing
`internal/httpapi` from services, and keeps the feature packages under
`internal/httpapi/*` leaves that depend on `internal/httpkit` only.

Web: `pnpm lint` runs oxlint plus the ratchets in `web/scripts/`: i18n casts,
CSS class ownership (every class in every stylesheet must have a production
owner), legacy UI guard, e2e selector presence, raw `/v1` reads (must go
through `contractApi`), and duplicate runtime guards (`src/lib/guards.ts` is
the only home). `web/src/modal-contract.test.ts` requires every
`role="dialog"` file to call `useDialogFocusTrap` in the same file.

Diagnostics that are not gates but drive the refactor backlog:

```bash
golangci-lint run --default=none -E gocognit,dupl,unparam --max-issues-per-linter 0 --max-same-issues 0 ./...
cd web && npx jscpd src --min-lines 10 --min-tokens 80 --ignore '**/*.test.*,**/test/**,**/*.generated.ts,**/i18n/**'
```

`gocognit` lists a function twice when a package is analysed with and
without its tests; the program keeps every function under 55 and splits new
hot paths into named steps (see `docs/changes/2026-09-improvement-program.md`).

## Changing the database

There is one migration, `internal/migrate/sql/00001_baseline.sql`, and no
upgrade bridges. The whole file sits inside one `-- +goose StatementBegin` /
`-- +goose StatementEnd` block: add new DDL **before** the closing marker, or
goose splits plpgsql bodies at every `;`.

1. Edit the baseline.
2. Hand-add the same columns to `schema.sql` so `sqlc` and the binary
   compile (`make generate`).
3. Write or change queries in `internal/store/queries/*.sql`; `SELECT *`
   returns the table model struct, an explicit column list returns a
   query-specific row struct.
4. Regenerate the real dump from a fresh database:
   `bash scripts/verify-isolated.sh schema` then `make generate` again.
5. Add new required columns to `assertBaseline` in `internal/migrate/migrate.go`.
6. `make verify` proves fresh migration, idempotent second migration and no
   drift.

`run_nodes` and `run_events` carry `org_id NOT NULL`; the hot writers stamp it
and the `stamp_run_row_org` trigger fills any other insert from the run row
(see `docs/architecture/database-schema.md`).

## Load qualification

```bash
make qualify-local PROFILE=load CONFIRM=reset   # ~73 min, needs a clean tree
```

It snapshots `HEAD` into a detached worktree, builds the image, brings up a
compose stack on ports 7310/7464 and runs `scripts/load-soak-local.sh`: three
scenarios (`start` 10 VUs, `list` 50 VUs, `diamond` 10 VUs), each two minutes
of warmup and twenty of measurement. Output lands in
`output/qualification/<stamp>/load/` with `summary.json`, per-scenario JSON,
`postgres-*.json`, `runtime-samples.tsv` and `logs/compose.log` — read the
compose log first when a scenario reports errors. The budget requires zero
errors and queue-snapshot availability ≥ 0.995. Check `docker info` before
blaming code when a run dies; Docker Desktop has crashed mid-run.

Reference numbers (p95 / p99 ms, 20-minute measured phases):

| commit | start | list | diamond |
|---|---|---|---|
| `7420403a` (before the 2026-09 program) | 57 / 169 | 25 / 70 | 123 / 280 |
| `cd17e77b` (after) | 30 / 48 | 16 / 21 | 128 / 219 |

## Bundle budgets

`web/performance-budgets.json` is a ratchet: caps on the total artifact, the
worst single-locale artifact and the eager `workflow-workspace` chunk, plus a
10 % allowance over each other chunk's recorded baseline. `pnpm bundle-check`
reports; a new named asset must get a baseline entry after review. Structural
changes that add object keys (a controller/view model, a router) cost gzip
bytes no minifier removes; the caps were raised once for that in 2026-09 and
are not raised for features. The bundle held no duplicated modules and the
i18n catalogs are prefix-compressed, so "find dead bytes" is rarely an option.

## Conventions

- HTTP handlers: `s.route(mux, pattern, gate, handler)` with the gate
  declared at the call site, delegating to a `<verb><Path>Core(r, rc) opResult`
  method. Only the ten auth-only routes register inline.
- Feature packages under `internal/httpapi/<name>` depend on
  `internal/httpkit` and receive `Deps{Pool, NewID, Routes}`; the root
  package mounts them.
- Provider integrations supply a request and a receipt check to the
  `providerCall` seam in `internal/tools`; the seam owns gating, rate limit,
  recording and the failure envelope.
- Engine outcome transactions are compare-and-swap guarded and replayed on
  transient errors (`persistOutcome`); claims carry the tenant.
- Frontend panels above ~500 lines split into a controller hook returning a
  model and presentational sections (`components/ai-studio/`,
  `components/recovery-dialog/`, `components/recovery-case/`,
  `components/recovery-item/`). Panel reads subscribe by resource tag
  (`src/lib/query-cache.ts`); navigation state lives in the hash route
  (`src/lib/route.ts`).
- Modal dialogs call `useDialogFocusTrap(dialogRef, { onEscape })` from the
  file that renders `role="dialog"`; pass `onEscape: undefined` while an async
  step is in flight instead of adding a keydown effect. Async work that may
  resolve after unmount checks `useAliveRef()` before touching state.

## Gotchas

- `contract/` is gitignored but `contract/openapi.json` is tracked: `git add -f`.
- A test that `t.Fatalf`s with an open pgx transaction hangs in
  `t.Cleanup(pool.Close)`; defer the rollback first.
- Tests that call `request*Focus` or `requestOperationsSection` leave a hash
  behind; reset `window.history.replaceState(null, '', '/')` in `beforeEach`.
- A test that used to poke `platformVersion` through `setState` must now call
  `invalidateTags([PLATFORM_TAG])`.
- The planner on a populated database uses PG18 skip scans; EXPLAIN pins in
  tests are deterministic only when no competing index shares the prefix.
- macOS: BSD `sed` has no `\b`, there is no `timeout`, and zsh does not
  word-split unquoted variables.
- `golangci-lint` caches by path: after deleting a scratch worktree, run
  `golangci-lint cache clean` or it reports issues at the removed path.
- CI runners have 4 CPUs, so a test pool built with `pgxpool.New` gets 4
  connections. Reproduce a CI-only integration failure by appending
  `&pool_max_conns=4` to `JANUSLY_DATABASE_URL`. Never block on a lock while
  holding a pooled connection (`acquireResourceLock` shows the try-and-release
  shape); with more waiters than connections the holder starves.
