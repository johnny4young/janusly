-- name: CountUnusedOAuthClients :one
SELECT count(*)::int FROM oauth_clients WHERE last_used_at IS NULL;

-- name: InsertOAuthClient :one
INSERT INTO oauth_clients (id, client_name, redirect_uris, registered_from)
VALUES (sqlc.arg(id), sqlc.arg(client_name), sqlc.arg(redirect_uris)::text[], sqlc.arg(registered_from))
RETURNING *;

-- name: GetOAuthClient :one
SELECT * FROM oauth_clients WHERE id = $1;

-- name: TouchOAuthClient :exec
UPDATE oauth_clients SET last_used_at = now() WHERE id = $1;

-- Registrations nobody used within a day, and requests past their life.
-- name: DeleteUnusedOAuthClients :execrows
DELETE FROM oauth_clients WHERE last_used_at IS NULL AND created_at < sqlc.arg(cutoff)::timestamptz;

-- name: DeleteExpiredOAuthRequests :execrows
DELETE FROM oauth_authorization_requests WHERE expires_at < sqlc.arg(cutoff)::timestamptz;

-- name: InsertOAuthRequest :one
INSERT INTO oauth_authorization_requests (id, oauth_client_id, redirect_uri, code_challenge, scopes, state, resource, expires_at)
VALUES (sqlc.arg(id), sqlc.arg(oauth_client_id), sqlc.arg(redirect_uri), sqlc.arg(code_challenge),
        sqlc.arg(scopes)::text[], sqlc.arg(state), sqlc.arg(resource), sqlc.arg(expires_at))
RETURNING *;

-- name: GetPendingOAuthRequest :one
SELECT r.*, c.client_name FROM oauth_authorization_requests r
JOIN oauth_clients c ON c.id = r.oauth_client_id
WHERE r.id = sqlc.arg(id) AND r.status = 'pending' AND r.expires_at > sqlc.arg(now)::timestamptz;

-- name: ApproveOAuthRequest :one
UPDATE oauth_authorization_requests
SET status = 'approved', org_id = sqlc.arg(org_id), decided_by = sqlc.arg(decided_by),
    agent_client_id = sqlc.arg(agent_client_id), code_digest = sqlc.arg(code_digest), code_expires_at = sqlc.arg(code_expires_at)
WHERE id = sqlc.arg(id) AND status = 'pending' AND expires_at > sqlc.arg(now)::timestamptz
RETURNING *;

-- name: DenyOAuthRequest :one
UPDATE oauth_authorization_requests SET status = 'denied', decided_by = sqlc.arg(decided_by)
WHERE id = sqlc.arg(id) AND status = 'pending' AND expires_at > sqlc.arg(now)::timestamptz
RETURNING *;

-- Locks the request a code names, used or not, so a replay is seen as one.
-- name: LockOAuthRequestByCode :one
SELECT * FROM oauth_authorization_requests WHERE code_digest = $1 FOR UPDATE;

-- name: MarkOAuthCodeUsed :exec
UPDATE oauth_authorization_requests SET code_used_at = sqlc.arg(now) WHERE id = sqlc.arg(id);

-- name: IssueOAuthTokens :one
UPDATE agent_clients
SET token_digest = sqlc.arg(token_digest), token_last4 = sqlc.arg(token_last4),
    access_expires_at = sqlc.arg(access_expires_at), refresh_digest = sqlc.arg(refresh_digest)
WHERE id = sqlc.arg(id) AND oauth_client_id = sqlc.arg(oauth_client_id) AND revoked_at IS NULL
  AND expires_at > sqlc.arg(now)::timestamptz
RETURNING *;

-- name: LockAgentClientByRefresh :one
SELECT * FROM agent_clients WHERE refresh_digest = $1 FOR UPDATE;

-- name: InsertOAuthRefreshHistory :exec
INSERT INTO oauth_refresh_history (digest, agent_client_id, rotated_at)
VALUES (sqlc.arg(digest), sqlc.arg(agent_client_id), sqlc.arg(rotated_at))
ON CONFLICT (digest) DO NOTHING;

-- name: GetOAuthRefreshHistory :one
SELECT h.agent_client_id, h.rotated_at, c.org_id, coalesce(c.oauth_client_id, '')::text AS oauth_client_id
FROM oauth_refresh_history h
JOIN agent_clients c ON c.id = h.agent_client_id
WHERE h.digest = $1;

-- name: DeleteOldOAuthRefreshHistory :execrows
DELETE FROM oauth_refresh_history WHERE rotated_at < sqlc.arg(cutoff)::timestamptz;

-- A grant whose code was never exchanged is ended, so it does not sit in the
-- client list as if it were connected.
-- name: RevokeUnexchangedOAuthClients :execrows
UPDATE agent_clients SET revoked_at = now(), revoked_by = 'oauth:unused'
WHERE oauth_client_id IS NOT NULL AND access_expires_at IS NULL AND revoked_at IS NULL
  AND created_at < sqlc.arg(cutoff)::timestamptz;

-- name: CountPendingOAuthRequests :one
SELECT count(*)::int FROM oauth_authorization_requests
WHERE oauth_client_id = sqlc.arg(oauth_client_id) AND status = 'pending' AND expires_at > sqlc.arg(now)::timestamptz;

-- Makes room for a new registration by dropping one nobody used: first the
-- oldest without a request waiting for consent, else the oldest. One still in
-- its first minutes is a flow in progress and is never evicted.
-- name: EvictOldestUnusedOAuthClient :execrows
DELETE FROM oauth_clients WHERE id = (
  SELECT c.id FROM oauth_clients c
  WHERE c.last_used_at IS NULL AND c.created_at < sqlc.arg(settled_before)::timestamptz
  ORDER BY EXISTS (
      SELECT 1 FROM oauth_authorization_requests r
      WHERE r.oauth_client_id = c.id AND r.status = 'pending' AND r.expires_at > sqlc.arg(now)::timestamptz),
    c.created_at
  LIMIT 1 FOR UPDATE SKIP LOCKED
);

-- name: CountAllPendingOAuthRequests :one
SELECT count(*)::int FROM oauth_authorization_requests WHERE status = 'pending';

-- name: EvictOldestPendingOAuthRequest :exec
DELETE FROM oauth_authorization_requests WHERE id = (
  SELECT id FROM oauth_authorization_requests WHERE status = 'pending' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
);

-- A replayed code or refresh token ends the grant.
-- name: RevokeOAuthAgentClient :execrows
UPDATE agent_clients SET revoked_at = now(), revoked_by = sqlc.arg(revoked_by)::text
WHERE id = sqlc.arg(id) AND oauth_client_id IS NOT NULL AND revoked_at IS NULL;

-- name: MarkAgentClientOAuth :exec
UPDATE agent_clients SET oauth_client_id = sqlc.arg(oauth_client_id)
WHERE org_id = sqlc.arg(org_id) AND id = sqlc.arg(id);
