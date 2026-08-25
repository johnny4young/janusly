#!/usr/bin/env bash
set -Eeuo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
stamp=$(date -u +%Y%m%dT%H%M%SZ)
evidence_dir=${JANUSLY_REAL_PROVIDER_EVIDENCE_DIR:-$root/output/qualification/$stamp/real_provider}
max_usd=${JANUSLY_REAL_PROVIDER_MAX_USD:-1}
status=failed
# A failed or interrupted provider process may have completed one call without
# reaching the accounting line. Keep those values unknown rather than falsely
# recording zero spend. The tagged test still has a structural maximum of two.
calls=null
tokens=null
cost_usd=null
raw_log=

umask 077

die() {
  printf 'real-provider-local: %s\n' "$*" >&2
  exit 2
}

is_positive_number_at_most_one() {
  awk -v value="$1" 'BEGIN { exit !(value ~ /^[0-9]+([.][0-9]+)?$/ && value > 0 && value <= 1) }'
}

redact() {
  sed -E \
    -e 's/(sk-ant-[A-Za-z0-9_-]+)/[REDACTED_ANTHROPIC_KEY]/g' \
    -e 's/(ANTHROPIC_API_KEY[=:][[:space:]]*)[^[:space:]]+/\1[REDACTED]/g'
}

write_summary() {
  local exit_status=$? checksum_tmp finished_at commit tree
  trap - EXIT INT TERM
  if [[ -n "$raw_log" ]]; then rm -f -- "$raw_log"; fi
  if ((exit_status == 0)); then status=passed; fi
  mkdir -p "$evidence_dir"
  chmod 700 "$evidence_dir"
  commit=$(git -C "$root" rev-parse HEAD 2>/dev/null || printf unknown)
  tree=$(git -C "$root" rev-parse 'HEAD^{tree}' 2>/dev/null || printf unknown)
  finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  jq -n \
    --arg status "$status" \
    --arg commit "$commit" \
    --arg tree "$tree" \
    --arg finishedAt "$finished_at" \
    --argjson calls "$calls" \
    --argjson tokens "$tokens" \
    --argjson costUsd "$cost_usd" \
    --argjson maxUsd "$max_usd" \
    '{status:$status,profile:"real_provider",git:{commit:$commit,tree:$tree},finishedAt:$finishedAt,calls:$calls,maxCalls:2,tokens:$tokens,costUsd:$costUsd,maxUsd:$maxUsd,retried:false}' \
    >"$evidence_dir/summary.json"
  checksum_tmp=$(mktemp "${TMPDIR:-/tmp}/janusly-real-provider-sums.XXXXXX")
  (
    cd "$evidence_dir"
    find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 shasum -a 256
  ) >"$checksum_tmp"
  mv "$checksum_tmp" "$evidence_dir/SHA256SUMS"
  exit "$exit_status"
}

[[ ${JANUSLY_REAL_PROVIDER_CONSENT:-} == 1 ]] ||
  die 'set JANUSLY_REAL_PROVIDER_CONSENT=1 to authorize the bounded paid test'
[[ -n ${ANTHROPIC_API_KEY:-} ]] || die 'ANTHROPIC_API_KEY is required'
is_positive_number_at_most_one "$max_usd" ||
  die 'JANUSLY_REAL_PROVIDER_MAX_USD must be a positive number no greater than 1'

if [[ ${JANUSLY_REAL_PROVIDER_SELFTEST:-0} == 1 ]]; then
  printf '{"calls":0,"costUsd":0,"providerInvoked":false}\n'
  exit 0
fi

for command in git go jq sed shasum; do
  command -v "$command" >/dev/null 2>&1 || die "required command is missing: $command"
done
bash "$root/scripts/assert-clean-source.sh"
[[ ! -e "$evidence_dir" && ! -L "$evidence_dir" ]] ||
  die "evidence directory already exists: $evidence_dir"
mkdir -p "$evidence_dir"
chmod 700 "$evidence_dir"
raw_log=$(mktemp "${TMPDIR:-/tmp}/janusly-real-provider.XXXXXX")
trap write_summary EXIT INT TERM

# Deliberately one process, one test, one attempt. The tagged Go test owns the
# exact two provider calls and sets MaxRetries=0; this shell never retries it.
if ! JANUSLY_REAL_PROVIDER_CONSENT=1 \
  JANUSLY_REAL_PROVIDER_MAX_USD="$max_usd" \
  go test -tags realprovider \
    -run '^TestBoundedRealAnthropicProvider$' \
    -count=1 -v ./internal/ai >"$raw_log" 2>&1; then
  redact <"$raw_log" >"$evidence_dir/provider-test.log"
  cat "$evidence_dir/provider-test.log" >&2
  exit 1
fi
redact <"$raw_log" >"$evidence_dir/provider-test.log"

result_line=$(grep -E 'real_provider calls=[0-9]+ model=[^ ]+ tokens=[0-9]+ cost_usd=[0-9.]+' \
  "$evidence_dir/provider-test.log" | tail -1 || true)
[[ -n "$result_line" ]] || die 'bounded provider test did not emit its accounting line'
calls=$(sed -E 's/.* calls=([0-9]+) .*/\1/' <<<"$result_line")
tokens=$(sed -E 's/.* tokens=([0-9]+) .*/\1/' <<<"$result_line")
cost_usd=$(sed -E 's/.* cost_usd=([0-9.]+).*/\1/' <<<"$result_line")
[[ "$calls" == 2 ]] || die "expected exactly 2 provider calls, observed $calls"
[[ "$tokens" =~ ^[1-9][0-9]*$ ]] || die 'provider token accounting was not positive'
awk -v cost="$cost_usd" -v cap="$max_usd" 'BEGIN { exit !(cost > 0 && cost <= cap) }' ||
  die "provider cost $cost_usd exceeded cap $max_usd"

printf 'real-provider-local: passed calls=%s tokens=%s cost_usd=%s evidence=%s\n' \
  "$calls" "$tokens" "$cost_usd" "$evidence_dir"
