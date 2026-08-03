-- Subworkflows: checkpoints padre-hijo, notificaciones terminales, linaje.

-- name: FindLatestValidationRunForParent :one
SELECT id, status, validation_evidence_level, created_at FROM runs
WHERE org_id = $1 AND parent_run_id = $2 AND replay_mode = 'validation'
ORDER BY created_at DESC, id DESC LIMIT 1;

-- name: GetRunParentLink :one
SELECT id, org_id, status, parent_run_id, parent_node_id, parent_link_kind,
       replay_mode, output_json, parent_notification_after
FROM runs WHERE id = $1;

-- name: MarkWaitingSubworkflowSucceeded :execrows
UPDATE run_nodes
SET status = 'succeeded', state_json = sqlc.arg(state_json),
    finished_at = sqlc.arg(finished_at)
WHERE run_id = sqlc.arg(run_id) AND node_id = sqlc.arg(node_id)
  AND status = 'waiting'
  AND state_json -> 'waiting' ->> 'childRunId' = sqlc.arg(child_run_id)::text;

-- name: MarkWaitingSubworkflowFailed :execrows
UPDATE run_nodes
SET status = 'failed', error_json = sqlc.arg(error_json),
    finished_at = sqlc.arg(finished_at)
WHERE run_id = sqlc.arg(run_id) AND node_id = sqlc.arg(node_id)
  AND status = 'waiting'
  AND state_json -> 'waiting' ->> 'childRunId' = sqlc.arg(child_run_id)::text;
