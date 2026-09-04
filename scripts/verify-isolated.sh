#!/usr/bin/env bash
set -Eeuo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
project=${JANUSLY_VERIFY_PROJECT:-janusly-verify-${UID:-0}-$$}
port_override=${JANUSLY_VERIFY_POSTGRES_PORT:-}
port_start=${JANUSLY_VERIFY_PORT_START:-55438}
port_end=${JANUSLY_VERIFY_PORT_END:-55537}
docker_bin=${JANUSLY_VERIFY_DOCKER_BIN:-docker}
make_bin=${JANUSLY_VERIFY_MAKE_BIN:-make}
postgres_port=
attempted=0

usage() {
  cat <<'EOF'
usage: scripts/verify-isolated.sh [selftest|schema]

Runs the repository acceptance gates against a fresh PostgreSQL 18 Compose
project. The harness never reuses or removes the ordinary janusly project.
`schema` migrates the fresh database and regenerates schema.sql from it,
then stops; that is the one supported way to refresh schema.sql.

Environment:
  JANUSLY_VERIFY_PROJECT        owned project name (janusly-verify-* only)
  JANUSLY_VERIFY_POSTGRES_PORT  fixed host port, otherwise scan 55438..55537
  JANUSLY_VERIFY_PORT_START     first scanned port
  JANUSLY_VERIFY_PORT_END       last scanned port
EOF
}

die() {
  printf 'verify-isolated: %s\n' "$*" >&2
  exit 2
}

validate_port() {
  local name=$1 value=$2
  [[ "$value" =~ ^[0-9]+$ ]] || die "$name must be an integer"
  ((value >= 1024 && value <= 65535)) || die "$name must be in 1024..65535"
}

validate_configuration() {
  [[ "$project" =~ ^janusly-verify-[a-z0-9][a-z0-9_-]*$ ]] ||
    die "JANUSLY_VERIFY_PROJECT must start with janusly-verify- and use lowercase project characters"
  [[ "$project" != janusly ]] || die "refusing the ordinary development Compose project"
  validate_port JANUSLY_VERIFY_PORT_START "$port_start"
  validate_port JANUSLY_VERIFY_PORT_END "$port_end"
  ((port_start <= port_end)) || die "verify port range is reversed"
  if [[ -n "$port_override" ]]; then
    validate_port JANUSLY_VERIFY_POSTGRES_PORT "$port_override"
  fi
  command -v "$docker_bin" >/dev/null 2>&1 || die "docker is required"
  command -v "$make_bin" >/dev/null 2>&1 || die "make is required"
}

compose() {
  COMPOSE_PROJECT_NAME="$project" \
  JANUSLY_POSTGRES_HOST_PORT="$postgres_port" \
    "$docker_bin" compose -f "$root/docker-compose.yml" -p "$project" "$@"
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

start_postgres() {
  local candidate output
  local output_file
  output_file=$(mktemp "${TMPDIR:-/tmp}/janusly-verify-compose.XXXXXX")
  trap 'rm -f -- "$output_file"; cleanup' EXIT INT TERM

  if [[ -n "$port_override" ]]; then
    candidate=$port_override
    port_start=$candidate
    port_end=$candidate
  fi

  for ((candidate = port_start; candidate <= port_end; candidate++)); do
    postgres_port=$candidate
    attempted=1
    if compose up -d --wait postgres >"$output_file" 2>&1; then
      rm -f -- "$output_file"
      trap cleanup EXIT INT TERM
      return 0
    fi
    output=$(cat "$output_file")
    compose down --volumes --remove-orphans >/dev/null 2>&1 || true
    if grep -Eqi 'address already in use|port is already allocated|bind.*failed' <<<"$output"; then
      if [[ -n "$port_override" ]]; then
        printf '%s\n' "$output" >&2
        die "configured PostgreSQL port $candidate is unavailable"
      fi
      continue
    fi
    printf '%s\n' "$output" >&2
    die "PostgreSQL 18 failed to start"
  done
  die "no free PostgreSQL port in $port_start..$port_end"
}

main() {
  validate_configuration
  if [[ ${1:-} == selftest ]]; then
    jq -n \
      --arg project "$project" \
      --argjson portStart "$port_start" \
      --argjson portEnd "$port_end" \
      '{project:$project,portRange:{start:$portStart,end:$portEnd}}'
    return
  fi
  local mode=${1:-verify}
  case $mode in
    verify | schema) ;;
    *) usage >&2; die "unexpected arguments" ;;
  esac
  [[ $# -le 1 ]] || { usage >&2; die "unexpected arguments"; }
  project_has_resources && die "refusing pre-existing resources for project $project"
  trap cleanup EXIT INT TERM
  start_postgres

  local database_url="postgres://janusly:janusly-local@127.0.0.1:${postgres_port}/janusly?sslmode=disable"
  printf 'verify-isolated: project=%s postgres=127.0.0.1:%s\n' "$project" "$postgres_port"
  "$make_bin" -C "$root" migrate DB_URL="$database_url"
  "$make_bin" -C "$root" migrate DB_URL="$database_url"
  if [[ $mode == schema ]]; then
    "$make_bin" -C "$root" schema COMPOSE_PROJECT_NAME="$project"
    return
  fi
  "$make_bin" -C "$root" verify-current-db DB_URL="$database_url" COMPOSE_PROJECT_NAME="$project"
}

main "$@"
