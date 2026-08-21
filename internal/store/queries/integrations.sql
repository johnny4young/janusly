-- Credentials/secret store, MCP, Slack, external runtimes, upstream, triggers.

-- name: InsertTriggerEvent :execrows
INSERT INTO trigger_events (id, org_id, trigger_type, workflow_id,
                            workflow_version_id, node_id, status, dedupe_key, payload_json,
                            workflow_rollout_id, workflow_rollout_variant)
VALUES ($1, $2, $3, $4, $5, $6, 'received', $7, $8, $9, $10)
ON CONFLICT (org_id, dedupe_key) DO NOTHING;

-- name: FindTriggerEventByDedupe :one
SELECT id, org_id, trigger_type, workflow_id, workflow_version_id, node_id,
       status, run_id, dedupe_key, payload_json, skipped_reason, created_at
FROM trigger_events
WHERE org_id = $1 AND dedupe_key = $2;

-- name: GetTriggerEvent :one
SELECT id, org_id, trigger_type, workflow_id, workflow_version_id, node_id,
       status, run_id, dedupe_key, payload_json, skipped_reason, created_at
FROM trigger_events
WHERE org_id = $1 AND id = $2;

-- name: MarkTriggerEventOutcome :execrows
UPDATE trigger_events
SET status = $3, skipped_reason = $4
WHERE org_id = $1 AND id = $2 AND status = 'received';

-- name: GetMcpConnectionByAlias :one
SELECT * FROM mcp_connections WHERE org_id = $1 AND alias = $2;

-- name: InsertMcpConnection :exec
INSERT INTO mcp_connections (id, org_id, alias, transport, command, args, url, env_refs, enabled, status, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11);

-- name: GetMcpToolDescriptor :one
SELECT * FROM mcp_tool_descriptors WHERE connection_id = $1 AND name = $2;

-- name: UpsertMcpToolDescriptor :exec
INSERT INTO mcp_tool_descriptors (id, connection_id, name, description, input_schema, write_side, enabled, rate_limit_per_min)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (connection_id, name) DO UPDATE SET
  description = EXCLUDED.description,
  input_schema = EXCLUDED.input_schema,
  updated_at = now();

-- name: ListMcpToolDescriptorsByConnection :many
SELECT * FROM mcp_tool_descriptors WHERE connection_id = $1 ORDER BY name LIMIT 200;

-- The connections panel only needs counts, and fetching every descriptor
-- row per connection made the listing N+1 in both queries and payload.
-- name: CountMcpToolDescriptorsByConnection :many
SELECT d.connection_id,
       count(*)::int AS total,
       count(*) FILTER (WHERE d.enabled)::int AS enabled
FROM mcp_tool_descriptors d
WHERE d.connection_id = ANY(sqlc.arg(connection_ids)::text[])
GROUP BY d.connection_id;

-- name: SetMcpConnectionStatus :exec
UPDATE mcp_connections
SET status = $3, status_reason = $4, last_discovery_at = $5, updated_at = now()
WHERE org_id = $1 AND id = $2;

-- name: ListExposedMcpToolsForAi :many
SELECT c.alias, d.name, d.description
FROM mcp_connections c
JOIN mcp_tool_descriptors d ON d.connection_id = c.id
WHERE c.org_id = $1 AND c.enabled = true AND c.expose_to_ai = true
  AND d.enabled = true AND d.expose_to_ai = true
ORDER BY c.alias, d.name;

-- name: UpdateMcpToolFlags :one
UPDATE mcp_tool_descriptors
SET enabled = $3, write_side = $4, rate_limit_per_min = $5, expose_to_ai = $6, updated_at = now()
WHERE connection_id = $1 AND name = $2
RETURNING *;

-- name: CountBufferedTriggerEvents :one
SELECT count(*) FROM trigger_events te
WHERE te.org_id = sqlc.arg(org_id) AND te.workflow_id = sqlc.arg(workflow_id) AND te.status = 'buffered'
  AND te.backfill_claim_token IS NULL;

