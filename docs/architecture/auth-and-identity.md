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

WorkOS SSO and SCIM webhook handling are signed, idempotent, and audited.
Production behavior is selected only by `JANUSLY_ENV=production`.
