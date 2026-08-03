-- Revocable browser sessions. The signed cookie contains only the id; every
-- authenticated request resolves the live row before membership authorization.

-- name: CreateAuthSession :one
INSERT INTO auth_sessions (id, user_id, email, org_id, expires_at)
VALUES (
  sqlc.arg(id),
  sqlc.arg(user_id),
  lower(btrim(sqlc.arg(email)::text)),
  sqlc.arg(org_id),
  sqlc.arg(expires_at)
)
RETURNING id, user_id, email, org_id, expires_at, revoked_at, created_at, updated_at;

-- name: GetActiveAuthSession :one
SELECT id, user_id, email, org_id, expires_at, revoked_at, created_at, updated_at
FROM auth_sessions
WHERE id = $1
  AND revoked_at IS NULL
  AND expires_at > now();

-- name: RevokeAuthSession :execrows
UPDATE auth_sessions
SET revoked_at = now(), updated_at = now()
WHERE id = $1 AND revoked_at IS NULL;

-- name: UpdateAuthSessionOrganization :one
UPDATE auth_sessions
SET org_id = $3, updated_at = now()
WHERE id = $1
  AND user_id = $2
  AND revoked_at IS NULL
  AND expires_at > now()
RETURNING id, user_id, email, org_id, expires_at, revoked_at, created_at, updated_at;