-- name: NextCredentialSecretVersion :one
SELECT (coalesce(max(version), 0) + 1)::int AS next_version
FROM credential_secret_versions
WHERE org_id = $1 AND credential_id = $2;

-- name: InsertCredentialSecretVersion :exec
INSERT INTO credential_secret_versions (id, org_id, credential_id, version, ciphertext,
  data_nonce, data_tag, wrapped_key, wrap_nonce, wrap_tag, key_version, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12);

-- name: GetCredentialSecretVersion :one
SELECT id, org_id, credential_id, version, ciphertext, data_nonce, data_tag,
       wrapped_key, wrap_nonce, wrap_tag, key_version
FROM credential_secret_versions
WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL;

-- name: RevokeCredentialSecretVersion :exec
UPDATE credential_secret_versions SET revoked_at = now()
WHERE id = $1 AND org_id = $2 AND revoked_at IS NULL;

-- name: GetCredentialByName :one
SELECT * FROM credentials WHERE org_id = $1 AND kind = $2 AND name = $3;

-- name: InsertCredential :exec
INSERT INTO credentials (id, org_id, name, kind, secret_ref, created_by)
VALUES ($1, $2, $3, $4, $5, $6);

-- name: UpdateCredentialSecretRef :exec
UPDATE credentials SET secret_ref = sqlc.arg(secret_ref), updated_at = now()
WHERE org_id = $1 AND id = $2;

-- name: ListCredentials :many
SELECT id, org_id, name, kind, secret_ref, metadata, created_by, created_at, updated_at, expires_at
FROM credentials WHERE org_id = $1 ORDER BY name LIMIT 500;

-- name: GetCredentialByOrgName :one
SELECT id, org_id, name, kind, secret_ref, updated_at, expires_at
FROM credentials WHERE org_id = $1 AND name = $2;

-- name: LockCredentialByName :one
SELECT id, kind, secret_ref, updated_at FROM credentials
WHERE org_id = $1 AND name = $2 FOR UPDATE;

-- name: RotateCredentialSecretRefCAS :one
UPDATE credentials SET secret_ref = sqlc.arg(new_secret_ref), updated_at = now()
WHERE org_id = $1 AND name = $2 AND updated_at = sqlc.arg(if_match)
RETURNING updated_at;

-- name: DeleteCredential :execrows
DELETE FROM credentials WHERE org_id = $1 AND id = $2;

-- name: SetCredentialExpiry :one
UPDATE credentials SET expires_at = sqlc.narg(expires_at), updated_at = now()
WHERE org_id = $1 AND name = $2
  AND (sqlc.narg(if_match)::timestamptz IS NULL OR updated_at = sqlc.narg(if_match))
RETURNING updated_at;

-- name: ListCredentialUsageRows :many
SELECT metadata ->> 'credentialName' AS credential_name, created_at,
       coalesce((metadata ->> 'ok')::bool, true) AS ok, metadata ->> 'error' AS error_message
FROM usage_events
WHERE org_id = $1 AND created_at >= $2
  AND metric LIKE 'tool.%' AND metadata ? 'credentialName'
ORDER BY created_at DESC
LIMIT 10000;

-- name: ListMcpConnectionsForHealth :many
SELECT id, alias, transport, env_refs, enabled, status FROM mcp_connections
WHERE org_id = $1 ORDER BY alias LIMIT 200;

-- name: InsertCredentialFull :exec
INSERT INTO credentials (id, org_id, name, kind, secret_ref, metadata, expires_at, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8);

-- name: InsertSlackInteractionConnection :exec
INSERT INTO slack_interaction_connections (id, org_id, name, team_id, signing_credential_name,
  user_mappings, enabled, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8);

-- name: ListSlackInteractionConnections :many
SELECT * FROM slack_interaction_connections WHERE org_id = $1 ORDER BY name LIMIT 100;

-- name: GetSlackInteractionConnection :one
SELECT * FROM slack_interaction_connections WHERE org_id = $1 AND id = $2;

