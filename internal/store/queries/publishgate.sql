-- name: InsertWorkflowDraft :one
INSERT INTO workflow_drafts (id, org_id, workflow_id, base_version_id, document, fixtures, digest, created_by)
VALUES (sqlc.arg(id), sqlc.arg(org_id), sqlc.arg(workflow_id), sqlc.narg(base_version_id),
        sqlc.arg(document), sqlc.arg(fixtures), sqlc.arg(digest), sqlc.arg(created_by))
ON CONFLICT (org_id, workflow_id, created_by, digest) DO NOTHING
RETURNING *;

-- name: GetWorkflowDraftByDigest :one
SELECT * FROM workflow_drafts
WHERE org_id = $1 AND workflow_id = $2 AND created_by = $3 AND digest = $4;

-- name: GetWorkflowDraft :one
SELECT * FROM workflow_drafts WHERE org_id = $1 AND id = $2;

-- name: ListWorkflowDrafts :many
SELECT id, workflow_id, base_version_id, digest, created_by, created_at
FROM workflow_drafts
WHERE org_id = sqlc.arg(org_id)
  AND (sqlc.narg(filter_workflow_id)::text IS NULL OR workflow_id = sqlc.narg(filter_workflow_id))
  AND (sqlc.narg(scope_workflow_ids)::text[] IS NULL OR workflow_id = ANY(sqlc.narg(scope_workflow_ids)::text[])
       OR created_by = sqlc.arg(self)::text)
  AND (created_at, id) < (sqlc.arg(before_created_at)::timestamptz, sqlc.arg(before_id)::text)
ORDER BY created_at DESC, id DESC
LIMIT sqlc.arg(page_limit);

-- name: InsertDraftQualification :one
INSERT INTO draft_qualifications (id, org_id, draft_id, digest, status, checks, fixture_runs, created_by, completed_at)
VALUES (sqlc.arg(id), sqlc.arg(org_id), sqlc.arg(draft_id), sqlc.arg(digest), sqlc.arg(status),
        sqlc.arg(checks), sqlc.arg(fixture_runs), sqlc.arg(created_by), sqlc.narg(completed_at))
RETURNING *;

-- name: GetDraftQualification :one
SELECT * FROM draft_qualifications WHERE org_id = $1 AND id = $2;

-- Settles a running receipt once; a concurrent reader that loses keeps the
-- winner's result.
-- name: SettleDraftQualification :one
UPDATE draft_qualifications
SET status = sqlc.arg(status), checks = sqlc.arg(checks), fixture_runs = sqlc.arg(fixture_runs), completed_at = now()
WHERE org_id = sqlc.arg(org_id) AND id = sqlc.arg(id) AND status = 'running'
RETURNING *;

-- name: CountRecentDraftQualifications :one
SELECT count(*)::int FROM draft_qualifications
WHERE org_id = $1 AND created_by = $2 AND created_at > now() - interval '1 hour';

-- name: ListRunOutcomesForOrg :many
SELECT r.id, r.status, r.output_json,
       EXISTS (SELECT 1 FROM run_nodes rn WHERE rn.run_id = r.id AND rn.status = 'waiting') AS waiting
FROM runs r
WHERE r.org_id = sqlc.arg(org_id) AND r.id = ANY(sqlc.arg(run_ids)::text[]);

-- name: SupersedePublishRequests :exec
UPDATE publish_requests SET status = 'superseded'
WHERE org_id = $1 AND workflow_id = $2 AND status = 'pending';

-- name: InsertPublishRequest :one
INSERT INTO publish_requests (id, org_id, workflow_id, draft_id, qualification_id, reasons,
                              requested_by, on_behalf_of, drafted_by, scope_tag, expires_at)
VALUES (sqlc.arg(id), sqlc.arg(org_id), sqlc.arg(workflow_id), sqlc.arg(draft_id), sqlc.arg(qualification_id),
        sqlc.arg(reasons)::text[], sqlc.arg(requested_by), sqlc.arg(on_behalf_of), sqlc.arg(drafted_by),
        sqlc.narg(scope_tag), sqlc.arg(expires_at))
RETURNING *;

-- name: GetPublishRequest :one
SELECT * FROM publish_requests WHERE org_id = $1 AND id = $2;

-- name: ListPublishRequests :many
SELECT * FROM publish_requests
WHERE org_id = sqlc.arg(org_id)
  AND (sqlc.narg(filter_status)::text IS NULL OR status = sqlc.narg(filter_status))
ORDER BY created_at DESC, id DESC
LIMIT 100;

-- The caller holds the workflow's publish lock and checked expiry under it.
-- name: DecidePublishRequest :one
UPDATE publish_requests
SET status = sqlc.arg(status), decided_by = sqlc.arg(decided_by)::text, decided_at = now(),
    published_version_id = sqlc.narg(published_version_id)
WHERE org_id = sqlc.arg(org_id) AND id = sqlc.arg(id) AND status = 'pending'
RETURNING *;

-- name: ExpirePublishRequest :exec
UPDATE publish_requests SET status = 'expired'
WHERE org_id = $1 AND id = $2 AND status = 'pending' AND expires_at <= now();

-- name: TagWorkflowIfUntagged :exec
INSERT INTO workflow_metadata (id, org_id, workflow_id, tags)
VALUES (sqlc.arg(id), sqlc.arg(org_id), sqlc.arg(workflow_id), jsonb_build_array(sqlc.arg(tag)::text))
ON CONFLICT DO NOTHING;

-- name: WorkflowExistsInOrg :one
SELECT EXISTS (SELECT 1 FROM workflows WHERE org_id = $1 AND id = $2);

-- name: DraftedWorkflowBy :one
SELECT EXISTS (SELECT 1 FROM workflow_drafts WHERE org_id = $1 AND workflow_id = $2 AND created_by = $3);

-- Unpinned and pinned callers alike: a change to the callee reaches them.
-- name: WorkflowHasCallers :one
SELECT EXISTS (
  SELECT 1 FROM workflows w
  JOIN LATERAL (
    SELECT v.dag_json FROM workflow_versions v
    WHERE v.org_id = w.org_id AND v.workflow_id = w.id
    ORDER BY v.version DESC LIMIT 1
  ) latest ON true
  WHERE w.org_id = sqlc.arg(org_id) AND w.id <> sqlc.arg(workflow_id) AND w.deleted_at IS NULL
    AND latest.dag_json @> jsonb_build_object('nodes', jsonb_build_array(
          jsonb_build_object('type', 'subworkflow', 'config', jsonb_build_object('workflowId', sqlc.arg(workflow_id)::text))))
);

-- name: CountRecentAgentDraftRuns :one
SELECT count(*)::int FROM runs
WHERE org_id = $1 AND created_by = $2 AND replay_mode = 'validation' AND created_at > now() - interval '1 hour';
