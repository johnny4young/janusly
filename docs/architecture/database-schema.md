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
