-- WorkOS SSO connection metadata, one-time callback nonces, and the narrow
-- three-key auth-policy read. Every tenant query carries org_id; rows remain
-- orphan-tolerant by the repository-wide no-FK policy.

-- name: FindSsoConnectionForOrg :one
SELECT id, org_id, provider, provider_connection_id, status, enforced_sso,
       config_json, created_at, updated_at
FROM sso_connections
WHERE org_id = $1 AND provider = 'workos'
LIMIT 1;

-- name: ListSsoConnections :many
SELECT id, org_id, provider, provider_connection_id, status, enforced_sso,
       config_json, created_at, updated_at
FROM sso_connections
WHERE org_id = $1
ORDER BY provider, id
LIMIT 20;

-- name: GetSsoConnectionByID :one
SELECT id, org_id, provider, provider_connection_id, status, enforced_sso,
       config_json, created_at, updated_at
FROM sso_connections
WHERE id = $1 AND org_id = $2;

-- name: CreateSsoConnection :one
INSERT INTO sso_connections (
  id, org_id, provider, provider_connection_id, status, enforced_sso
) VALUES ($1, $2, $3, $4, 'active', $5)
RETURNING id, org_id, provider, provider_connection_id, status, enforced_sso,
          config_json, created_at, updated_at;

-- name: UpdateSsoConnection :one
UPDATE sso_connections
SET status = coalesce(sqlc.narg(status)::text, status),
    enforced_sso = coalesce(sqlc.narg(enforced_sso)::boolean, enforced_sso),
    provider_connection_id = coalesce(sqlc.narg(provider_connection_id)::text, provider_connection_id),
    updated_at = now()
WHERE id = sqlc.arg(id) AND org_id = sqlc.arg(org_id)
RETURNING id, org_id, provider, provider_connection_id, status, enforced_sso,
          config_json, created_at, updated_at;

-- name: RevokeSsoConnection :one
UPDATE sso_connections
SET status = 'revoked', updated_at = now()
WHERE id = $1 AND org_id = $2
RETURNING id, org_id, provider, provider_connection_id, status, enforced_sso,
          config_json, created_at, updated_at;

-- name: RecordSsoNonce :exec
INSERT INTO sso_state_nonces (id, org_id, nonce, expires_at)
VALUES ($1, $2, $3, $4);

-- The WorkOS profile id is the durable membership key. First login
-- provisions a viewer; a returning login refreshes the verified email
-- but MUST NOT touch the role — overwriting it would silently demote
-- members promoted via /members/role or SCIM (and could lock an org
-- out of its only admin).
-- name: UpsertSsoMembership :exec
INSERT INTO org_members (id, org_id, user_id, email, role, invited_by)
VALUES ($1, $2, $3, $4, 'viewer', NULL)
ON CONFLICT (org_id, user_id) DO UPDATE
SET email = EXCLUDED.email;

-- DELETE ... RETURNING is the single-use claim: exactly one concurrent
-- callback can consume a live nonce; expired rows never authorize a login.
-- name: ConsumeSsoNonce :one
DELETE FROM sso_state_nonces
WHERE org_id = $1 AND nonce = $2 AND expires_at > now()
RETURNING id;

-- name: ListAuthPolicyConfigRows :many
SELECT key, value_json
FROM org_configs
WHERE org_id = $1
  AND key IN ('auth.allowedEmailDomains', 'auth.mfaRequired', 'auth.sessionTtlSeconds')
ORDER BY key
LIMIT 3;
