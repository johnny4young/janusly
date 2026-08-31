#!/usr/bin/env bash
set -Eeuo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
script="$root/scripts/private-metrics-local.sh"
bash -n "$script"

result=$(JANUSLY_PRIVATE_METRICS_SELFTEST=1 "$script")
jq -e '.project | startswith("janusly-qualification-metrics-")' <<<"$result" >/dev/null
jq -e '.metricsPrivate == true and .metricsPublished == false' <<<"$result" >/dev/null
grep -F -- '--publish "127.0.0.1:${app_port}:3001"' "$script" >/dev/null
grep -F '.["9464/tcp"] == null' "$script" >/dev/null
grep -F 'http://janusly:9464/metrics' "$script" >/dev/null

compose_config=$(mktemp "${TMPDIR:-/tmp}/janusly-compose-config.XXXXXX.json")
trap 'rm -f -- "$compose_config"' EXIT
JANUSLY_MEMORY_ENABLED=true \
JANUSLY_EMBEDDING_PROVIDER=ollama \
JANUSLY_EMBEDDING_MODEL=test-model \
  docker compose -f "$root/docker-compose.yml" config --format json >"$compose_config"
jq -e '
  .services.janusly.environment.JANUSLY_INTERNAL_HOST == "0.0.0.0" and
  .services.janusly.environment.JANUSLY_MEMORY_ENABLED == "true" and
  .services.janusly.environment.JANUSLY_EMBEDDING_PROVIDER == "ollama" and
  .services.janusly.environment.JANUSLY_EMBEDDING_MODEL == "test-model" and
  any(
    .services.janusly.ports[];
    .target == 9464 and .host_ip == "127.0.0.1" and .protocol == "tcp"
  )
' "$compose_config" >/dev/null

if JANUSLY_PRIVATE_METRICS_PROJECT=janusly JANUSLY_PRIVATE_METRICS_SELFTEST=1 \
  "$script" >/dev/null 2>&1; then
  printf 'private metrics selftest accepted the ordinary project\n' >&2
  exit 1
fi
if IMAGE='bad image' JANUSLY_PRIVATE_METRICS_SELFTEST=1 "$script" >/dev/null 2>&1; then
  printf 'private metrics selftest accepted an invalid image\n' >&2
  exit 1
fi
if "$script" >/dev/null 2>&1; then
  printf 'private metrics harness accepted missing reset confirmation\n' >&2
  exit 1
fi

printf 'private metrics harness selftest passed without Docker mutation\n'
