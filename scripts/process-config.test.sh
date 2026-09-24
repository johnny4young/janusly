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
for value in 25 1 500 invalid; do
  JANUSLY_DB_TOOL_MAX_PROCESS_POOLS="$value" render |
    jq -e --arg value "$value" '.services.janusly.environment.JANUSLY_DB_TOOL_MAX_PROCESS_POOLS == $value' >/dev/null
done
JANUSLY_DB_TOOL_MAX_PROCESS_POOLS='' render |
  jq -e '.services.janusly.environment.JANUSLY_DB_TOOL_MAX_PROCESS_POOLS == "25"' >/dev/null
for value in 1 600000 invalid; do
  JANUSLY_HTTP_TIMEOUT_MS="$value" JANUSLY_HTTP_MAX_RESPONSE_BYTES="$value" \
  JANUSLY_HTTP_MAX_REDIRECTS="$value" JANUSLY_HTTP_STREAM_PREVIEW_BYTES="$value" render |
    jq -e --arg value "$value" '.services.janusly.environment |
      .JANUSLY_HTTP_TIMEOUT_MS == $value and .JANUSLY_HTTP_MAX_RESPONSE_BYTES == $value and
      .JANUSLY_HTTP_MAX_REDIRECTS == $value and .JANUSLY_HTTP_STREAM_PREVIEW_BYTES == $value' >/dev/null
done
JANUSLY_HTTP_TIMEOUT_MS='' JANUSLY_HTTP_MAX_RESPONSE_BYTES='' \
JANUSLY_HTTP_MAX_REDIRECTS='' JANUSLY_HTTP_STREAM_PREVIEW_BYTES='' render |
  jq -e '.services.janusly.environment |
    .JANUSLY_HTTP_TIMEOUT_MS == "30000" and .JANUSLY_HTTP_MAX_RESPONSE_BYTES == "1000000" and
    .JANUSLY_HTTP_MAX_REDIRECTS == "5" and .JANUSLY_HTTP_STREAM_PREVIEW_BYTES == "65536"' >/dev/null
for value in 2 128 256000 9223372036854775807 invalid; do
  JANUSLY_PERSIST_MAX_BYTES="$value" render |
    jq -e --arg value "$value" '.services.janusly.environment.JANUSLY_PERSIST_MAX_BYTES == $value' >/dev/null
done
JANUSLY_PERSIST_MAX_BYTES='' render |
  jq -e '.services.janusly.environment.JANUSLY_PERSIST_MAX_BYTES == "256000"' >/dev/null
printf 'Process configuration forwarding passed\n'
