#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
project=${JANUSLY_E2E_PROJECT:-janusly-e2e-${UID:-0}-$$}
app_port=${JANUSLY_E2E_PORT:-33001}
postgres_port=${JANUSLY_E2E_POSTGRES_PORT:-35432}
pnpm_command=${PNPM:-pnpm --ignore-workspace}
docker_bin=${JANUSLY_E2E_DOCKER_BIN:-docker}
attempted=0

usage() {
  cat <<'EOF'
usage: scripts/test-e2e.sh [selftest]

Runs the executable browser lane in a fresh, uniquely owned Compose project.
The harness refuses pre-existing project resources and never removes the
ordinary development project.
EOF
}

die() {
  printf 'test-e2e: %s\n' "$*" >&2
  exit 2
}

validate_port() {
  local name=$1 value=$2
  [[ "$value" =~ ^[0-9]+$ ]] || die "$name must be an integer"
  ((value >= 1024 && value <= 65535)) || die "$name must be in 1024..65535"
}

validate_configuration() {
  [[ "$project" =~ ^janusly-e2e-[a-z0-9][a-z0-9_-]*$ ]] ||
    die "JANUSLY_E2E_PROJECT must start with janusly-e2e- and use lowercase project characters"
  [[ "$project" != janusly-e2e ]] || die "refusing the historical shared E2E project"
  validate_port JANUSLY_E2E_PORT "$app_port"
  validate_port JANUSLY_E2E_POSTGRES_PORT "$postgres_port"
  [[ "$app_port" != "$postgres_port" ]] || die "application and PostgreSQL ports must differ"
}

# The lane must be hermetic and free: Compose auto-loads the repository
# .env, so a developer's real ANTHROPIC_API_KEY would otherwise reach the
# container, spend provider credits, and break the smoke spec that asserts
# the deterministic $0 fallback. Blank the credential for this stack only.
# The master key is a fixed throwaway for this isolated stack: without
# one the seeder's credential writes are refused, which would leave the
# documented first-run path untested.
e2e_master_key="e2e0000000000000000000000000000000000000000000000000000000000000"

compose() {
  COMPOSE_PROJECT_NAME="$project" \
  JANUSLY_HOST_PORT="$app_port" \
  JANUSLY_POSTGRES_HOST_PORT="$postgres_port" \
  ALLOW_PRIVATE_HTTP_TARGETS=true \
  JANUSLY_CREDENTIAL_MASTER_KEY="$e2e_master_key" \
  ANTHROPIC_API_KEY= \
    "$docker_bin" compose -p "$project" "$@"
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if ((attempted)); then
    compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  exit "$status"
}

project_has_resources() {
  [[ -n $("$docker_bin" ps -aq --filter "label=com.docker.compose.project=$project") ]] ||
    [[ -n $("$docker_bin" volume ls -q --filter "label=com.docker.compose.project=$project") ]] ||
    [[ -n $("$docker_bin" network ls -q --filter "label=com.docker.compose.project=$project") ]]
}

validate_configuration
if [[ ${1:-} == selftest ]]; then
  [[ $# == 1 ]] || { usage >&2; die "unexpected arguments"; }
  jq -n --arg project "$project" --argjson appPort "$app_port" --argjson postgresPort "$postgres_port" \
    '{project:$project,ports:{application:$appPort,postgres:$postgresPort}}'
  exit 0
fi
[[ $# == 0 ]] || { usage >&2; die "unexpected arguments"; }
command -v "$docker_bin" >/dev/null 2>&1 || die "docker is required"
project_has_resources && die "refusing pre-existing resources for project $project"
trap cleanup EXIT INT TERM
attempted=1

cd "$root"
compose up -d --wait postgres
compose build janusly
compose run --rm janusly migrate
compose up -d janusly

origin="http://127.0.0.1:$app_port"
for _ in $(seq 1 120); do
  if curl --fail --silent "$origin/healthz" >/dev/null; then
    break
  fi
  sleep 1
done
curl --fail --silent "$origin/healthz" >/dev/null

# The seeder IS the documented first-run path; running it here means a
# regression in it fails CI instead of the next fresh install. Idempotent
# by design, so re-running against a warm stack is safe.
(cd "$root" && JANUSLY_SEED_API="$origin" JANUSLY_SEED_ORG=default go run ./cmd/seed)

cd "$root/web"
playwright=(./node_modules/.bin/playwright)
if [[ ! -x ${playwright[0]} ]]; then
  # Installation remains pnpm-owned; this fallback only preserves the
  # documented nested-worktree command when node_modules is not materialized.
  read -r -a playwright <<<"$pnpm_command exec playwright"
fi
PLAYWRIGHT_SKIP_WEB_SERVER=1 \
JANUSLY_SMOKE=1 \
JANUSLY_TEXT_SEARCH_E2E=1 \
JANUSLY_E2E_RUNTIME_BASE_URL="$origin" \
E2E_API_URL="$origin" \
E2E_UPSTREAM_HOST=host.docker.internal \
E2E_UPSTREAM_BIND=0.0.0.0 \
  "${playwright[@]}" test e2e/janusly-smoke.spec.ts e2e/text-search.spec.ts --project=chromium
