#!/usr/bin/env bash
# Classify the complete diff, including deleted and renamed inputs. Unknown
# paths or a missing base run every lane rather than silently skipping checks.
set -euo pipefail
[[ $# == 2 ]] || { echo 'usage: ci-changes.sh BASE HEAD' >&2; exit 2; }
base=$1 head=$2
if [[ ! "$head" =~ ^[0-9a-fA-F]{40}$ ]] || ! git cat-file -e "$head^{commit}"; then
  echo 'ci-changes: invalid head commit' >&2; exit 2
fi
web=false go=false website=false
if [[ ! "$base" =~ ^[0-9a-fA-F]{40}$ ]] || ! git cat-file -e "$base^{commit}" 2>/dev/null; then
  web=true go=true website=true
else
  paths=$(mktemp "${TMPDIR:-/tmp}/janusly-ci-paths.XXXXXX")
  trap 'rm -f -- "$paths"' EXIT
  # Never turn a failed git diff into an empty successful classification.
  git diff --no-renames --name-only -z "$base" "$head" -- > "$paths"
  while IFS= read -r -d '' path; do
    case "$path" in
      website/*|.github/workflows/deploy-website.yml|.github/workflows/website-check.yml) website=true ;;
      docs/*|*.md) ;;
      web/*) web=true ;;
      contract/*|internal/contract/*) web=true; go=true ;;
      cmd/*|internal/*|e2e/*|go.mod|go.sum|schema.sql|sqlc.yaml|.golangci.yml) go=true ;;
      *) web=true; go=true; website=true ;;
    esac
  done < "$paths"
fi
product=false
if [[ "$web" == true || "$go" == true ]]; then product=true; fi
printf 'web=%s\ngo=%s\nwebsite=%s\nproduct=%s\n' "$web" "$go" "$website" "$product"