-- name: GetSlackInteractionConnectionForCallback :one
SELECT * FROM slack_interaction_connections WHERE id = $1;

-- name: UpdateSlackInteractionConnection :execrows
UPDATE slack_interaction_connections
SET name = $3, team_id = $4, signing_credential_name = $5, user_mappings = $6,
    enabled = $7, updated_at = now()
WHERE org_id = $1 AND id = $2;

-- name: DeleteSlackInteractionConnection :execrows
DELETE FROM slack_interaction_connections WHERE org_id = $1 AND id = $2;

-- name: PurgeExpiredSlackReceipts :exec
DELETE FROM slack_interaction_receipts
WHERE org_id = $1 AND connection_id = $2 AND created_at < $3;

-- name: InsertSlackInteractionReceipt :execrows
INSERT INTO slack_interaction_receipts (id, org_id, connection_id)
VALUES ($1, $2, $3)
ON CONFLICT (id) DO NOTHING;

-- name: InsertUpstreamHealthSource :one
INSERT INTO upstream_health_sources (id, org_id, name, kind, url,
                                     expected_components, check_interval_seconds,
                                     enabled, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
RETURNING *;

-- name: ListUpstreamHealthSources :many
SELECT * FROM upstream_health_sources
WHERE org_id = $1
ORDER BY lower(name);

-- name: GetUpstreamHealthSource :one
SELECT * FROM upstream_health_sources
WHERE org_id = $1 AND id = $2;

-- Claim-to-poll: the due check reads last_checked_at and the poller only
-- writes it AFTER fetching, so every replica polled every due source.
-- Stamping the clock inside the claim makes the sweep exclusive without a
-- lock — the loser simply sees a source that is no longer due.
-- name: ClaimDueUpstreamHealthSources :many
UPDATE upstream_health_sources SET last_checked_at = now()
FROM (
  SELECT due.id FROM upstream_health_sources AS due
  WHERE due.enabled = true
    AND (due.last_checked_at IS NULL
         OR due.last_checked_at <= now() - make_interval(secs => due.check_interval_seconds))
  ORDER BY due.last_checked_at NULLS FIRST
  LIMIT sqlc.arg(row_limit)
  FOR UPDATE SKIP LOCKED
) AS claimed
WHERE upstream_health_sources.id = claimed.id
RETURNING upstream_health_sources.*;

-- name: UpdateUpstreamHealthSource :one
UPDATE upstream_health_sources
SET name = $3, kind = $4, url = $5, expected_components = $6,
    check_interval_seconds = $7, enabled = $8, updated_at = now()
WHERE org_id = $1 AND id = $2
RETURNING *;

-- name: DeleteUpstreamHealthSource :one
DELETE FROM upstream_health_sources
WHERE org_id = $1 AND id = $2
RETURNING *;

-- name: RecordUpstreamStatus :exec
UPDATE upstream_health_sources
SET last_status = $3, last_degraded = $4, last_checked_at = now(),
    last_error_reason = NULL, updated_at = now()
WHERE org_id = $1 AND id = $2;

-- name: RecordUpstreamPollError :exec
UPDATE upstream_health_sources
SET last_checked_at = now(), last_error_reason = $3, updated_at = now()
WHERE org_id = $1 AND id = $2;

-- name: PauseWorkflowsForUpstream :many
UPDATE workflows
SET status = 'paused_upstream_degraded', paused_reason = $3
WHERE org_id = $1 AND id = ANY($2::text[]) AND status = 'active'
RETURNING id;

-- name: ResumeWorkflowsForUpstream :many
UPDATE workflows
SET status = 'active', paused_reason = NULL
WHERE org_id = $1 AND id = ANY($2::text[]) AND status = 'paused_upstream_degraded'
RETURNING id;

-- name: ListMcpConnections :many
SELECT * FROM mcp_connections WHERE org_id = $1 ORDER BY alias ASC LIMIT 200;
