#!/usr/bin/env bash
set -Eeuo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
recovery="$root/scripts/postgres-local-recovery.sh"
project_base=${JANUSLY_RECOVERY_DRILL_PROJECT:-janusly-recovery-drill-${UID:-0}-$$}
source_project="$project_base-source"
target_project="$project_base-target"
port_start=${JANUSLY_RECOVERY_DRILL_PORT_START:-55538}
port_end=${JANUSLY_RECOVERY_DRILL_PORT_END:-55737}
source_port=
target_port=
source_attempted=0
target_attempted=0
scratch=

die() {
  printf 'postgres-local-recovery.drill: %s\n' "$*" >&2
  exit 2
}

validate_port() {
  local label=$1 value=$2
  [[ "$value" =~ ^[0-9]+$ ]] || die "$label must be an integer"
  ((value >= 1024 && value <= 65535)) || die "$label must be in 1024..65535"
}

validate_configuration() {
  [[ "$project_base" =~ ^janusly-recovery-drill-[a-z0-9][a-z0-9-]*$ ]] ||
    die 'JANUSLY_RECOVERY_DRILL_PROJECT must start with janusly-recovery-drill-'
  validate_port JANUSLY_RECOVERY_DRILL_PORT_START "$port_start"
  validate_port JANUSLY_RECOVERY_DRILL_PORT_END "$port_end"
  ((port_end > port_start)) || die 'drill needs at least two ports'
}

compose() {
  local project=$1 port=$2
  shift 2
  COMPOSE_PROJECT_NAME="$project" JANUSLY_POSTGRES_HOST_PORT="$port" \
    docker compose -f "$root/docker-compose.yml" -p "$project" "$@"
}

project_has_resources() {
  local project=$1
  [[ -n $(docker ps -aq --filter "label=com.docker.compose.project=$project") ]] ||
    [[ -n $(docker volume ls -q --filter "label=com.docker.compose.project=$project") ]] ||
    [[ -n $(docker network ls -q --filter "label=com.docker.compose.project=$project") ]]
}

cleanup() {
  local status=$? cleanup_failed=0
  trap - EXIT INT TERM
  if ((target_attempted)); then
    compose "$target_project" "$target_port" down --volumes --remove-orphans >&2 || cleanup_failed=1
  fi
  if ((source_attempted)); then
    compose "$source_project" "$source_port" down --volumes --remove-orphans >&2 || cleanup_failed=1
  fi
  if [[ -n "$scratch" ]]; then
    rm -rf -- "$scratch"
  fi
  if ((cleanup_failed)); then
    printf 'postgres-local-recovery.drill: owned Compose cleanup failed\n' >&2
    status=1
  fi
  exit "$status"
}

start_postgres() {
  local role=$1 project=$2 candidate output_file output
  output_file="$scratch/$role-compose.log"
  for ((candidate = port_start; candidate <= port_end; candidate++)); do
    [[ "$candidate" != "$source_port" ]] || continue
    if [[ "$role" == source ]]; then
      source_port=$candidate
      source_attempted=1
    else
      target_port=$candidate
      target_attempted=1
    fi
    if compose "$project" "$candidate" up -d --wait postgres >"$output_file" 2>&1; then
      printf 'postgres-local-recovery.drill: %s=%s port=%s\n' "$role" "$project" "$candidate" >&2
      return
    fi
    output=$(cat "$output_file")
    compose "$project" "$candidate" down --volumes --remove-orphans >&2 ||
      die "could not clean failed $role project $project"
    if grep -Eqi 'address already in use|port is already allocated|bind.*failed' <<<"$output"; then
      continue
    fi
    printf '%s\n' "$output" >&2
    die "PostgreSQL 18 failed to start for $role"
  done
  die "no free PostgreSQL port in $port_start..$port_end for $role"
}

query_scalar() {
  local project=$1 port=$2 sql=$3
  compose "$project" "$port" exec -T postgres \
    psql -XAt -v ON_ERROR_STOP=1 -U janusly -d janusly -c "$sql"
}

run_recovery() {
  local project=$1 port=$2
  shift 2
  COMPOSE_PROJECT_NAME="$project" JANUSLY_POSTGRES_HOST_PORT="$port" \
    JANUSLY_RECOVERY_COMPOSE_FILE="$root/docker-compose.yml" \
    JANUSLY_RECOVERY_DATABASE_SERVICE=postgres \
    JANUSLY_RECOVERY_APPLICATION_SERVICE=janusly \
    JANUSLY_RECOVERY_DATABASE_NAME=janusly \
    JANUSLY_RECOVERY_DATABASE_USER=janusly \
    "$recovery" "$@"
}

database_url() {
  printf 'postgres://janusly:janusly-local@127.0.0.1:%s/janusly?sslmode=disable' "$1"
}

monotonic_millis() {
  python3 -c 'import time; print(time.monotonic_ns() // 1000000)'
}

