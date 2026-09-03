#!/usr/bin/env bash
set -Eeuo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
script="$root/scripts/test-e2e.sh"

result=$(JANUSLY_E2E_PROJECT=janusly-e2e-selftest-1 \
  JANUSLY_E2E_PORT=33001 JANUSLY_E2E_POSTGRES_PORT=35432 \
  bash "$script" selftest)
jq -e '.project == "janusly-e2e-selftest-1" and .ports.application == 33001 and .ports.postgres == 35432' \
  <<<"$result" >/dev/null

if JANUSLY_E2E_PROJECT=janusly-e2e bash "$script" selftest >/dev/null 2>&1; then
  echo "historical shared project was accepted" >&2
  exit 1
fi
if JANUSLY_E2E_PROJECT=janusly-e2e-selftest-2 \
  JANUSLY_E2E_PORT=35432 JANUSLY_E2E_POSTGRES_PORT=35432 \
  bash "$script" selftest >/dev/null 2>&1; then
  echo "overlapping ports were accepted" >&2
  exit 1
fi
if JANUSLY_E2E_PROJECT=other-project bash "$script" selftest >/dev/null 2>&1; then
  echo "unowned project prefix was accepted" >&2
  exit 1
fi

echo "test-e2e harness self-test passed"
