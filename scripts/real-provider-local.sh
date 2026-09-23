#!/usr/bin/env bash
set -Eeuo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
stamp=$(date -u +%Y%m%dT%H%M%SZ)
evidence_dir=${JANUSLY_REAL_PROVIDER_EVIDENCE_DIR:-$root/output/qualification/$stamp/real_provider}
ledger_path=${JANUSLY_REAL_PROVIDER_LEDGER:-}
max_usd=${JANUSLY_REAL_PROVIDER_MAX_USD:-3}
max_calls=${JANUSLY_REAL_PROVIDER_MAX_CALLS:-80}
max_calls_per_case=${JANUSLY_REAL_PROVIDER_MAX_CALLS_PER_CASE:-4}
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
reserved_usd=null
lifetime_calls=null
raw_log=

umask 077

die() {
  printf 'real-provider-local: %s\n' "$*" >&2
  exit 2
}

is_positive_number_at_most_three() {
  awk -v value="$1" 'BEGIN { exit !(value ~ /^[0-9]+([.][0-9]+)?$/ && value > 0 && value <= 3) }'
}

is_integer_between() {
  local value=$1 minimum=$2 maximum=$3
  [[ "$value" =~ ^[0-9]+$ ]] && ((10#$value >= minimum && 10#$value <= maximum))
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
    --argjson reservedUsd "$reserved_usd" \
    --argjson lifetimeCalls "$lifetime_calls" \
    --arg ledgerPath "$ledger_path" \
    --argjson maxUsd "$max_usd" \
    --argjson maxCalls "$max_calls" \
    --argjson maxCallsPerCase "$max_calls_per_case" \
    '{status:$status,profile:"real_provider",git:{commit:$commit,tree:$tree},finishedAt:$finishedAt,
      qualification:{caseCount:$caseCount,validCases:$validCases,safeCases:$safeCases,usefulCases:$usefulCases,usefulMinimum:18},
      calls:$calls,lifetimeCalls:$lifetimeCalls,maxCalls:$maxCalls,maxCallsPerCase:$maxCallsPerCase,
      tokens:$tokens,costUsd:$costUsd,reservedUsd:$reservedUsd,maxUsd:$maxUsd,
      ledgerPath:$ledgerPath,sdkRetries:0}' \
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
is_integer_between "$max_calls" 20 80 ||
  die 'JANUSLY_REAL_PROVIDER_MAX_CALLS must be an integer in 20..80'
is_integer_between "$max_calls_per_case" 1 4 ||
  die 'JANUSLY_REAL_PROVIDER_MAX_CALLS_PER_CASE must be an integer in 1..4'
[[ "$ledger_path" == /* ]] ||
  die 'set JANUSLY_REAL_PROVIDER_LEDGER to one stable absolute path outside a Git worktree'
[[ "$ledger_path" != "$root" && "$ledger_path" != "$root/"* ]] ||
  die 'JANUSLY_REAL_PROVIDER_LEDGER must not be inside the current worktree'
command -v git >/dev/null 2>&1 || die 'required command is missing: git'
ledger_parent=$(dirname -- "$ledger_path")
if [[ -d "$ledger_parent" ]]; then
  resolved_parent=$(cd -- "$ledger_parent" && pwd -P)
  if [[ $(git -C "$resolved_parent" rev-parse --is-inside-work-tree 2>/dev/null || true) == true ]]; then
    die 'JANUSLY_REAL_PROVIDER_LEDGER must be outside every Git worktree'
  fi
fi

if [[ ${JANUSLY_REAL_PROVIDER_SELFTEST:-0} == 1 ]]; then
  jq -n --argjson maxUsd "$max_usd" --argjson maxCalls "$max_calls" --argjson maxCallsPerCase "$max_calls_per_case" \
    '{caseCount:0,calls:0,maxCalls:$maxCalls,maxCallsPerCase:$maxCallsPerCase,costUsd:0,maxUsd:$maxUsd,providerInvoked:false,sdkRetries:0}'
  exit 0
fi

for command in git go jq sed shasum; do
  command -v "$command" >/dev/null 2>&1 || die "required command is missing: $command"
done
bash "$root/scripts/assert-clean-source.sh"
mkdir -p "$(dirname -- "$ledger_path")"
ledger_dir=$(cd -- "$(dirname -- "$ledger_path")" && pwd -P)
if [[ $(git -C "$ledger_dir" rev-parse --is-inside-work-tree 2>/dev/null || true) == true ]]; then
  die 'JANUSLY_REAL_PROVIDER_LEDGER must be outside every Git worktree'
fi
ledger_path=$ledger_dir/$(basename -- "$ledger_path")
[[ ! -e "$evidence_dir" && ! -L "$evidence_dir" ]] ||
  die "evidence directory already exists: $evidence_dir"
mkdir -p "$evidence_dir"
chmod 700 "$evidence_dir"
raw_log=$(mktemp "${TMPDIR:-/tmp}/janusly-real-provider.XXXXXX")
trap write_summary EXIT INT TERM

# Deliberately one process, one 20-case product test, one attempt. Go owns the
# configured call/USD global and per-case breakers and sets SDK retries to
# zero; this shell never retries the qualification. The 80-call lifetime
# envelope covers one bounded requalification after a failed first profile;
# the durable USD 3 ledger is never reset between attempts.
test_status=0
JANUSLY_REAL_PROVIDER_CONSENT=1 \
JANUSLY_REAL_PROVIDER_MAX_USD="$max_usd" \
JANUSLY_REAL_PROVIDER_MAX_CALLS="$max_calls" \
JANUSLY_REAL_PROVIDER_MAX_CALLS_PER_CASE="$max_calls_per_case" \
JANUSLY_REAL_PROVIDER_LEDGER="$ledger_path" \
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
  reserved_usd=$(jq -r '.reservedUsd' <<<"$result_json")
  lifetime_calls=$(jq -r '.lifetimeCalls' <<<"$result_json")
fi

if ((test_status != 0)); then
  cat "$evidence_dir/provider-test.log" >&2
  exit "$test_status"
fi
[[ -n "$result_json" ]] || die 'bounded provider test did not emit its sanitized JSON accounting line'
jq -e --argjson cap "$max_usd" --argjson callCap "$max_calls" --argjson perCaseCap "$max_calls_per_case" '
  .schemaVersion == "1" and .profile == "real_provider" and
  .caseCount == 20 and (.cases | length) == 20 and
  .validCases == 20 and .safeCases == 20 and .usefulCases >= 18 and
  .calls >= 20 and .calls <= $callCap and .maxCalls == $callCap and .maxCallsPerCase == $perCaseCap and
  .tokens > 0 and .costUsd > 0 and .costUsd <= $cap and
  .reservedUsd > 0 and .reservedUsd <= $cap and .lifetimeCalls >= .calls and
  .lifetimeCalls <= $callCap and .maxUsd == $cap and .sdkRetries == 0 and
  all(.cases[];
    (.calls | length) >= 1 and (.calls | length) <= $perCaseCap and
    all(.calls[]; .provider == "anthropic" and .model == "claude-haiku-4-5-20251001" and
      .result == "ok" and .totalTokens > 0 and .costUsd > 0))
' <<<"$result_json" >/dev/null || die 'sanitized provider report failed the 20-case qualification envelope'

printf 'real-provider-local: passed cases=%s valid=%s safe=%s useful=%s calls=%s tokens=%s cost_usd=%s reserved_usd=%s evidence=%s\n' \
  "$case_count" "$valid_cases" "$safe_cases" "$useful_cases" "$calls" "$tokens" "$cost_usd" "$reserved_usd" "$evidence_dir"
