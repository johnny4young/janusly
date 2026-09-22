#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/janusly-ci-test.XXXXXX")
trap 'rm -rf -- "$tmp"' EXIT
bash -n "$root/scripts/ci-changes.sh" "$root/scripts/ci-gate.sh"
git init -q "$tmp/repo"
cd "$tmp/repo"
git config user.name 'CI fixture'
git config user.email 'ci-fixture@example.invalid'
git -c commit.gpgsign=false commit --allow-empty -qm baseline
base=$(git rev-parse HEAD)

check_paths() {
  local expected=$1 path actual
  shift
  git rm -qr --ignore-unmatch .
  for path in "$@"; do mkdir -p "$(dirname "$path")"; printf 'fixture\n' > "$path"; done
  git add .
  git -c commit.gpgsign=false commit --allow-empty -qm fixture
  actual=$(bash "$root/scripts/ci-changes.sh" "$base" "$(git rev-parse HEAD)" | tr '\n' ' ')
  [[ "$actual" == "$expected" ]] || { printf 'classification: %s != %s\n' "$actual" "$expected" >&2; exit 1; }
}
check_paths 'web=true go=false website=false product=true ' web/src/read.ts
check_paths 'web=false go=true website=false product=true ' internal/engine/worker.go
check_paths 'web=false go=false website=false product=false ' docs/guide.md README.md
check_paths 'web=false go=false website=true product=false ' website/src/content/about.md
check_paths 'web=false go=false website=true product=false ' .github/workflows/website-check.yml
check_paths 'web=false go=false website=true product=false ' .github/workflows/deploy-website.yml
check_paths 'web=true go=true website=false product=true ' contract/openapi.json
check_paths 'web=true go=true website=false product=true ' internal/contract/routes.go
check_paths 'web=true go=true website=true product=true ' scripts/test-e2e.sh
check_paths 'web=true go=true website=true product=true ' .github/workflows/ci.yml
check_paths 'web=true go=true website=true product=true ' unknown-input
check_paths 'web=true go=false website=true product=true ' web/src/read.ts website/package.json
check_paths 'web=true go=false website=false product=true ' $'web/src/line\nbreak.ts'
# Deletion and cross-owner rename must still run the lane of the removed input.
old=$(git rev-parse HEAD)
git rm -qr .
mkdir -p docs; printf 'fixture\n' > docs/moved.md
git add .; git -c commit.gpgsign=false commit -qm move
actual=$(bash "$root/scripts/ci-changes.sh" "$old" "$(git rev-parse HEAD)")
grep -qx 'web=true' <<< "$actual"
head=$(git rev-parse HEAD)
for missing in '' 0000000000000000000000000000000000000000; do
  [[ $(bash "$root/scripts/ci-changes.sh" "$missing" "$head" | grep -c '=true') == 4 ]]
done
[[ $(bash "$root/scripts/ci-changes.sh" "$head" "$head" | grep -c '=false') == 4 ]]
if bash "$root/scripts/ci-changes.sh" "$base" bad-head >/dev/null 2>&1; then echo 'invalid head passed' >&2; exit 1; fi

# A diff execution error must not be mistaken for an empty diff.
real_git=$(command -v git)
mkdir "$tmp/bin"
cat > "$tmp/bin/git" <<'GIT'
#!/usr/bin/env bash
if [[ $1 == diff ]]; then exit 9; fi
exec "$CI_FIXTURE_REAL_GIT" "$@"
GIT
chmod +x "$tmp/bin/git"
if CI_FIXTURE_REAL_GIT="$real_git" PATH="$tmp/bin:$PATH" bash "$root/scripts/ci-changes.sh" "$base" "$head" >/dev/null 2>&1; then
  echo 'git diff failure passed' >&2; exit 1
fi

# Exercise every flag combination and every failing/skipped/missing lane result.
for web in true false; do for go in true false; do for website in true false; do
  product=false
  if [[ "$web" == true || "$go" == true ]]; then product=true; fi
  needs=$(jq -n --arg web "$web" --arg go "$go" --arg website "$website" --arg product "$product" '
    {changes:{result:"success",outputs:{web:$web,go:$go,website:$website,product:$product}}} +
    ({frontend:$web,backend:$go,integration:$go,ha:$go,parity:$product,e2e:$product,website:$website} |
      with_entries(.value = {result:(if .value == "true" then "success" else "skipped" end)}))')
  NEEDS_JSON="$needs" bash "$root/scripts/ci-gate.sh" >/dev/null
  for job in changes frontend backend integration ha parity e2e website; do
    for result in failure cancelled missing skipped success; do
      [[ $(jq -r --arg job "$job" '.[$job].result' <<< "$needs") == "$result" ]] && continue
      broken=$(jq --arg job "$job" --arg result "$result" '.[$job].result = $result' <<< "$needs")
      if NEEDS_JSON="$broken" bash "$root/scripts/ci-gate.sh" >/dev/null 2>&1; then
        echo "gate accepted $job=$result" >&2; exit 1
      fi
    done
  done
  for key in web go website product; do
    broken=$(jq --arg key "$key" 'del(.changes.outputs[$key])' <<< "$needs")
    if NEEDS_JSON="$broken" bash "$root/scripts/ci-gate.sh" >/dev/null 2>&1; then echo "missing $key passed" >&2; exit 1; fi
  done
  broken=$(jq '.changes.outputs.product = (if .changes.outputs.product == "true" then "false" else "true" end)' <<< "$needs")
  if NEEDS_JSON="$broken" bash "$root/scripts/ci-gate.sh" >/dev/null 2>&1; then echo 'inconsistent product passed' >&2; exit 1; fi
done; done; done
printf 'CI classification and fail-closed gate fixtures passed\n'
