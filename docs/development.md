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
| CI classification/gate | `make test-ci` | git, bash, jq; fixture repositories only |
| Browser/API route parity | `make test-route-parity` | Go, no database; reads frontend sources |
| Two-instance HA (race) | `make test-ha` | Docker; owns a fresh PostgreSQL 18 project and migrates twice |
| Go integration | `make test-integration` | `JANUSLY_DATABASE_URL` pointing at a migrated PostgreSQL test role with `CREATEDB`; runs `-p 1` |
| Web unit (jsdom) | `cd web && pnpm test` | nothing; CSS is not parsed |
| Web browser (Chromium) | `cd web && pnpm test:browser` | Playwright browsers |
| Web scripts | `cd web && pnpm test:scripts` | nothing |
| Web e2e | `make test-e2e` | Docker (fresh compose stack, built image) |
| Everything | `make verify` | Docker |

`make verify` (`scripts/verify-isolated.sh`) creates a fresh PostgreSQL
compose project, migrates twice (the second run must be a no-op), regenerates
`schema.sql` and checks it for drift, runs `make generate` drift, lint, deadcode, vuln,
Go unit, integration and two-instance HA, the web verify (`audit:ci`, lint,
app/unit/E2E typecheck, unit, scripts, browser, build, `bundle-check`) and the
e2e lane, then ends with
`git diff --exit-code`. Commit first, verify after, and do not touch tracked
files while it runs.

The E2E harness labels its image with the exact Git commit and tree only when
its source checkout is clean. Standalone `make test-e2e` still accepts WIP, but
uses unverified placeholder labels rather than claiming the last commit built
the dirty source. Ambient build-label variables cannot override this choice.
The selected real-executable lane includes `responsive.spec.ts`: its EN/ES
640×360 CSS viewport at 2× device scale is an automated approximation of a
1280×720 desktop at 200% browser zoom, not a physical zoom or screen-reader
acceptance pass. Those still require the separate study in
`docs/usability-testing.md`.
The same lane runs `usability-study-readiness.spec.ts` against real failures
and routes in both locales; it verifies affordances only, not interviews or
unassisted participant completion.

A throwaway database for local integration runs, isolated from the dev one:

```bash
COMPOSE_PROJECT_NAME=janusly-w1 JANUSLY_POSTGRES_HOST_PORT=15499 \
  docker compose -p janusly-w1 up -d --wait postgres
make migrate DB_URL='postgres://janusly:janusly-local@127.0.0.1:15499/janusly?sslmode=disable'
JANUSLY_DATABASE_URL='postgres://janusly:janusly-local@127.0.0.1:15499/janusly?sslmode=disable' \
  go test -tags integration -p 1 ./internal/engine/ -run 'Diamond|Claim'
docker compose -p janusly-w1 down --volumes   # when done — do not leave it running
```

The executable browser lane also runs the operator keyboard-triage proof in
English and Spanish: accepted-loss confirmation, cancellation, focus recovery and
copy/palette navigation use real seeded failures, not mocked UI mutations.
It also exercises outcome qualification, bounded canary creation and automatic
baseline return, with English and Spanish deployment views.

The executable shutdown integration test builds `cmd/api`, creates and migrates
its own UUID-named database, and starts the binary with an explicit environment
without provider credentials. It signals SIGTERM during a real external DB-tool
query, verifies durable completion and pool drain, and removes only its owned
database. The Compose test role already has the required `CREATEDB` privilege.

Any Janusly process on the same database (a soak, `make dev`) claims queued
nodes: tests that `StartRun` and then `claimBatch` race with it. Seed rows by
SQL when a test must own a specific node.

## CI selection and required checks

The `CI` workflow runs on pull requests, merge groups and pushes to `main` or
`develop`, including docs-only changes. Its stable **CI gate** evaluates the
classified inputs and every relevant lane result. Only an intentionally
unselected lane may be `skipped`; missing, failed, cancelled or unexpectedly
skipped results fail the gate. Making this check required is a separate repository
owner action; changing the workflow does not enable branch protection.

| Changed inputs | Product lanes | Website |
|---|---|---|
| `web/` | Frontend, route parity, single-runtime E2E | skipped |
| Go/API/database | Backend, integration, HA, route parity, E2E | skipped |
| OpenAPI/contract | Both product sets | skipped |
| `website/` or website workflows | skipped | npm check/build |
| Documentation only | skipped; CI gate still runs | skipped |
| Shared/unknown inputs or missing base | All | npm check/build |

The classifier reads a NUL-delimited complete diff with renames treated as
removal plus addition, so deleted inputs and unusual filenames retain ownership.
A failed diff is an error, never an empty change set. `make test-ci` exercises
path selection and all flag combinations against failure, cancellation and
unintended-skip results. The separate website workflow is reusable from CI,
receives no deployment secrets, and never joins `make verify` or product builds.
Website deployment remains its existing main/manual workflow; Wrangler is an
exact dev dependency restored with `npm ci`, not a floating `npx` download.

HA has its own PostgreSQL service in CI. Both replica pools are capped at four
connections on every host, and both worker and campaign loops drain before pool
cleanup. The ten-minute Go timeout emits goroutine stacks; the larger job budget
leaves room to upload the HA log. `make test-ha` uses the isolated local harness;
`test-ha-current-db` is the internal target for callers that already own a
migrated test database. Product artifacts run only on product-changing pushes
after CI gate succeeds, not website- or documentation-only pushes.

