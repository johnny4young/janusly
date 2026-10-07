-- Consent readers lock a stable, small key set before registration. Config
-- writers and the revocation trigger cannot overtake an admitted insertion.
-- name: LockAuthoringExperienceConsent :many
SELECT key, value_json FROM org_configs
WHERE org_id = $1 AND key IN ('ai.authoringExperienceEnabled','memory.enabled','memory.allowedKinds','memory.retentionDaysByKind')
ORDER BY key FOR SHARE;

-- name: GetAuthoringExperienceVersion :one
SELECT v.id, v.version, v.dag_json, v.created_at
FROM workflow_versions v JOIN workflows w ON w.org_id=v.org_id AND w.id=v.workflow_id
WHERE v.org_id=$1 AND v.workflow_id=$2 AND v.id=$3 AND w.deleted_at IS NULL
  AND v.created_at <= sqlc.arg(as_of)::timestamptz
  AND octet_length(v.dag_json::text) <= 2097152
FOR SHARE OF w, v;

-- name: InsertAuthoringExperience :one
INSERT INTO authoring_experiences
(id,org_id,workflow_id,workflow_version_id,brief_key,brief_json,policy_version,registered_at,retain_until,created_by)
SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10
WHERE octet_length($6::jsonb::text) <= 8192
ON CONFLICT (org_id,workflow_id,workflow_version_id,brief_key,policy_version) WHERE revoked_at IS NULL
DO UPDATE SET id = authoring_experiences.id
RETURNING *;

-- Expired active rows no longer prevent a fresh explicit registration. Never
-- extend a still-active entry's deadline by merely submitting it again.
-- name: DeleteExpiredAuthoringExperienceSource :exec
DELETE FROM authoring_experiences
WHERE org_id=$1 AND workflow_id=$2 AND workflow_version_id=$3 AND brief_key=$4
  AND retain_until <= sqlc.arg(as_of)::timestamptz;

-- name: ListAuthoringExperiences :many
SELECT e.id,e.workflow_id,e.workflow_version_id,v.version,e.policy_version,e.registered_at,e.retain_until
FROM authoring_experiences e
JOIN workflow_versions v ON v.org_id=e.org_id AND v.workflow_id=e.workflow_id AND v.id=e.workflow_version_id
JOIN workflows w ON w.org_id=e.org_id AND w.id=e.workflow_id
WHERE e.org_id=$1 AND e.workflow_id=$2 AND e.revoked_at IS NULL AND w.deleted_at IS NULL
  AND e.schema_version='1' AND e.policy_version='authoring-experience-v1'
  AND e.registered_at <= sqlc.arg(as_of)::timestamptz AND v.created_at <= sqlc.arg(as_of)::timestamptz
  AND e.retain_until > sqlc.arg(as_of)::timestamptz
ORDER BY e.registered_at DESC,e.id DESC
LIMIT sqlc.arg(row_limit);

-- Only an active row transitions; repeat withdrawals keep the first timestamp
-- and report no transition so callers audit a revocation exactly once.
-- name: RevokeAuthoringExperience :execrows
UPDATE authoring_experiences SET revoked_at=sqlc.arg(as_of)::timestamptz
WHERE org_id=$1 AND id=$2 AND revoked_at IS NULL;

-- name: AuthoringExperienceExists :one
SELECT EXISTS (SELECT 1 FROM authoring_experiences WHERE org_id=$1 AND id=$2);

-- One bounded batch rides the existing retention loop. Physical removal is
-- independent of the immediate eligibility/consent fence.
-- name: PurgeAuthoringExperiencesBatch :execrows
DELETE FROM authoring_experiences WHERE id IN (
 SELECT id FROM authoring_experiences
 WHERE retain_until <= sqlc.arg(as_of)::timestamptz
    OR revoked_at <= sqlc.arg(revoked_before)::timestamptz
 ORDER BY retain_until,id FOR UPDATE SKIP LOCKED LIMIT sqlc.arg(batch_size)
);

-- name: PurgeAuthoringExperiencesForOrg :execrows
DELETE FROM authoring_experiences WHERE org_id=$1;

-- Temporal eligibility precedes the bounded source-work horizon. Historical
-- reads consume an explicit frozen consent snapshot at the caller; current
-- config is not proof of past consent. Live reads reject any tombstone.
-- name: FindAuthoringExperienceCandidates :many
SELECT e.id,e.org_id,e.workflow_id,e.workflow_version_id,v.version,e.brief_key,e.policy_version,
       e.registered_at,v.created_at AS version_created_at,e.retain_until,e.revoked_at,w.deleted_at,v.dag_json
FROM authoring_experiences e
JOIN workflow_versions v ON v.org_id=e.org_id AND v.workflow_id=e.workflow_id AND v.id=e.workflow_version_id
JOIN workflows w ON w.org_id=e.org_id AND w.id=e.workflow_id
WHERE e.org_id=$1 AND e.brief_key=$2
  AND e.schema_version='1' AND e.policy_version='authoring-experience-v1'
  AND e.registered_at <= sqlc.arg(as_of)::timestamptz AND v.created_at <= sqlc.arg(as_of)::timestamptz
  AND e.retain_until > sqlc.arg(as_of)::timestamptz
  AND (e.revoked_at IS NULL OR (sqlc.arg(historical)::boolean AND e.revoked_at > sqlc.arg(as_of)::timestamptz))
  AND (w.deleted_at IS NULL OR (sqlc.arg(historical)::boolean AND w.deleted_at > sqlc.arg(as_of)::timestamptz))
  AND octet_length(v.dag_json::text) <= 2097152
ORDER BY e.registered_at DESC,e.id COLLATE "C" DESC
LIMIT sqlc.arg(row_limit)
FOR SHARE OF e,w,v;

-- Resolution serializes against registration as well as consent writers.
-- Taking this mode initially avoids lock-upgrade deadlocks between resolvers.
-- name: LockAuthoringExperienceResolveConsent :many
SELECT key, value_json FROM org_configs
WHERE org_id = $1 AND key IN ('ai.authoringExperienceEnabled','memory.enabled','memory.allowedKinds','memory.retentionDaysByKind')
ORDER BY key FOR UPDATE;
