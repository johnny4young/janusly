# Worked final report — ENG-008

This is what a complete PHASE 2 report looks like when the work landed cleanly and a small collateral fix surfaced along the way.

---

### Index state

`git status --short`:

     M apps/api/src/index.ts
     M packages/db/package.json
     M scripts/run-e2e.mjs
     M docs/ROADMAP.md
     M package.json
     A packages/db/migrations/0001_init.sql
     A packages/db/migrations/0002_audit_logs.sql
     A packages/db/migrations/0003_dlq_and_routing.sql
     A packages/db/drizzle.config.ts
     A packages/db/src/migrations.test.ts
     D packages/db/src/schema-management.ts
     M apps/web/src/store.ts

`git diff --stat --cached`: 12 files changed, 487 insertions(+), 162 deletions(-).

### Verification notes

- `pnpm build`: PASS (tsc --noEmit clean across api/db/data; Vite build green for web).
- `pnpm test`: PASS — 99 tests across shared/engine/ai/domain/web (was 96; added 3 to migrations.test.ts).
- `pnpm test:e2e`: ran. Compose came up, `pnpm migrate` applied the 3 migrations, full Playwright flow passed, `docker compose down` ran at the end.
- `typescript-react-reviewer`: 0 findings on the web diff (small change in `store.ts`).
- `node`: 1 MED finding on `apps/api/src/index.ts` about a redundant try/catch around the new presence check; left as a Follow-up since the wrap is harmless and matches surrounding style.
- Live smoke: ran (steps below).
- Compose: brought up for e2e and smoke, brought down at the end.
- Collateral fixes applied: 1 (apps/web/src/store.ts).
- ROADMAP §3b items captured: None.

### Review Guide — ENG-008

**1. Automated gates** (copy-pasteable)

    pnpm build
    pnpm test
    pnpm --filter @janusly/db test -- packages/db/src/migrations.test.ts
    pnpm test:e2e

Test files added or modified:
- packages/db/src/migrations.test.ts (new)

**2. Prerequisite fixes**

- apps/web/src/store.ts:42 — stale import `formatBytes` from a helper that was deleted three commits ago. Replaced with a local `Intl.NumberFormat` byte formatter.

**3. Live smoke**

Bring-up:

    docker compose up -d redis postgres
    pnpm migrate                          # NEW — applies the 3 migrations
    pnpm --filter @janusly/api dev      # http://localhost:3001
    pnpm --filter @janusly/engine dev   # worker
    pnpm --filter @janusly/web dev      # http://localhost:5173

Auth: dev mode sends `x-org-id: default` and `x-user-id: dev-user` automatically.

Numbered steps:

1. Tear down Compose if running, then start fresh: `docker compose down -v && docker compose up -d redis postgres`.
2. Run `pnpm migrate` and confirm the 3 migrations applied (output lists them).
3. Boot api + worker + web. The API should start without printing the previous `runSchemaSync` log line.
4. Open http://localhost:5173, click `Save`, click `Run`. The run completes successfully — confirms tables wired correctly.
5. Run `psql postgres://postgres:postgres@localhost:5432/workflow -c "SELECT migration_id FROM __drizzle_migrations ORDER BY created_at"` and confirm the 3 migration ids are listed.

Verification SQL:

    psql postgres://postgres:postgres@localhost:5432/workflow -c "\d audit_logs"

Should show the same columns as before (id, org_id, user_id, action, target_type, target_id, metadata, created_at).

Teardown: `docker compose down`.

Hard assertion: 0 errors in the web console; API logs free of ERROR.

**4. Code review focus**

1. `packages/db/migrations/0001_init.sql` — verify every CREATE TABLE matches the previous `schema-management.ts` byte-for-byte (column order, types, defaults, NOT NULL).
2. `apps/api/src/index.ts:38` — the new presence check throws a clear error when the migrations table is missing instead of silently bootstrapping.
3. `scripts/run-e2e.mjs` — the new `pnpm migrate` call sits between Compose readiness and API boot; the existing `docker compose down` at the end still fires.
4. `packages/db/src/migrations.test.ts` — covers empty database, re-run idempotency, and partial-state error.
5. `apps/web/src/store.ts:42` — collateral fix; verify the new `Intl.NumberFormat` produces the same output as the deleted `formatBytes`.

Cross-check invariants:
- [x] Multi-tenant: no new query introduced; existing `org_id` filters untouched.
- [x] AI fallback: not touched.
- [x] Atomic claim `tryClaimNodeForQueue` not replaced.
- [x] `startRun` is still a single Drizzle transaction.
- [x] DLQ adapter composition not bypassed.
- [x] Worker `worker.close()` on SIGTERM/SIGINT preserved.
- [x] OTel `service.name === "janusly"`.
- [x] `bumpPlatformVersion()` not relevant for this ticket.
- [x] Pagination cap not touched.
- [x] `apps/web` imports unchanged.
- [x] No inline hex.
- [x] Vite `manualChunks` unchanged.
- [x] Zod 4 two-arg form not relevant.
- [x] `ALLOW_PRIVATE_HTTP_TARGETS=false` not touched.
- [x] Auth refusal preserved.
- [x] No tRPC / Stripe re-introduced.
- [x] Audit log untouched.

**5. Docs sync checklist**
- [x] `docs/ROADMAP.md` §3b ENG-008 flipped from Partial to Shipped with 2-line summary.
- [ ] `docs/PLAN.md` §10.2 Status Update not needed — claims still hold.
- [x] AGENTS.md not touched (no operational invariant changed).
- [ ] No new Pending row added.

**6. Quick rollback**

    git restore --staged .
    git checkout .
    rm -rf packages/db/migrations packages/db/drizzle.config.ts packages/db/src/migrations.test.ts

**7. Deferred follow-ups**

- node skill MED finding on `apps/api/src/index.ts:38` — consider trimming the redundant try/catch; not blocking.
- ENG-015 (GitHub Actions CI) should call `pnpm migrate` in its test job — already noted in the ENG-015 Scope cell, no action needed here.

### Commit message summary

    feat(db,api): formal drizzle migrations for production

    - db: add migrations/{0001_init,0002_audit_logs,0003_dlq_and_routing}.sql
    - db: add drizzle.config.ts pointing at the new directory
    - db: add db:migrate script delegating to drizzle-kit migrate
    - api: replace runSchemaSync with a migrations-table presence check
    - scripts: run-e2e calls pnpm migrate between Compose up and API boot
    - test: round-trip migrations.test.ts covers empty, idempotent, and partial-state cases
    - doc sync: ROADMAP §3b ENG-008 flipped to Shipped with summary
    - collateral: apps/web/src/store.ts:42 — stale formatBytes import replaced with Intl.NumberFormat
