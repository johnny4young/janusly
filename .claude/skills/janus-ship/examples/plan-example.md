# Worked plan — ENG-008

This is the kind of plan output to write at the end of PHASE 1. The example targets ENG-008 (Formal Drizzle migrations for production) which is `Partial` in `docs/ROADMAP.md` §3b.

---

Proposed: ENG-008 — Formal Drizzle migrations for production

Origin: ROADMAP §3b auto-pick (preferring Partial over Pending; ENG-008 is the only P1 Partial in Phase 1)
Status before: Partial
Priority: P1
Phase: 1

Scope (from §3b Remaining):

The `Remaining:` line says: "migration files do not exist yet — extract from `schema-management.ts`, wire `pnpm migrate` script, update e2e harness." This iteration attacks all three.

Concrete plan:

- Extract every `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` from `packages/db/src/schema-management.ts` into ordered SQL files under `packages/db/migrations/`.
- Configure `drizzle.config.ts` to point at the new migrations directory.
- Add `db:migrate` script to `packages/db/package.json` that runs `drizzle-kit migrate`.
- Add a root `pnpm migrate` script that delegates to `pnpm --filter @janusly/db db:migrate`.
- Replace the runtime `runSchemaSync` call in `apps/api/src/index.ts` with a check that the migrations table is present (fail-fast otherwise), and document that `pnpm migrate` runs before the API starts.
- Update `scripts/run-e2e.mjs` to call `pnpm migrate` after Compose is ready, before booting api/worker/web.

Logical commits (mental organization only — not executed):
- chore(db): add migrations folder + drizzle.config + scripts
- refactor(api): swap runSchemaSync for migrations table presence check
- chore(scripts): wire pnpm migrate into run-e2e harness

Files to create or modify:
- packages/db/migrations/0001_init.sql (new)
- packages/db/migrations/0002_audit_logs.sql (new)
- packages/db/migrations/0003_dlq_and_routing.sql (new)
- packages/db/drizzle.config.ts (new or modified)
- packages/db/package.json (add db:migrate)
- package.json (root, add pnpm migrate alias)
- packages/db/src/schema-management.ts (delete or shrink to assert-only)
- apps/api/src/index.ts (replace runSchemaSync call)
- scripts/run-e2e.mjs (call pnpm migrate before API boot)
- packages/db/src/migrations.test.ts (new — round-trip test against a temp database)

Edge-case tests:
- Empty database: `pnpm migrate` from clean Compose creates every table + index.
- Re-run idempotency: a second `pnpm migrate` is a no-op (drizzle-kit handles the migrations table).
- Partial state: when migration N is committed but N+1 is not, the API refuses to start with a clear error.
- E2E: full Compose-up + migrate + suite passes end-to-end.

Coupled invariants at risk:
- Engine atomicity: the migrations must keep the existing schema for `runs`, `run_nodes`, `dead_letters`, and `routing_stats` byte-for-byte. Any column rename in a migration would break `tryClaimNodeForQueue` or `startRun`.
- Audit log: `audit_logs` schema preserved exactly.
- Compose lifecycle: the e2e harness already brings Compose down at the end; the new migrate step runs between `up` and the suite, so the existing `down` still fires.

docs/PLAN.md reference: §10.2 Build / DX (line about formal migrations) and §11 Phase 1 (Drizzle migrations are listed as a Phase 1 deliverable).

Risks / open questions:
- Renaming `schema-management.ts` may collide with current imports in the engine boot path. Will grep before deleting.
- ENG-015 (GitHub Actions CI) will need to call `pnpm migrate` in the test job. That ticket is Pending; no change needed here, but the new script keeps it ready.

Time estimate: 4-6 hours.

Constraints understood: AGENTS.md, ENG-008 AC, this prompt.
