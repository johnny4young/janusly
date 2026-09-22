#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
# Render only: no daemon, containers, user .env file or persisted secret-bearing
# Compose dump. Assertions emit no values from unrelated environment settings.
render() {
  docker compose --env-file /dev/null -f "$root/docker-compose.yml" config --format json
}

JANUSLY_REAPER_INTERVAL_MS='' JANUSLY_REAPER_THRESHOLD_MS='' \
JANUSLY_REAPER_THRESHOLD_FLOOR_MS='' JANUSLY_STALLED_NODE_THRESHOLD_MINUTES='' \
  render | jq -e '.services.janusly.environment |
    .JANUSLY_REAPER_INTERVAL_MS == "60000" and
    .JANUSLY_REAPER_THRESHOLD_MS == "3600000" and
    .JANUSLY_REAPER_THRESHOLD_FLOOR_MS == "" and
    .JANUSLY_STALLED_NODE_THRESHOLD_MINUTES == ""' >/dev/null

JANUSLY_REAPER_INTERVAL_MS=123 JANUSLY_REAPER_THRESHOLD_MS=172800000 \
JANUSLY_REAPER_THRESHOLD_FLOOR_MS=456 JANUSLY_STALLED_NODE_THRESHOLD_MINUTES='' \
  render | jq -e '.services.janusly.environment |
    .JANUSLY_REAPER_INTERVAL_MS == "123" and
    .JANUSLY_REAPER_THRESHOLD_MS == "172800000" and
    .JANUSLY_REAPER_THRESHOLD_FLOOR_MS == "456"' >/dev/null

# Compose must not mask invalid inputs with a fallback before boot validation.
JANUSLY_REAPER_INTERVAL_MS=invalid JANUSLY_STALLED_NODE_THRESHOLD_MINUTES=60 \
  render | jq -e '.services.janusly.environment |
    .JANUSLY_REAPER_INTERVAL_MS == "invalid" and
    .JANUSLY_STALLED_NODE_THRESHOLD_MINUTES == "60"' >/dev/null
printf 'Process configuration forwarding passed\n'
