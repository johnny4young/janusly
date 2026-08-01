-- +goose Up
-- Hot-path index (T-507 EXPLAIN sweep finding): the schedule heatmap,
-- the T-500 version-linked run counts, and the DLQ/health joins all reach
-- runs THROUGH workflow_versions (wv.id = r.workflow_version_id) — with
-- no index on that column the join degenerates to an org-wide scan.
-- Plain CREATE INDEX here (transactional, near-instant on dev/CI sizes);
-- production applies the CONCURRENTLY variant from the sibling
-- production-rollout file BEFORE running migrations.
CREATE INDEX IF NOT EXISTS runs_workflow_version_created_idx
  ON runs (workflow_version_id, created_at DESC);

-- +goose Down
DROP INDEX IF EXISTS runs_workflow_version_created_idx;
