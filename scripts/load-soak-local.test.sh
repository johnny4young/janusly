#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
script="$root/scripts/load-soak-local.sh"

bash -n "$script"
if JANUSLY_LOAD_COMPOSE_PROJECT=janusly "$script" >/dev/null 2>&1; then
  echo "load selftest accepted the ordinary Compose project" >&2
  exit 1
fi
if JANUSLY_LOAD_ORIGIN=https://remote.example:443 "$script" >/dev/null 2>&1; then
  echo "load selftest accepted a remote origin" >&2
  exit 1
fi
if JANUSLY_LOAD_SAMPLE_INTERVAL=0 "$script" >/dev/null 2>&1; then
  echo "load selftest accepted a zero sample interval" >&2
  exit 1
fi
if JANUSLY_LOAD_SETTLE_SECONDS=invalid "$script" >/dev/null 2>&1; then
  echo "load selftest accepted invalid settle seconds" >&2
  exit 1
fi
if JANUSLY_LOAD_SMOKE=maybe "$script" >/dev/null 2>&1; then
  echo "load selftest accepted an invalid smoke mode" >&2
  exit 1
fi

echo "load/soak harness selftest passed"
