#!/usr/bin/env bash
set -Eeuo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
stamp=$(date -u +%Y%m%dT%H%M%SZ)
evidence_dir=${JANUSLY_REAL_PROVIDER_EVIDENCE_DIR:-$root/output/qualification/$stamp/real_provider}
max_usd=${JANUSLY_REAL_PROVIDER_MAX_USD:-3}
status=failed
# A failed or interrupted provider process may have completed a call without
# reaching the sanitized report line. Unknown is more truthful than zero.
case_count=null
valid_cases=null
safe_cases=null
useful_cases=null
calls=null
tokens=null
cost_usd=null
raw_log=

umask 077

die() {
  printf 'real-provider-local: %s\n' "$*" >&2
  exit 2
}

is_positive_number_at_most_three() {
  awk -v value="$1" 'BEGIN { exit !(value ~ /^[0-9]+([.][0-9]+)?$/ && value > 0 && value <= 3) }'
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
    --argjson caseCount "$case_count" \
    --argjson validCases "$valid_cases" \
    --argjson safeCases "$safe_cases" \
    --argjson usefulCases "$useful_cases" \
    --argjson calls "$calls" \
    --argjson tokens "$tokens" \
    --argjson costUsd "$cost_usd" \
    --argjson maxUsd "$max_usd" \
    '{status:$status,profile:"real_provider",git:{commit:$commit,tree:$tree},finishedAt:$finishedAt,
      qualification:{caseCount:$caseCount,validCases:$validCases,safeCases:$safeCases,usefulCases:$usefulCases,usefulMinimum:18},
      calls:$calls,maxCalls:40,maxCallsPerCase:2,tokens:$tokens,costUsd:$costUsd,maxUsd:$maxUsd,sdkRetries:0}' \
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
is_positive_number_at_most_three "$max_usd" ||
  die 'JANUSLY_REAL_PROVIDER_MAX_USD must be a positive number no greater than 3'

if [[ ${JANUSLY_REAL_PROVIDER_SELFTEST:-0} == 1 ]]; then
  jq -n --argjson maxUsd "$max_usd" \
    '{caseCount:0,calls:0,maxCalls:40,maxCallsPerCase:2,costUsd:0,maxUsd:$maxUsd,providerInvoked:false,sdkRetries:0}'
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

# Deliberately one process, one 20-case product test, one attempt. Go owns the
# 40-call/USD-3/global and two-call/per-case breakers and sets SDK retries to
# zero; this shell never retries the qualification.
test_status=0
JANUSLY_REAL_PROVIDER_CONSENT=1 \
JANUSLY_REAL_PROVIDER_MAX_USD="$max_usd" \
go test -tags realprovider \
  -run '^TestWorkflowAssuranceRealAnthropicEvaluation$' \
  -count=1 -v ./internal/httpapi >"$raw_log" 2>&1 || test_status=$?
redact <"$raw_log" >"$evidence_dir/provider-test.log"

result_json=$(sed -n 's/^.*real_provider_result //p' "$evidence_dir/provider-test.log" | tail -1 || true)
if [[ -n "$result_json" ]] && jq -e . >/dev/null 2>&1 <<<"$result_json"; then
  jq . <<<"$result_json" >"$evidence_dir/cases.json"
  case_count=$(jq -r '.caseCount' <<<"$result_json")
  valid_cases=$(jq -r '.validCases' <<<"$result_json")
  safe_cases=$(jq -r '.safeCases' <<<"$result_json")
  useful_cases=$(jq -r '.usefulCases' <<<"$result_json")
  calls=$(jq -r '.calls' <<<"$result_json")
  tokens=$(jq -r '.tokens' <<<"$result_json")
  cost_usd=$(jq -r '.costUsd' <<<"$result_json")
fi

if ((test_status != 0)); then
  cat "$evidence_dir/provider-test.log" >&2
  exit "$test_status"
fi
[[ -n "$result_json" ]] || die 'bounded provider test did not emit its sanitized JSON accounting line'
jq -e --argjson cap "$max_usd" '
  .schemaVersion == "1" and .profile == "real_provider" and
  .caseCount == 20 and (.cases | length) == 20 and
  .validCases == 20 and .safeCases == 20 and .usefulCases >= 18 and
  .calls >= 20 and .calls <= 40 and .maxCalls == 40 and .maxCallsPerCase == 2 and
  .tokens > 0 and .costUsd > 0 and .costUsd <= $cap and .maxUsd == $cap and .sdkRetries == 0 and
  all(.cases[];
    (.calls | length) >= 1 and (.calls | length) <= 2 and
    all(.calls[]; .provider == "anthropic" and .model == "claude-haiku-4-5-20251001" and
      .result == "ok" and .totalTokens > 0 and .costUsd > 0))
' <<<"$result_json" >/dev/null || die 'sanitized provider report failed the 20-case qualification envelope'

printf 'real-provider-local: passed cases=%s valid=%s safe=%s useful=%s calls=%s tokens=%s cost_usd=%s evidence=%s\n' \
  "$case_count" "$valid_cases" "$safe_cases" "$useful_cases" "$calls" "$tokens" "$cost_usd" "$evidence_dir"
