# Authentication and identity

`internal/auth` resolves one `AuthContext` for each request. Human identity may
come from Supabase or a WorkOS browser session; automation may use a service
token; local development may use explicit headers when policy allows it.

The organization hint selects a candidate scope. Authority comes from the
resolved `org_members` grant. Every handler scopes reads and writes by the
resolved organization.

Authorization has two layers: minimum role rank and a closed permission
catalog. When both are configured, both must pass. Custom roles derive a rank
and a bounded permission set from organization-owned configuration.

Every organization has one durable `owner_user_id`, created atomically with
the founder's built-in `admin` membership. Owner is authority metadata, not a
fourth mutable role: admins can be delegated normally, but no human, SSO, or
SCIM path can demote, re-key, or remove the owner membership. Only the current
owner can transfer ownership to an existing member; transfer promotes that
member to built-in `admin` in the same audited transaction and leaves the
previous owner as an admin.

Member invitations are one governed lifecycle per organization and normalized
email. Create, accept, and revoke derive the same transaction-scoped PostgreSQL
advisory key before taking row locks, so concurrent requests have one winner.
An accepted or revoked row may be reactivated with a fresh opaque invitation id
after membership checks pass; an already-pending row remains a bounded `409`.
The current-row record is replaced on reactivation while immutable audit events
preserve the lifecycle history.

WorkOS SSO and SCIM webhook handling are signed, idempotent, and audited.
Production behavior is selected only by `JANUSLY_ENV=production`.
