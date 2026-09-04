# Database schema

Janusly supports PostgreSQL 18 only. The complete fresh-install schema lives in
`internal/migrate/sql/00001_baseline.sql`; migration state lives in
`janusly_schema_version`.

The runtime does not upgrade databases created by another schema generation.
Startup checks schema completeness before opening public listeners. Running
`janusly migrate` twice is safe.

`schema.sql` is generated from an empty migrated database and drives SQLC:
`scripts/verify-isolated.sh schema` (or `make schema` against a migrated Compose
project) writes it, `make verify` regenerates it and fails on drift, and it is
never edited by hand — a schema change is an edit to the baseline migration
followed by that regeneration.
Queries live in `internal/store/queries`, generated types and methods live in
`internal/store`, and higher layers use organization-scoped store methods.

Every workflow-version append (save, rollback, and solution-pack import) locks
the active parent and commits the parent name, next immutable version,
inherited SLO, optionally replaced upstream declarations, and PostgreSQL
schedule-entry replacement in one transaction. SLO mutation remains the
separate admin-only chokepoint; an editor save can inherit but cannot replace
it. The parent lock is shared with rollout creation, so a save
cannot appear behind an active traffic split. Bounded retries handle only the
two known unique-write races; all other database errors fail closed. A rollback
copies the selected DAG exactly but carries the current reliability policy
forward rather than silently restoring an obsolete or empty declaration.
The admin SLO mutation takes the same parent lock before reading and updating
the latest version, so a concurrent save or rollback cannot strand a newly
declared policy on the version that just stopped being latest.

The durable workflow queue uses PostgreSQL rows plus `janusly_wake` and
`janusly_run_events` notifications. Notifications reduce latency but do not
replace polling or durable state.

Best-effort semantic indexing has its own durable queue,
`run_summary_memory_jobs`. `(org_id, run_id)` is the producer idempotency key;
lease tokens protect finalization from stale workers, while a partial unique
index on `memory_entries (org_id, run_id, kind)` is the final `run_summary`
deduplication boundary.

Weekly digest delivery uses `org_digest_state` as a resumable batch rather than
as a pre-send timestamp. Its lease token is the multi-replica claim and
`delivered_recipients` is the per-address receipt set, so provider failures do
not either skip the week or resend addresses that already succeeded.

`organizations.owner_user_id` is the durable organization authority. Database
triggers protect the matching `org_members` row from role/user-id mutation or
deletion across every write path; the HTTP layer adds owner-specific errors and
an audited transactional transfer operation.

`invitations (org_id, email)` is one current lifecycle row, not the immutable
history. The unique key plus a shared transaction advisory lock serializes
create, accept, and revoke. Reactivating an accepted or revoked invitation
replaces its opaque id and resets it to pending; audit rows retain prior
transitions.

## Tenant-scoped substring search

Active workflow name/id and non-validation recovery node id/run id/error-message
substring searches use two partial `pg_trgm` GIN expression indexes from the
fresh baseline. Each expression joins its searchable fields with a control
separator that the HTTP boundary rejects, so one index preserves exact
per-field substring semantics without maintaining five separate GIN indexes.
The partial predicates match the production queries (`deleted_at IS NULL` and
`replay_mode IS NULL`) and avoid indexing tombstones or validation evidence.

The organization-first Btree indexes remain independent and every query still
has a mandatory organization predicate. PostgreSQL may combine tenant and
trigram indexes or apply the organization predicate after a highly selective
trigram lookup; neither plan can cross the tenant boundary.

Search terms are limited to 100 Unicode code points and need one contiguous run
of at least three letters or numbers. This is a performance boundary, not only
input validation: a `LIKE`/`ILIKE` pattern with no extractable trigram can
degenerate to a full-index or table scan. `%`, `_`, and `\` are escaped and
matched literally once the term passes that boundary.
