-- SUPERSEDED: this file is folded into the goose baseline
-- (internal/migrate/sql/00001_baseline.sql). Kept for history only; no
-- runner applies it anymore.

-- Pilot-only auxiliary objects. The shared tables stay untouched: drizzle-kit
-- owns their schema, and this file is applied only to the pilot database.

-- Wake-up ledger for timers (retry backoff, wait_until). The shared
-- run_nodes table carries repair markers but no generic wake column, so the
-- pilot keeps its scheduling state in its own table keyed by the node row.
CREATE TABLE IF NOT EXISTS go_pilot_wakeups (
  run_node_id text PRIMARY KEY,
  wake_at timestamptz NOT NULL,
  reason text NOT NULL
);

CREATE INDEX IF NOT EXISTS go_pilot_wakeups_due_idx
  ON go_pilot_wakeups (wake_at);

-- Keyset alignment for the runs list: the page orders by
-- (created_at DESC, id DESC) but the shared runs_org_created_idx lacks the
-- id tiebreaker, forcing a bitmap scan + top-N sort over the WHOLE org per
-- page (O(org runs), ~4.5ms at 10k rows). With the aligned index the page
-- is a direct index walk. Names are go_pilot_-prefixed: pilot-owned
-- objects on the shared schema.
CREATE INDEX IF NOT EXISTS go_pilot_runs_org_created_id_idx
  ON runs (org_id, created_at DESC, id DESC);

-- Optional POST /start idempotency: one key per org maps to the run it
-- created. The row inserts inside the start transaction, so "key claimed"
-- and "run exists" commit together; a duplicate key returns the original
-- run instead of spawning a second one.
CREATE TABLE IF NOT EXISTS go_pilot_start_idempotency (
  org_id text NOT NULL,
  idempotency_key text NOT NULL,
  run_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, idempotency_key)
);
