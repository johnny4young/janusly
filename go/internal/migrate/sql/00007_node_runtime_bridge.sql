-- +goose Up
-- Databases created by the Node runtime predate Goose and therefore carry
-- the shared tables from migration one but not the two Go-owned dispatch
-- tables embedded in that fresh-database baseline. Install those objects
-- explicitly so stamping version one can never skip runtime prerequisites.
CREATE TABLE IF NOT EXISTS go_pilot_start_idempotency (
    org_id text NOT NULL,
    idempotency_key text NOT NULL,
    run_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS go_pilot_wakeups (
    run_node_id text NOT NULL,
    wake_at timestamptz NOT NULL,
    reason text NOT NULL,
    PRIMARY KEY (run_node_id)
);

CREATE INDEX IF NOT EXISTS go_pilot_wakeups_due_idx
  ON go_pilot_wakeups (wake_at);

-- Migration three installed the canonical runs_org_created_id_idx. The
-- fresh baseline's older pilot-prefixed copy is identical and only adds
-- write amplification, so both fresh and upgraded databases converge here.
DROP INDEX IF EXISTS go_pilot_runs_org_created_id_idx;

-- +goose Down
-- This compatibility bridge is intentionally irreversible. Dropping these
-- tables would discard idempotency and timer state on a database that started
-- from the fresh baseline, while Node safely ignores the additional objects.
SELECT 1;
