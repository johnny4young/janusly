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
  JANUSLY_REAL_PROVIDER_MAX_USD=3.01 JANUSLY_REAL_PROVIDER_SELFTEST=1 \
  "$script" >/dev/null 2>&1; then
  echo "real-provider selftest accepted a cap above USD 3" >&2
  exit 1
fi

result=$(ANTHROPIC_API_KEY=fake JANUSLY_REAL_PROVIDER_CONSENT=1 \
  JANUSLY_REAL_PROVIDER_MAX_USD=3 JANUSLY_REAL_PROVIDER_SELFTEST=1 "$script")
jq -e '.caseCount == 0 and .calls == 0 and .maxCalls == 40 and .maxCallsPerCase == 2 and
  .costUsd == 0 and .maxUsd == 3 and .providerInvoked == false and .sdkRetries == 0' <<<"$result" >/dev/null

GOCACHE=${GOCACHE:-/private/tmp/janusly-gocache} \
  go test -tags realprovider -count=1 \
  -run '^TestRealProviderQualificationBreakersProviderFree$' ./internal/httpapi >/dev/null

echo "real-provider 20-case harness selftest passed without provider calls"
