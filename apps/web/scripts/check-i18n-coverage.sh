#!/usr/bin/env bash
# check-i18n-coverage.sh
#
# Heuristic grep over added lines in `git diff --cached` looking for
# user-facing strings in `apps/web/src/**` that bypass the i18n chokepoint at
# `apps/web/src/i18n`.
#
# Reports four kinds of suspect:
#   1. JSX text nodes that look like a human-readable phrase (`>Some Text<`)
#      not already wrapped in `t(...)`.
#   2. `aria-label` / `placeholder` / `title` / `alt` attributes with raw
#      string literals that look like a human-readable phrase.
#   3. `addToast(...)` calls whose first argument starts with a literal
#      capitalised word (i.e. an English sentence rather than a `t(...)`).
#   4. Direct imports from `i18next` / `react-i18next` outside the i18n
#      module — every consumer must go through `apps/web/src/i18n`.
#
# Exit 0 when nothing suspicious shows up; exit 1 (with line-by-line
# findings) otherwise. False positives are tolerable — the reviewer is
# expected to skim the report.
#
# Used by the repository's localization coverage gate.
set -u

cd "$(git rev-parse --show-toplevel)" || exit 0

staged=$(git diff --cached --name-only -- 'apps/web/src/*.tsx' 'apps/web/src/*.ts' \
  | grep -v '\.test\.' \
  | grep -v '/i18n/' \
  || true)

[[ -z "$staged" ]] && exit 0

problems=0
report() {
  problems=1
  printf '%s\n' "$1"
}

for f in $staged; do
  [[ -f "$f" ]] || continue

  added=$(git diff --cached --unified=0 -- "$f" \
    | awk '
      /^@@/ {
        if (match($0, /\+[0-9]+(,[0-9]+)?/)) {
          spec = substr($0, RSTART + 1, RLENGTH - 1)
          split(spec, parts, ",")
          line = parts[1] - 1
        }
        next
      }
      /^\+\+\+/ { next }
      /^\+/ { line++; print line ":" substr($0, 2) }
    ')
  [[ -z "$added" ]] && continue

  # 1. JSX text node with mayúscula inicial heurística — phrase-like literal.
  if matches=$(printf '%s\n' "$added" | grep -E '>[[:space:]]*[A-Z][[:alpha:]][^<>{}]*<' | grep -v 't(' || true); then
    if [[ -n "$matches" ]]; then
      report "[i18n] $f — possible raw JSX text:"
      printf '  %s\n' "$matches"
    fi
  fi

  # 2. Common attribute literals that look like phrases.
  if matches=$(printf '%s\n' "$added" | grep -E '(aria-label|placeholder|title|alt)="[A-Z][^"]+"' || true); then
    if [[ -n "$matches" ]]; then
      report "[i18n] $f — possible raw attribute string:"
      printf '  %s\n' "$matches"
    fi
  fi

  # 3. addToast() with a literal first argument.
  if matches=$(printf '%s\n' "$added" | grep -E "addToast\\(['\"][A-Z]" || true); then
    if [[ -n "$matches" ]]; then
      report "[i18n] $f — possible raw toast literal:"
      printf '  %s\n' "$matches"
    fi
  fi

  # 4. Direct imports from i18next / react-i18next outside the i18n module.
  if [[ "$f" != *"/i18n/"* ]]; then
    if matches=$(printf '%s\n' "$added" | grep -E "from ['\"](i18next|react-i18next)['\"]" || true); then
      if [[ -n "$matches" ]]; then
        report "[i18n] $f — direct i18next / react-i18next import (use apps/web/src/i18n):"
        printf '  %s\n' "$matches"
      fi
    fi
  fi
done

if [[ "$problems" -eq 1 ]]; then
  echo
  echo "Wrap user-facing strings via useT()/t() from apps/web/src/i18n, or whitelist"
  echo "via the script's exemption list (technical identifiers, brand codes, etc.)."
fi

exit "$problems"
