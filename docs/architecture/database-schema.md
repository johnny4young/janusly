# Database schema

Janusly supports PostgreSQL 18 only. The complete fresh-install schema lives in
`internal/migrate/sql/00001_baseline.sql`; migration state lives in
`janusly_schema_version`.

The runtime does not upgrade databases created by another schema generation.
Startup checks schema completeness before opening public listeners. Running
`janusly migrate` twice is safe.

`schema.sql` is generated from an empty migrated database and drives SQLC.
Queries live in `internal/store/queries`, generated types and methods live in
`internal/store`, and higher layers use organization-scoped store methods.

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
