#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
pnpm_command=${PNPM:-pnpm --ignore-workspace}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  kill "${api_pid:-}" "${web_pid:-}" 2>/dev/null || true
  wait "${api_pid:-}" "${web_pid:-}" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT INT TERM

(cd "$root" && go run ./cmd/api) &
api_pid=$!
(cd "$root/web" && $pnpm_command dev --host 127.0.0.1) &
web_pid=$!

printf 'Janusly API: http://127.0.0.1:3001\n'
printf 'Janusly web: http://127.0.0.1:5173\n'

while kill -0 "$api_pid" 2>/dev/null && kill -0 "$web_pid" 2>/dev/null; do
  sleep 1
done
wait "$api_pid" "$web_pid"
