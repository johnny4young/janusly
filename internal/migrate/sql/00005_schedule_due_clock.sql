-- +goose Up
-- The pilot's schedule dispatch substrate is the Postgres due clock (the
-- replay-campaign pattern) — the reference's BullMQ upsertJobScheduler has
-- no equivalent here, so each entry carries its own next fire time and a
-- leased sweep claims due rows.
ALTER TABLE schedule_entries ADD COLUMN IF NOT EXISTS next_fire_at timestamptz;
CREATE INDEX IF NOT EXISTS schedule_entries_due_idx
  ON schedule_entries (next_fire_at) WHERE enabled = true;

-- +goose Down
DROP INDEX IF EXISTS schedule_entries_due_idx;
ALTER TABLE schedule_entries DROP COLUMN IF EXISTS next_fire_at;
