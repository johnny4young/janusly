-- Playbooks, replay campaigns, drills: evidencia y remediación guiada.

-- name: ListReplayCampaignDeadLetters :many
SELECT id, run_id, node_id, status, error_json, node_json
FROM dead_letters
WHERE org_id = $1 AND id = ANY(sqlc.arg(ids)::text[]);

-- name: InsertReplayCampaign :exec
INSERT INTO replay_campaigns (id, org_id, name, cluster_signature, filter_json,
                              pacing_ms, total_count, created_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8);

-- name: InsertReplayCampaignItem :exec
INSERT INTO replay_campaign_items (id, org_id, campaign_id, dead_letter_id, position)
VALUES ($1, $2, $3, $4, $5);

-- name: GetReplayCampaign :one
SELECT * FROM replay_campaigns WHERE org_id = $1 AND id = $2;

-- name: ListReplayCampaignItems :many
SELECT * FROM replay_campaign_items
WHERE org_id = $1 AND campaign_id = $2
ORDER BY position;

-- name: ListReplayCampaigns :many
SELECT * FROM replay_campaigns
WHERE org_id = $1
ORDER BY created_at DESC
LIMIT $2;

-- name: CancelPendingReplayCampaignItems :execrows
UPDATE replay_campaign_items SET status = 'cancelled', completed_at = now()
WHERE org_id = $1 AND campaign_id = $2 AND status = 'pending';

-- name: SettleReplayCampaignItem :execrows
UPDATE replay_campaign_items
SET status = sqlc.arg(status), error = sqlc.arg(error), completed_at = now()
WHERE id = sqlc.arg(id) AND claim_token = sqlc.arg(claim_token) AND status = 'processing';

-- name: BumpReplayCampaignCounter :exec
UPDATE replay_campaigns
SET replayed_count = replayed_count + sqlc.arg(replayed)::int,
    failed_count = failed_count + sqlc.arg(failed)::int,
    updated_at = now()
WHERE id = $1;

-- name: CompleteReplayCampaignIfExhausted :one
UPDATE replay_campaigns
SET status = 'completed', completed_at = now(), updated_at = now()
WHERE replay_campaigns.id = $1 AND replay_campaigns.status = 'running'
  AND NOT EXISTS (
    SELECT 1 FROM replay_campaign_items i
    WHERE i.campaign_id = $1 AND i.status IN ('pending', 'processing'))
RETURNING *;

-- name: GetRecoveryPlaybook :one
SELECT * FROM recovery_playbooks WHERE org_id = $1 AND id = $2;

-- name: FindMatchingActivePlaybook :one
SELECT * FROM recovery_playbooks
WHERE org_id = $1 AND workflow_id = $2 AND signature = $3 AND status = 'active';

-- name: FindPlaybookBySourceVersion :one
SELECT * FROM recovery_playbooks
WHERE org_id = $1 AND source_workflow_version_id = $2;

-- name: MaxPlaybookVersion :one
SELECT COALESCE(max(version), 0)::int FROM recovery_playbooks
WHERE org_id = $1 AND signature = $2;

-- name: InsertRecoveryPlaybookDraft :exec
INSERT INTO recovery_playbooks (id, org_id, workflow_id, signature, version, status, title,
  instructions_markdown, evidence_requirements_json, source_workflow_version_id, approach_label,
  last_validated_at, last_validation_run_id, created_by, updated_by)
VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, $8, $9, $10, now(), $11, $12, $12);

-- name: RetirePreviousActivePlaybookMatch :execrows
UPDATE recovery_playbooks
SET status = 'retired', retired_at = now(), updated_at = now(), updated_by = sqlc.arg(actor)
WHERE org_id = $1 AND workflow_id = $2 AND signature = $3 AND status = 'active' AND id <> sqlc.arg(exclude_id);

-- name: ActivateDraftPlaybook :execrows
UPDATE recovery_playbooks
SET status = 'active', activated_at = now(), retired_at = NULL, updated_at = now(), updated_by = sqlc.arg(actor)
WHERE org_id = $1 AND id = $2 AND status = 'draft';

-- name: RetireRecoveryPlaybook :execrows
UPDATE recovery_playbooks
SET status = 'retired', retired_at = now(), updated_at = now(), updated_by = sqlc.arg(actor)
WHERE org_id = $1 AND id = $2 AND status <> 'retired';

-- name: RecordPlaybookValidationSuccess :execrows
UPDATE recovery_playbooks
SET last_validated_at = now(), last_validation_run_id = sqlc.arg(validation_run_id), updated_at = now()
WHERE org_id = $1 AND id = $2 AND status <> 'retired';

-- name: RecordPlaybookValidationRegression :execrows
UPDATE recovery_playbooks
SET status = 'retired', retired_at = now(), regressions = regressions + 1, updated_at = now()
WHERE org_id = $1 AND id = $2 AND status <> 'retired';

-- name: RecordPlaybookApplied :execrows
UPDATE recovery_playbooks
SET successful_uses = successful_uses + 1,
    last_applied_validation_run_id = sqlc.arg(validation_run_id), updated_at = now()
WHERE org_id = $1 AND id = $2
  AND (last_applied_validation_run_id IS NULL OR last_applied_validation_run_id <> sqlc.arg(validation_run_id));

-- name: ListDrillRootDeadLetters :many
SELECT id FROM dead_letters
WHERE org_id = $1 AND replay_claimed_at IS NOT NULL
ORDER BY created_at DESC LIMIT 50;
