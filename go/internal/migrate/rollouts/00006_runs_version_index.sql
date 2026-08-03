-- Runbook de ops (NO lo corre goose): aplicar ANTES del deploy que trae
-- la migración 00006, con psql -v ON_ERROR_STOP=1 -f este archivo.
-- El IF NOT EXISTS de la migración corta en no-op después.
CREATE INDEX CONCURRENTLY IF NOT EXISTS runs_workflow_version_created_idx
  ON runs (workflow_version_id, created_at DESC);
