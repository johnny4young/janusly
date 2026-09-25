#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
allowlist=${JANUSLY_DEADCODE_ALLOWLIST:-$root/scripts/deadcode-allowlist.txt}
shown=${allowlist#"$root"/}
tmp=$(mktemp -d "${TMPDIR:-/tmp}/janusly-deadcode.XXXXXX")
trap 'rm -rf -- "$tmp"' EXIT

# Every main package under cmd/ is a root, including dev tools such as the
# seeder; deadcode never loads test packages without -test.
(cd "$root" && go tool deadcode \
  -f '{{range .Funcs}}{{printf "%s.%s\n" $.Path .Name}}{{end}}' \
  ./cmd/...) >"$tmp/raw"
grep -v '^$' "$tmp/raw" | LC_ALL=C sort -u >"$tmp/reported" || true

entry_re='^([^[:space:]#]+\.[^[:space:]#/]+)[[:space:]]+#[[:space:]]*[^[:space:]]'
blank_re='^[[:space:]]*(#.*)?$'
failed=0
lineno=0
: >"$tmp/listed"
while IFS= read -r line || [[ -n "$line" ]]; do
  lineno=$((lineno + 1))
  [[ "$line" =~ $blank_re ]] && continue
  if [[ "$line" =~ $entry_re ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}" >>"$tmp/listed"
  else
    printf '%s:%d: malformed entry, want "<import path>.<Func> # <reason>": %s\n' "$shown" "$lineno" "$line" >&2
    failed=1
  fi
done <"$allowlist"

LC_ALL=C sort "$tmp/listed" >"$tmp/allowed.all"
while IFS= read -r dup; do
  printf '%s: duplicate entry: %s\n' "$shown" "$dup" >&2
  failed=1
done < <(uniq -d "$tmp/allowed.all")
uniq "$tmp/allowed.all" >"$tmp/allowed"

while IFS= read -r fn; do
  printf 'deadcode: %s is unreachable from ./cmd/...; delete it, or add to %s:\n  %s # <reason>\n' "$fn" "$shown" "$fn" >&2
  failed=1
done < <(LC_ALL=C comm -23 "$tmp/reported" "$tmp/allowed")

while IFS= read -r fn; do
  printf 'deadcode: %s is no longer reported; delete its line from %s\n' "$fn" "$shown" >&2
  failed=1
done < <(LC_ALL=C comm -13 "$tmp/reported" "$tmp/allowed")

if ((failed)); then
  exit 1
fi
printf 'deadcode: %d unreachable function(s), all allowlisted in %s\n' "$(wc -l <"$tmp/reported" | tr -d ' ')" "$shown"
