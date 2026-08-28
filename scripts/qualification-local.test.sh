#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

bash -n "$root/scripts/qualification-local.sh"
output=$("$root/scripts/qualification-local.sh" selftest)
jq -e '
  .project == "janusly-qualification-app" and
  .authProject == "janusly-qualification-auth" and
  .origin == "http://127.0.0.1:7310" and
  .supabaseConfigured == false
' <<<"$output" >/dev/null

configured=$(JANUSLY_QUALIFICATION_SUPABASE_STATUS_JSON='{"ANON_KEY":"publishable-test","SERVICE_ROLE_KEY":"secret-test"}' \
  "$root/scripts/qualification-local.sh" selftest)
jq -e '.supabaseConfigured == true and (has("anonKey") | not) and (has("serviceRoleKey") | not)' \
  <<<"$configured" >/dev/null

if JANUSLY_QUALIFICATION_PROJECT=janusly "$root/scripts/qualification-local.sh" selftest >/dev/null 2>&1; then
  echo "selftest accepted the ordinary development project" >&2
  exit 1
fi
if JANUSLY_QUALIFICATION_APP_PORT=abc "$root/scripts/qualification-local.sh" selftest >/dev/null 2>&1; then
  echo "selftest accepted an invalid port" >&2
  exit 1
fi
if "$root/scripts/qualification-local.sh" unknown >/dev/null 2>&1; then
  echo "selftest accepted an unknown profile" >&2
  exit 1
fi

help=$("$root/scripts/qualification-local.sh" --help)
grep -F "load | all" <<<"$help" >/dev/null
grep -F "load profile is intentionally excluded" <<<"$help" >/dev/null

echo "qualification harness selftest passed"
