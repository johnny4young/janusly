# Worked review report — ENG-008

This is what a complete review report looks like for the Drizzle migrations work shipped via `janus-ship` in `.claude/skills/janus-ship/examples/report-example.md`. The reviewer found two real bugs (one in the implementer's diff, one collateral) and one design concern.

---

## Review verdict

**Reviewed ticket:** ENG-008
**Scope check:** OK
**Verdict:** READY TO COMMIT
**Staging:** Intact (policy: no mutating git)
**Unstaged:** 2 files with review fixes

## Gates

- `pnpm build` → PASS
- `pnpm test` → PASS (102 tests; was 99 before adding 3 review-fix tests below)
- `pnpm test:e2e` → ran (Compose up → migrate → Playwright → Compose down, all green)
- `typescript-react-reviewer` → 0 findings on the web diff (only `apps/web/src/store.ts` was touched; trivial)
- `node` → 2 findings: 1 HIGH (fixed inline), 1 MED (Follow-up)
- UI smoke → ran (steps from implementer report were followed; no regressions)
- Compose down at the end → yes

## Bugs fixed inline (unstaged, show up in `git diff`)

1. **Migration 0002 missing `org_id` index on `audit_logs`** — `packages/db/migrations/0002_audit_logs.sql:14` — the original `schema-management.ts` had `CREATE INDEX IF NOT EXISTS audit_logs_org_created_idx ON audit_logs (org_id, created_at DESC)` but the migration extracted only the table, not the index. Without it, `GET /audit` would do a full scan once the table grows. Added the missing `CREATE INDEX` to the same migration file.

2. **`migrations.test.ts` skips when `DATABASE_URL` is unset instead of failing** — `packages/db/src/migrations.test.ts:8` — the test had `it.skipIf(!process.env.DATABASE_URL)` which silently passes in CI when the env var leaks. Changed to fail with a clear error: "DATABASE_URL required for migrations test; run via pnpm test:e2e harness." Also added a unit test that exercises the migrations runner against a Vitest-managed temp pg instance (uses `pg-mem`).

## Design / scope findings — NOT fixed (reported for your input)

1. **Migrations directory location vs Drizzle convention** — `packages/db/migrations/`
   - Problem: Drizzle's standard convention is `packages/db/drizzle/` for the migrations folder. The implementer chose `migrations/` to match the `pnpm migrate` script naming. Either is valid, but Drizzle's CLI defaults assume `drizzle/`.
   - Why I did not fix it: this is a naming preference that affects every future migration. Switching now is cheap; switching after 50 migrations is not.
   - What I need from you: confirm `migrations/` is the choice we want, or rename to `drizzle/` before this lands.

## Out-of-scope requirements → docs/ROADMAP.md §3b

- **[ops]** Add `pnpm migrate` to the GitHub Actions test job. Reason: ENG-015 (CI) is Pending and explicitly mentions the migrate step in its Scope cell, but the row was last touched before ENG-008 landed. Updated the ENG-015 Scope cell to reference the now-existing `pnpm migrate` script.

## Doc sync checklist (verifying the implementer's work)

- [x] `docs/ROADMAP.md` §3b ENG-008 flipped from Partial to Shipped with 2-line summary
- [ ] `docs/PLAN.md` §10.2 Status Update — implementer judged it not needed; I agree (claims still hold).
- [x] AGENTS.md (CLAUDE.md symlink intact, no roadmap leaked)
- [x] README.md without leaked planning (the `pnpm migrate` line in §Quick start was added correctly; no planning leaked)
- [✎] ENG-015 Scope cell updated to reference the new `pnpm migrate` script (added by reviewer; cross-references the now-shipped ENG-008)

## Commit message summary

    feat(db,api): formal drizzle migrations for production

    - db: add migrations/{0001_init,0002_audit_logs,0003_dlq_and_routing}.sql
    - db: add drizzle.config.ts pointing at the new directory
    - db: add db:migrate script delegating to drizzle-kit migrate
    - api: replace runSchemaSync with a migrations-table presence check
    - scripts: run-e2e calls pnpm migrate between Compose up and API boot
    - test: round-trip migrations.test.ts covers empty, idempotent, and partial-state cases
    - doc sync: ROADMAP §3b ENG-008 flipped to Shipped with summary
    - reviewer fix: packages/db/migrations/0002_audit_logs.sql:14 — restored audit_logs_org_created_idx that was dropped during extraction
    - reviewer fix: packages/db/src/migrations.test.ts:8 — replaced silent skipIf with hard error + added pg-mem unit test
    - roadmap: ENG-015 Scope cell cross-references the new pnpm migrate script
    - collateral: apps/web/src/store.ts:42 — stale formatBytes import replaced with Intl.NumberFormat

## How you continue

Staging intact with the implementer's work; unstaged with the reviewer's fixes.

Useful commands:

    git diff --cached         # implementer (staged)
    git diff                  # reviewer fixes (unstaged)
    git diff HEAD             # unified
    git diff --stat           # unstaged summary
    git diff --cached --stat  # staged summary

Paths to commit:

    git add -A && git commit -m "<suggested>"     # everything together
    git add <paths>                                # selective split
    git restore <path>                             # discard a reviewer fix
    git restore --staged <path>                    # unstage implementer work

The verdict is READY TO COMMIT, but flag the design question above (migrations folder name) before pressing the button. The two reviewer fixes are independently correct regardless of the folder-name decision.
