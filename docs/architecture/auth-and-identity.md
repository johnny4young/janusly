# Authentication and identity

`internal/auth` resolves one `AuthContext` for each request. Human identity may
come from Supabase or a WorkOS browser session; automation may use a service
token; local development may use explicit headers when policy allows it.

The organization hint selects a candidate scope. Authority comes from the
resolved `org_members` grant. Every handler scopes reads and writes by the
resolved organization.

Supabase email links return an implicit-grant session in the URL fragment.
`web/src/auth-callback.ts` captures it at boot, before the hash router writes
the fragment, and removes it with `replaceState` so the token leaves both the
URL and session history. Nothing ties a link to a sign-in this browser started,
so sign-in needs consent: the token is checked against the auth server, and
`AuthCallbackGate` asks "Continue as <email>?" before the app mounts. Only then
does `getSupabaseClient()` adopt the tokens with `setSession`, including over an
existing session; `detectSessionInUrl` stays off. A rejected or expired link
shows one fixed login message; the link's own error text is never rendered. An
active WorkOS session outranks the callback, which is discarded.
A recovery or invite link (`type` in the fragment) then requires a new password
before the app mounts. The session is adopted first, so a failed update leaves
the user signed in with the form and a fixed message, and a user id in
`localStorage` (`janusly:passwordSetupUser`) keeps the step across reloads. It
clears on a saved password, a password sign-in, a sign-out, or a session for
another user. The API accepts the session either way, so this step is a flow
control, not an authorization boundary.
Login requests a recovery link with `resetPasswordForEmail`, redirecting to
`window.location.origin`. That origin must share a hostname with the Supabase
site URL or match an allow-list entry exactly, with no trailing slash; otherwise
the auth server still answers 200 and silently links to the site URL. A sent
link and a 429 other than `over_request_rate_limit` read the same, because the
per-user and hourly email limits only fire for an existing account. Past the hourly limit
(`email_sent`) a user sees that confirmation with no email, so size it for
expected recovery volume. A direct `/recover` caller can still see the
difference; the client cannot close it.
Browsers record the navigation in their visited-URL list before any page code
runs, so an implicit-grant token can remain there; no client code can remove it.

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

Agent client tokens (`jly_agent_…`) authenticate only the MCP surface. The
general resolver refuses them before any provider, so an agent token sent to
an API route is never forwarded to the identity provider. An agent acts for
the member who created it: its permissions are its capability ceiling
intersected with that member's current grant (`mcp-server.md`).

WorkOS SSO and SCIM webhook handling are signed, idempotent, and audited.
Production behavior is selected only by `JANUSLY_ENV=production`.