main() {
  validate_configuration
  case ${1:-run} in
    selftest)
      [[ $# == 1 ]] || die 'selftest takes no further arguments'
      jq -n --arg source "$source_project" --arg target "$target_project" \
        --argjson portStart "$port_start" --argjson portEnd "$port_end" \
        '{sourceProject:$source,targetProject:$target,portRange:{start:$portStart,end:$portEnd}}'
      return
      ;;
    run) [[ $# -le 1 ]] || die 'run takes no further arguments' ;;
    *) die 'usage: postgres-local-recovery.drill.sh [run|selftest]' ;;
  esac
  [[ ${CONFIRM:-} == drill ]] || die 'drill requires CONFIRM=drill'
  for binary in docker jq make python3; do
    command -v "$binary" >/dev/null 2>&1 || die "$binary is required"
  done
  project_has_resources "$source_project" && die "source project already owns resources: $source_project"
  project_has_resources "$target_project" && die "target project already owns resources: $target_project"
  scratch=$(mktemp -d "${TMPDIR:-/tmp}/janusly-recovery-drill.XXXXXX")
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  start_postgres source "$source_project"
  local source_url
  source_url=$(database_url "$source_port")
  make -C "$root" migrate DB_URL="$source_url" >&2
  make -C "$root" migrate DB_URL="$source_url" >&2
  [[ $(query_scalar "$source_project" "$source_port" 'SHOW server_version_num') =~ ^18[0-9]{4}$ ]] ||
    die 'source is not PostgreSQL 18'

  local marker="$project_base" source_version backup_started backup_ms backup_result
  query_scalar "$source_project" "$source_port" \
    "INSERT INTO public.organizations (id, owner_user_id, name) VALUES ('$marker', 'recovery-drill-owner', 'Recovery drill');" >/dev/null
  source_version=$(query_scalar "$source_project" "$source_port" \
    'SELECT max(version_id) FILTER (WHERE is_applied) FROM public.janusly_schema_version;')
  backup_started=$(monotonic_millis)
  backup_result=$(run_recovery "$source_project" "$source_port" backup "$scratch/backup")
  backup_ms=$(( $(monotonic_millis) - backup_started ))
  jq -e '.status == "created" and (.dumpSha256 | test("^[0-9a-f]{64}$"))' \
    <<<"$backup_result" >/dev/null || die 'backup result is invalid'

  local target_recovery_started
  target_recovery_started=$(monotonic_millis)
  start_postgres target "$target_project"
  [[ $(query_scalar "$target_project" "$target_port" \
    "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S','f');") == 0 ]] ||
    die 'target database is not empty before restore'
  local restore_started restore_ms restore_result target_url restored_version marker_count target_recovery_ms
  restore_started=$(monotonic_millis)
  restore_result=$(CONFIRM=restore run_recovery "$target_project" "$target_port" restore "$scratch/backup")
  restore_ms=$(( $(monotonic_millis) - restore_started ))
  jq -e --argjson version "$source_version" \
    '.status == "restored" and .migrationVersion == $version' \
    <<<"$restore_result" >/dev/null || die 'restore result is invalid'
  restored_version=$(query_scalar "$target_project" "$target_port" \
    'SELECT max(version_id) FILTER (WHERE is_applied) FROM public.janusly_schema_version;')
  marker_count=$(query_scalar "$target_project" "$target_port" \
    "SELECT count(*) FROM public.organizations WHERE id = '$marker' AND owner_user_id = 'recovery-drill-owner' AND name = 'Recovery drill';")
  [[ "$restored_version" == "$source_version" && "$marker_count" == 1 ]] ||
    die 'restored migration or sentinel row does not match source'
  if CONFIRM=restore run_recovery "$target_project" "$target_port" restore "$scratch/backup" >"$scratch/repeat.log" 2>&1; then
    die 'restore accepted a nonempty target'
  fi
  grep -Fq 'restore target is not empty' "$scratch/repeat.log" ||
    die 'repeat restore failed for a reason other than the nonempty-target guard'
  target_url=$(database_url "$target_port")
  make -C "$root" migrate DB_URL="$target_url" >&2
  [[ $(query_scalar "$target_project" "$target_port" \
    "SELECT count(*) FROM public.organizations WHERE id = '$marker';") == 1 ]] ||
    die 'post-restore migration changed the sentinel row'
  target_recovery_ms=$(( $(monotonic_millis) - target_recovery_started ))

  jq -n --arg sourceProject "$source_project" --arg targetProject "$target_project" \
    --argjson postgresMajor 18 --argjson migrationVersion "$restored_version" \
    --arg dumpSha256 "$(jq -r '.dump.sha256' "$scratch/backup/manifest.json")" \
    --argjson backupMs "$backup_ms" --argjson restoreMs "$restore_ms" \
    --argjson targetRecoveryMs "$target_recovery_ms" \
    --arg gitCommit "$(git -C "$root" rev-parse HEAD)" \
    '{status:"passed",sourceProject:$sourceProject,targetProject:$targetProject,postgresMajor:$postgresMajor,migrationVersion:$migrationVersion,dumpSha256:$dumpSha256,timingMs:{backup:$backupMs,restore:$restoreMs,targetRecovery:$targetRecoveryMs},sentinelRows:1,repeatRestoreRejected:true,postRestoreMigrationPassed:true,gitCommit:$gitCommit}'
}

main "$@"
