# go-pilot — agent onboarding (any agent: Claude, Codex, Cursor, human)

This branch (`go-pilot`) hosts the Go rewrite pilot of the Janusly backend.
Everything an agent needs lives **inside the branch**; nothing depends on any
specific machine path or on any particular AI tool.

## Start here, in order

1. Read `go/PLAN.md` — the live execution plan. Task table in §2/§10; full
   per-task specs below it. It is written in Spanish; the code and commits
   are in English.
2. Read `go/JOURNAL.md` — what has already happened, frictions, decisions.
3. Take the **first `todo` task that is not blocked**, in ID order, and
   follow the execution protocol in PLAN.md §0 (implement → `make lint` and
   `make test` green → acceptance boxes checked → status `done` → commit →
   post a summary → next task, no approval needed).

## Ground rules (non-negotiable)

- Conventional Commits, **no AI attribution trailers** of any kind.
- Code comments never reference plan-internal naming (task IDs, PLAN
  sections) — comments explain the code for its next reader.
- Tests ship with every batch: `go test -race` always; integration tests
  hit the pilot database (env `JANUSLY_GO_DATABASE_URL`).
- Never push to `main`; never merge this branch anywhere. Push only
  `go-pilot` to `origin`, batched.
- Schema: the shared drizzle migrations are the single author. Pilot-only
  objects use `go_pilot_*` names in `go/migrations/` applied only to the
  pilot database. Never alter shared tables.
- Parity reference: the `develop` branch at the pin recorded in PLAN.md §9.
  Before parity work, review only the new commits
  (`git log <pin>..develop`) and update the pin.

## Environment (path-independent)

Work from **any** checkout of this branch — a `git worktree`, a plain
clone, or a cloud workspace. All tooling uses paths relative to the repo
root or `go/`:

```bash
# once per checkout
corepack enable && pnpm install         # repo tooling (migrations)
cd go
make db-up      # PostgreSQL 18 in its own compose project, port 4632
make migrate    # applies the repo's shared drizzle migrations
make build lint test
```

Ports (fixed, chosen to avoid the Node stack and 3000–3010): API **4600**,
internal metrics/pprof **4601**, PostgreSQL **4632**. Toolchain: Go 1.26.5
(pinned in go.mod), golangci-lint v2.x, sqlc, oapi-codegen — versions in
PLAN.md §1.2.

## What this is NOT

Not mergeable work. Not a place for changes outside `go/` (any exception
must be justified in JOURNAL.md). Not coupled to Node at runtime: the only
shared artifacts are the database schema, the OpenAPI contract, and the
wire behavior being ported.
