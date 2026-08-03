-- Postgres-backed rate limiter substrate (the pilot's deliberate
-- architecture divergence: no Redis — one binary, one database). Fixed
-- windows keyed (name, key, window_start): the window lives IN the primary
-- key, so each request is one O(1) UPSERT and expiry is a plain DELETE by
-- expires_at — no vacuum storm from hot-row churn.
-- +goose Up
CREATE TABLE IF NOT EXISTS go_pilot_rate_windows (
    name text NOT NULL,
    key text NOT NULL,
    window_start timestamptz NOT NULL,
    count integer NOT NULL DEFAULT 1,
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (name, key, window_start)
);

-- +goose Down
DROP TABLE IF EXISTS go_pilot_rate_windows;
