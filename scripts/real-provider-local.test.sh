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
if ANTHROPIC_API_KEY=fake JANUSLY_REAL_PROVIDER_CONSENT=1 \
  JANUSLY_REAL_PROVIDER_MAX_CALLS=19 JANUSLY_REAL_PROVIDER_SELFTEST=1 \
  "$script" >/dev/null 2>&1; then
  echo "real-provider selftest accepted fewer calls than the corpus" >&2
  exit 1
fi
if ANTHROPIC_API_KEY=fake JANUSLY_REAL_PROVIDER_CONSENT=1 \
  JANUSLY_REAL_PROVIDER_MAX_CALLS_PER_CASE=3 JANUSLY_REAL_PROVIDER_SELFTEST=1 \
  "$script" >/dev/null 2>&1; then
  echo "real-provider selftest accepted more than two calls per case" >&2
  exit 1
fi
if ANTHROPIC_API_KEY=fake JANUSLY_REAL_PROVIDER_CONSENT=1 \
  JANUSLY_REAL_PROVIDER_LEDGER='' JANUSLY_REAL_PROVIDER_SELFTEST=1 \
  "$script" >/dev/null 2>&1; then
  echo "real-provider selftest accepted a checkout-local default ledger" >&2
  exit 1
fi
if ANTHROPIC_API_KEY=fake JANUSLY_REAL_PROVIDER_CONSENT=1 \
  JANUSLY_REAL_PROVIDER_LEDGER="$root/output/qualification/real-provider-ledger.jsonl" \
  JANUSLY_REAL_PROVIDER_SELFTEST=1 "$script" >/dev/null 2>&1; then
  echo "real-provider selftest accepted an explicit checkout-local ledger" >&2
  exit 1
fi
ledger_dir=$(mktemp -d "${TMPDIR:-/tmp}/janusly-real-provider-ledger-test.XXXXXX")
trap 'rm -f -- "$ledger_dir/inside"; rmdir "$ledger_dir" 2>/dev/null || true' EXIT
ledger_path="$ledger_dir/ledger.jsonl"
ln -s "$root/output/qualification" "$ledger_dir/inside"
if ANTHROPIC_API_KEY=fake JANUSLY_REAL_PROVIDER_CONSENT=1 \
  JANUSLY_REAL_PROVIDER_LEDGER="$ledger_dir/inside/ledger.jsonl" \
  JANUSLY_REAL_PROVIDER_SELFTEST=1 "$script" >/dev/null 2>&1; then
  echo "real-provider selftest accepted a symlink into a Git worktree" >&2
  exit 1
fi
rm -f -- "$ledger_dir/inside"

result=$(ANTHROPIC_API_KEY=fake JANUSLY_REAL_PROVIDER_CONSENT=1 \
  JANUSLY_REAL_PROVIDER_MAX_USD=3 JANUSLY_REAL_PROVIDER_LEDGER="$ledger_path" \
  JANUSLY_REAL_PROVIDER_SELFTEST=1 "$script")
jq -e '.caseCount == 0 and .calls == 0 and .maxCalls == 40 and .maxCallsPerCase == 2 and
  .costUsd == 0 and .maxUsd == 3 and .providerInvoked == false and .sdkRetries == 0' <<<"$result" >/dev/null

remaining=$(ANTHROPIC_API_KEY=fake JANUSLY_REAL_PROVIDER_CONSENT=1 \
  JANUSLY_REAL_PROVIDER_MAX_USD=2.9 JANUSLY_REAL_PROVIDER_MAX_CALLS=20 \
  JANUSLY_REAL_PROVIDER_MAX_CALLS_PER_CASE=1 JANUSLY_REAL_PROVIDER_LEDGER="$ledger_path" \
  JANUSLY_REAL_PROVIDER_SELFTEST=1 "$script")
jq -e '.maxCalls == 20 and .maxCallsPerCase == 1 and .maxUsd == 2.9 and .providerInvoked == false' <<<"$remaining" >/dev/null

GOCACHE=${GOCACHE:-/private/tmp/janusly-gocache} \
  go test -tags realprovider -count=1 \
  -run '^(TestRealProviderQualificationBreakersProviderFree|TestRealProviderLedger.*)$' ./internal/httpapi >/dev/null

negative_log=$(mktemp "${TMPDIR:-/tmp}/janusly-real-provider-negative.XXXXXX")
trap 'rm -f -- "$negative_log" "$ledger_dir/inside"; rmdir "$ledger_dir" 2>/dev/null || true' EXIT
if GOCACHE=${GOCACHE:-/private/tmp/janusly-gocache} \
  ANTHROPIC_API_KEY=fake JANUSLY_REAL_PROVIDER_CONSENT=1 JANUSLY_REAL_PROVIDER_LEDGER='' \
  go test -tags realprovider -count=1 \
  -run '^TestWorkflowAssuranceRealAnthropicEvaluation$' ./internal/httpapi >"$negative_log" 2>&1; then
  echo "real-provider qualification reached a fake provider without a ledger" >&2
  exit 1
fi
grep -q 'JANUSLY_REAL_PROVIDER_LEDGER is required before any paid call' "$negative_log"

echo "real-provider 20-case harness selftest passed without provider calls"