These choices follow GitHub's guidance on
[required check skips and dependent jobs](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/troubleshooting-required-status-checks)
and Cloudflare's recommendation to
[install Wrangler locally](https://developers.cloudflare.com/workers/wrangler/install-and-update/).
Local fixture and lane results do not replace exact-head GitHub Actions results.

## Lint gates

Go: `golangci-lint` with the standard set plus `bodyclose`, `depguard`,
`modernize`, `rowserrcheck` and `unparam` (`.golangci.yml`). `depguard`
keeps the workflow core free of transport and persistence, forbids importing
`internal/httpapi` from services, and keeps the feature packages under
`internal/httpapi/*` leaves that depend on `internal/httpkit` only.

Dead code: `make deadcode` runs `go tool deadcode` over every `./cmd/...`
root (including dev tools such as the seeder and load generator) and diffs the unreachable functions against
`scripts/deadcode-allowlist.txt`, one `<import path>.<Func> # <reason>` per
line. A new unreachable function fails with the exact line to add (or delete
the function); an entry that is no longer reported fails as stale. It runs in
`make verify` and the Backend CI job. On the web side, `pnpm lint` ends with
`knip` (`web/knip.json`), which fails on unused exports, files and
dependencies. It counts test files as consumers, so an export used only by
tests passes; tag an intentionally public export with `/** @public */`.

Web: `pnpm lint` runs oxlint plus the ratchets in `web/scripts/`: i18n casts,
CSS class ownership (every class in every stylesheet must have a production
owner), legacy UI guard, e2e selector presence, raw `/v1` reads (must go
through `contractApi`), and duplicate runtime guards (`src/lib/guards.ts` is
the only home). The native Oxlint `react/rules-of-hooks` rule is an error;
`web/scripts/react-hooks-lint.test.mjs` proves the repository configuration
rejects a conditional hook. `react/exhaustive-deps` is diagnostic-only, not a
current gate. `web/src/modal-contract.test.ts` requires every
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
2. Generate `schema.sql` from the edited baseline on a fresh, isolated
   PostgreSQL 18 database: `bash scripts/verify-isolated.sh schema`. Never edit
   the dump by hand; the harness owns and removes only its disposable project.
3. Write or change queries in `internal/store/queries/*.sql`; `SELECT *`
   returns the table model struct, an explicit column list returns a
   query-specific row struct.
4. Run `make generate` to regenerate store code and contracts, then update the
   callers for the generated types. If the baseline changes again, repeat the
   isolated schema step before regeneration.
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
worst single-locale artifact, the eager `index.css` stylesheet and the eager
`workflow-workspace` chunk, plus a 10 % allowance over each other chunk's
recorded baseline. Styles for a lazy panel live next to the component
(`<Component>.css`) so they ship with its chunk instead of the cold path. `pnpm bundle-check`
reports; a new named asset must get a baseline entry after review. Structural
changes that add object keys (a controller/view model, a router) cost gzip
bytes no minifier removes; the caps were raised once for that in 2026-09 and
are not raised for features. The bundle held no duplicated modules and the
i18n catalogs are prefix-compressed, so "find dead bytes" is rarely an option.

## Marketing site (`website/`)

`website/` is the janusly.app landing: Astro 7 + Tailwind 4, English at `/`
and Spanish at `/es`, a standalone npm package (not the pnpm web project and
not part of `make verify`). Copy lives in `src/i18n/{en,es}.ts` and the
parity test keeps both dictionaries key-for-key. Scripts stay external under
`public/scripts/` because `public/_headers` ships a `script-src 'self'` CSP
and the postbuild step refuses inline executable scripts.

```bash
cd website && npm ci && npm run check && npm run build && npm run preview
```

The product screenshots under `website/public/screens/` come from
`web/e2e/marketing-screens.spec.ts`, which runs only with
`JANUSLY_MARKETING_SCREENS_DIR` set, against a seeded runtime stack booted
the way `scripts/test-e2e.sh` does it (compose project, `cmd/seed`, no
provider key; the AI proposal is answered by the spec's own mock and rendered
by the real UI):

```bash
cd web && PLAYWRIGHT_SKIP_WEB_SERVER=1 JANUSLY_E2E_RUNTIME_BASE_URL=http://127.0.0.1:33011 \
  E2E_API_URL=http://127.0.0.1:33011 JANUSLY_MARKETING_SCREENS_DIR=/tmp/screens \
  pnpm exec playwright test e2e/marketing-screens.spec.ts --project=chromium
sips -s format jpeg -s formatOptions 78 -Z 1440 /tmp/screens/home.png --out website/public/screens/home.jpg
```

`.github/workflows/deploy-website.yml` deploys `dist/` to the Cloudflare
Pages project `janusly-web` on every push to `main` that touches `website/`;
it needs the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets and,
optionally, the `PUBLIC_CF_ANALYTICS_TOKEN` variable.

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
- Actions are `<Button>` (`components/ui/Button.tsx`): `size="sm"` inline,
  `variant="primary"` once per surface, `variant="danger"` for destructive,
  `size="icon" variant="ghost"` for icon-only, `aria-pressed` for toggles,
  `loading`/`loadingLabel` for async work instead of a hand-rolled label. Raw
  `<button>` is for tabs, radios, menu items and rows with their own styles.
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
- Test refreshes through resource invalidation (`invalidateTags`), not a
  workflow-store counter. Untagged mutations refresh all panels.
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
