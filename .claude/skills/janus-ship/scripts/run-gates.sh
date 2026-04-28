#!/usr/bin/env bash
# run-gates.sh — Run the Janusly automated gates and report PASS/FAIL summary.
#
# Why this script exists:
# Both janus-ship and janus-review run the same gate sequence (pnpm build +
# pnpm test, optionally pnpm test:e2e). Having one script removes duplicated
# logic, gives a deterministic exit code, and produces a structured summary
# the agent can paste straight into the Review Guide.
#
# Usage:
#   bash scripts/run-gates.sh           # build + test
#   bash scripts/run-gates.sh --e2e     # build + test + test:e2e
#   bash scripts/run-gates.sh --help
#
# Exit codes:
#   0 = all gates passed
#   1 = at least one gate failed
#   2 = invalid usage
#
# Output: a markdown-shaped summary on stdout, ready to drop into the report.

set -uo pipefail

usage() {
  cat <<'EOF'
Usage: bash scripts/run-gates.sh [--e2e] [--help]

Runs Janusly automated gates from the repo root and prints a markdown summary.

Flags:
  --e2e    Also run pnpm test:e2e (Playwright + Compose). Slower; only run
           when the change touches end-to-end user-facing surface.
  --help   Show this message and exit.
EOF
}

run_e2e=0
for arg in "$@"; do
  case "$arg" in
    --e2e) run_e2e=1 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown flag: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

# Locate the repo root by walking up to the first directory that contains
# pnpm-workspace.yaml. Allows the script to be invoked from anywhere.
repo_root=""
dir="$PWD"
while [ "$dir" != "/" ]; do
  if [ -f "$dir/pnpm-workspace.yaml" ]; then
    repo_root="$dir"
    break
  fi
  dir="$(dirname "$dir")"
done
if [ -z "$repo_root" ]; then
  echo "error: could not find pnpm-workspace.yaml from $PWD upward" >&2
  exit 2
fi
cd "$repo_root"

declare -a results=()
overall=0

run_gate() {
  local name="$1"
  shift
  local start
  start="$(date +%s)"
  local logfile
  logfile="$(mktemp -t janus-gate-XXXXXX.log)"
  if "$@" >"$logfile" 2>&1; then
    local elapsed=$(( $(date +%s) - start ))
    results+=("- ${name}: PASS (${elapsed}s)")
  else
    local elapsed=$(( $(date +%s) - start ))
    overall=1
    local tail
    tail="$(tail -n 10 "$logfile" | sed 's/^/    /')"
    results+=("- ${name}: FAIL (${elapsed}s)
    Log tail (last 10 lines):
${tail}
    Full log: ${logfile}")
  fi
}

run_gate "pnpm build" pnpm build
run_gate "pnpm test"  pnpm test

if [ "$run_e2e" -eq 1 ]; then
  run_gate "pnpm test:e2e" pnpm test:e2e
fi

echo "## Gates"
echo
for line in "${results[@]}"; do
  echo "$line"
done
echo

if [ "$overall" -eq 0 ]; then
  echo "Overall: PASS"
else
  echo "Overall: FAIL"
fi

exit "$overall"
