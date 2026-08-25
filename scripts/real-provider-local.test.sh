#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
script="$root/scripts/real-provider-local.sh"
bash -n "$script"

if ANTHROPIC_API_KEY=fake JANUSLY_REAL_PROVIDER_SELFTEST=1 "$script" >/dev/null 2>&1; then
  echo "real-provider selftest accepted missing consent" >&2
  exit 1
fi
if JANUSLY_REAL_PROVIDER_CONSENT=1 JANUSLY_REAL_PROVIDER_SELFTEST=1 "$script" >/dev/null 2>&1; then
  echo "real-provider selftest accepted missing API key" >&2
  exit 1
fi
if ANTHROPIC_API_KEY=fake JANUSLY_REAL_PROVIDER_CONSENT=1 \
  JANUSLY_REAL_PROVIDER_MAX_USD=1.01 JANUSLY_REAL_PROVIDER_SELFTEST=1 \
  "$script" >/dev/null 2>&1; then
  echo "real-provider selftest accepted a cap above USD 1" >&2
  exit 1
fi

result=$(ANTHROPIC_API_KEY=fake JANUSLY_REAL_PROVIDER_CONSENT=1 \
  JANUSLY_REAL_PROVIDER_MAX_USD=1 JANUSLY_REAL_PROVIDER_SELFTEST=1 "$script")
jq -e '.calls == 0 and .costUsd == 0 and .providerInvoked == false' <<<"$result" >/dev/null

echo "real-provider harness selftest passed without provider calls"
