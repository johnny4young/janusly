#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
bash -n "$root/scripts/pricing-check.sh"
fixture="$root/scripts/testdata/pricing-page.html"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/janusly-pricing-check-test.XXXXXX")
trap 'rm -rf -- "$tmp"' EXIT

# Offline: the page is a fixture, the catalog is the real go run ./cmd/pricing --json.
check() {
  JANUSLY_PRICING_PAGE_FILE="$1" JANUSLY_PRICING_PAGE_URL=http://127.0.0.1:9/unreachable \
    bash "$root/scripts/pricing-check.sh" >"$tmp/out" 2>&1
}
expect_failure() {
  local page=$1 pattern=$2
  if check "$page"; then
    echo "pricing-check accepted $page" >&2; cat "$tmp/out" >&2; exit 1
  fi
  grep -E -- "$pattern" "$tmp/out" >/dev/null || {
    echo "pricing-check output lacks /$pattern/" >&2; cat "$tmp/out" >&2; exit 1
  }
}

check "$fixture" || { cat "$tmp/out" >&2; exit 1; }
grep -E '^claude-opus-4-5-20251101 +5 / 25 +5 / 25 +ok$' "$tmp/out" >/dev/null
grep -F 'catalog entries match the page' "$tmp/out" >/dev/null
# Only the first pricing table counts: the later table lists Sonnet 5 at 4/20.
grep -E '^claude-sonnet-5 +2 / 10 +2 / 10 +ok$' "$tmp/out" >/dev/null
# "Claude Opus 5.5" is its own row, not the "Claude Opus 5" family.
grep -E '^claude-opus-5-5 +4 / 20 +4 / 20 +ok$' "$tmp/out" >/dev/null
grep -E '^claude-opus-5 +5 / 25 +5 / 25 +ok$' "$tmp/out" >/dev/null

# Sonnet 5's first $10 cell is its output rate (input is $2).
sed "/Claude Sonnet 5</ s/[\$]10</\$12</" "$fixture" >"$tmp/mismatch.html"
expect_failure "$tmp/mismatch.html" '^claude-sonnet-5 +2 / 10 +2 / 12 +MISMATCH$'

grep -v 'Claude Opus 4.8<' "$fixture" >"$tmp/missing.html"
expect_failure "$tmp/missing.html" '^claude-opus-4-8 .*MISSING: not listed on the page$'

printf '<html><body><p>No tables here.</p></body></html>\n' >"$tmp/empty.html"
expect_failure "$tmp/empty.html" 'no model pricing table'

echo 'pricing-check tests passed (match, mismatch, missing model, no table)'
