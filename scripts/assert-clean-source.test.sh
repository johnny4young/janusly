#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
bash -n "$root/scripts/assert-clean-source.sh"

tmp=$(mktemp -d "${TMPDIR:-/tmp}/janusly-clean-source-test.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
git -C "$tmp" init -q
git -C "$tmp" config user.email qualification@example.invalid
git -C "$tmp" config user.name Qualification
printf 'tracked\n' >"$tmp/tracked.txt"
git -C "$tmp" add tracked.txt
git -C "$tmp" commit -qm baseline

JANUSLY_SOURCE_ROOT="$tmp" "$root/scripts/assert-clean-source.sh"

printf 'dirty\n' >>"$tmp/tracked.txt"
if JANUSLY_SOURCE_ROOT="$tmp" "$root/scripts/assert-clean-source.sh" >/dev/null 2>&1; then
  echo "assert-clean-source accepted a modified tracked file" >&2
  exit 1
fi
git -C "$tmp" checkout -q -- tracked.txt

printf 'untracked\n' >"$tmp/untracked.txt"
if JANUSLY_SOURCE_ROOT="$tmp" "$root/scripts/assert-clean-source.sh" >/dev/null 2>&1; then
  echo "assert-clean-source accepted an untracked file" >&2
  exit 1
fi

echo "assert-clean-source tests passed"
