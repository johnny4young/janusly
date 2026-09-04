-- Schedule entries + due-clock + fire history.

-- name: UpsertScheduleEntry :exec
INSERT INTO schedule_entries (id, org_id, workflow_id, workflow_version_id, node_id,
                              cron_expression, enabled, next_fire_at, created_by)
VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8)
ON CONFLICT (org_id, workflow_version_id, node_id) DO UPDATE SET
  cron_expression = excluded.cron_expression, next_fire_at = excluded.next_fire_at,
  enabled = true, updated_at = now();

-- name: DeleteScheduleEntriesForWorkflow :exec
DELETE FROM schedule_entries WHERE org_id = $1 AND workflow_id = $2;

-- name: DeleteScheduleEntry :exec
DELETE FROM schedule_entries WHERE id = $1;

-- name: AdvanceScheduleEntry :exec
UPDATE schedule_entries
SET next_fire_at = $2, last_run_at = $3,
    last_run_id = CASE WHEN sqlc.arg(last_run_id)::text = '' THEN last_run_id ELSE sqlc.arg(last_run_id)::text END,
    updated_at = now()
WHERE id = $1;

-- name: DisableScheduleEntry :exec
UPDATE schedule_entries SET enabled = false, updated_at = now() WHERE id = $1;

-- name: ListScheduleFireHistory :many
SELECT r.created_at, r.status
FROM runs r
WHERE r.org_id = sqlc.arg(org_id)::text AND r.workflow_id = sqlc.arg(workflow_id)::text
  AND r.trigger_kind = 'schedule'
  AND r.created_at >= sqlc.arg(created_at)
ORDER BY r.created_at DESC
LIMIT 5000;
