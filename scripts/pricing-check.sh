#!/usr/bin/env bash
# Opt-in, needs network: compares the internal/ai price catalog with the
# vendor's published per-model input and output rates. Never part of CI.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
url=${JANUSLY_PRICING_PAGE_URL:-https://platform.claude.com/docs/en/about-claude/pricing}
tmp=$(mktemp -d "${TMPDIR:-/tmp}/janusly-pricing-check.XXXXXX")
trap 'rm -rf -- "$tmp"' EXIT

if [[ -n "${JANUSLY_PRICING_PAGE_FILE:-}" ]]; then
  source_label=$JANUSLY_PRICING_PAGE_FILE
  cp -- "$JANUSLY_PRICING_PAGE_FILE" "$tmp/page.html"
else
  source_label=$url
  curl -fsSL --max-time 60 "$url" -o "$tmp/page.html"
fi

(cd "$root" && go run ./cmd/pricing --json) >"$tmp/catalog.json"
jq -r '.snapshotDate' "$tmp/catalog.json" >"$tmp/snapshot"
jq -r '.models | to_entries[] | [.key, .value.inputUsdPer1M, .value.outputUsdPer1M] | @tsv' \
  "$tmp/catalog.json" | LC_ALL=C sort >"$tmp/catalog.tsv"

# Rows of the first table whose header names Input and Output columns; the
# column positions come from that header, never from the order of amounts.
tr '\r\n' '  ' <"$tmp/page.html" | awk '
  function text(cell) {
    gsub(/<[^>]*>/, " ", cell)
    gsub(/&nbsp;|&#160;/, " ", cell)
    gsub(/[[:space:]]+/, " ", cell)
    sub(/^ /, "", cell)
    sub(/ $/, "", cell)
    return cell
  }
  function amount(cell) {
    return match(cell, /\$[0-9]+(\.[0-9]+)?/) ? substr(cell, RSTART + 1, RLENGTH - 1) : ""
  }
  { page = page $0 }
  END {
    ntables = split(page, tables, /<\/[Tt][Aa][Bb][Ll][Ee]>/)
    for (t = 1; t <= ntables; t++) {
      if (!sub(/^.*<[Tt][Aa][Bb][Ll][Ee][ >]/, "", tables[t])) continue
      input = 0; output = 0
      nrows = split(tables[t], rows, /<\/[Tt][Rr]>/)
      for (r = 1; r <= nrows; r++) {
        ncells = split(rows[r], cells, /<\/[Tt][HhDd]>/)
        for (c = 1; c <= ncells; c++) cells[c] = text(cells[c])
        if (!input || !output) {
          for (c = 1; c <= ncells; c++) {
            if (cells[c] ~ /^(Base )?Input( Tokens)?$/) input = c
            if (cells[c] ~ /^Output( Tokens)?$/) output = c
          }
          continue
        }
        if (!match(cells[1], /^Claude [A-Z][A-Za-z]* [0-9]+(\.[0-9]+)?/)) continue
        name = substr(cells[1], RSTART, RLENGTH)
        if (name in seen) continue
        seen[name] = 1
        id = tolower(name)
        gsub(/[ .]/, "-", id)
        printf "%s\t%s\t%s\t%s\n", id, name, amount(cells[input]), amount(cells[output])
      }
      if (input && output) exit
    }
  }' >"$tmp/page.tsv"

if [[ ! -s "$tmp/page.tsv" ]]; then
  printf 'pricing-check: no model pricing table with Input and Output columns found in %s\n' "$source_label" >&2
  exit 1
fi

printf 'Catalog snapshot %s against %s\n\n' "$(cat "$tmp/snapshot")" "$source_label"
# Dated catalog aliases (claude-opus-4-5-20251101) inherit their family's row.
awk -F'\t' '
  FNR == NR { input[$1] = $3; output[$1] = $4; name[$1] = $2; order[++pages] = $1; next }
  {
    family = $1
    sub(/-20[0-9][0-9][0-1][0-9][0-3][0-9]$/, "", family)
    used[family] = 1
    listed = "-"
    if (!(family in input)) {
      status = "MISSING: not listed on the page"; bad++
    } else {
      listed = input[family] " / " output[family]
      if (input[family] == "" || output[family] == "" || input[family] + 0 != $2 + 0 || output[family] + 0 != $3 + 0) {
        status = "MISMATCH"; bad++
      } else {
        status = "ok"
      }
    }
    printf "%-28s %-14s %-14s %s\n", $1, $2 " / " $3, listed, status
    total++
  }
  BEGIN { printf "%-28s %-14s %-14s %s\n", "model", "catalog USD", "page USD", "status" }
  END {
    for (i = 1; i <= pages; i++) if (!(order[i] in used)) extra = extra (extra ? ", " : "") name[order[i]]
    if (extra) printf "\nOn the page but not in the catalog (informational): %s\n", extra
    if (bad) { printf "\npricing-check: %d of %d catalog entries disagree with the page\n", bad, total > "/dev/stderr"; exit 1 }
    printf "\npricing-check: %d/%d catalog entries match the page\n", total, total
  }' "$tmp/page.tsv" "$tmp/catalog.tsv"
