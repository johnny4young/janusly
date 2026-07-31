# Database Schema Architecture

Janusly's PostgreSQL schema is one public graph composed from bounded-context
modules. The split is an internal maintainability boundary: it must never
change table identity, generated SQL, migration order, or the imports used by
application code.

## Sources of truth

- `packages/db/src/schema/<domain>.ts` — table and index declarations grouped
  by bounded context.
- `packages/db/src/schema.ts` — side-effect-free compatibility barrel consumed
  by Drizzle Kit and schema contract tests.
- `packages/db/src/index.ts` — process-wide database client plus the public
  `@janusly/db` re-export. Importing it creates the singleton connection pool.
- `packages/db/migrations/` — generated, reviewed migration history and
  snapshots.
- `packages/db/src/schema-contract.test.ts` — declared table, column, default,
  primary-key, and index parity with the latest migration snapshot.
- `packages/db/src/schema-modules.test.ts` — module completeness, uniqueness,
  and reference identity through the compatibility barrel.
- `scripts/local-backup.mjs` — source-level table inventory for portable local
  backups; it reads every domain module and fails closed on an empty or
  duplicate inventory before deciding which live tables to exclude.

The domain modules are:

| Module | Ownership |
| --- | --- |
| `tenancy.ts` | Organizations, users, memberships, tenant config, roles, audit, and onboarding |
| `identity.ts` | SSO, sessions, verified domains, and SCIM synchronization |
| `workflows.ts` | Workflow authoring, versions, rollout evidence, schedules, metadata, snippets, and triggers |
| `executions.ts` | Runs, run nodes/events, routing statistics, improvements, and usage accounting |
| `recovery.ts` | Recovery cases, DLQ, replay, impact, playbooks, supervised repair, alerts, and recovery work |
| `integrations.ts` | Credentials, Slack actions, external-runtime shadows, plugins, and MCP connections |
| `ai.ts` | PromptOps, memory, evaluation datasets, experiments, and calibration |

## Import boundaries

Application and repository code imports tables from `@janusly/db`. It must not
deep-import a domain module merely to shorten an import list. This keeps table
object identity stable and preserves one place to initialize the database
client.

Schema domain modules import only Drizzle declaration primitives. They do not
import `../index.ts`, `../schema.ts`, another schema domain, or application
code. Janusly deliberately has no foreign-key declarations: retained workflow,
run, audit, and recovery evidence may outlive its parent resource. Tenancy is
enforced in repositories and runtime transactions instead.

## Changing the schema

1. Add or change the declaration in the owning `schema/<domain>.ts` module.
2. Keep every timestamp timezone-aware. Tenant-owned tables must carry a
   non-null `org_id` unless an architecture decision explicitly changes that
   contract.
3. Run `pnpm --filter @janusly/db test` and `pnpm --filter @janusly/db
   typecheck`.
4. Run `pnpm --filter @janusly/db db:generate` and review the generated SQL and
   snapshot. A pure refactor must report `No schema changes, nothing to
   migrate`.
5. For hot-path indexes, keep the generated transactional migration plus the
   reviewed sibling `production-rollout.sql` with the concurrent production
   command described in `AGENTS.md`.
6. Run the repository's complete unit, integration, build, lint, and smoke
   gates before committing.

Never hand-write a normal table migration, add runtime `CREATE TABLE IF NOT
EXISTS`, instantiate another connection pool, or export one table from more
than one domain module.
