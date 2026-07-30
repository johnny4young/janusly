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
