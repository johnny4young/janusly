#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
action=${1:-}
path=${2:-}
compose_project=${COMPOSE_PROJECT_NAME:-janusly}
compose_file=${JANUSLY_RECOVERY_COMPOSE_FILE:-$root/docker-compose.yml}
database_service=${JANUSLY_RECOVERY_DATABASE_SERVICE:-postgres}
application_service=${JANUSLY_RECOVERY_APPLICATION_SERVICE:-janusly}
database_name=${JANUSLY_RECOVERY_DATABASE_NAME:-janusly}
database_user=${JANUSLY_RECOVERY_DATABASE_USER:-janusly}
expected_postgres_major=18
manifest_name=manifest.json
dump_name=database.dump

umask 077

usage() {
  cat <<'EOF'
usage: scripts/postgres-local-recovery.sh backup OUTPUT_DIR
       scripts/postgres-local-recovery.sh restore INPUT_DIR
       scripts/postgres-local-recovery.sh selftest

restore requires CONFIRM=restore, an empty PostgreSQL 18 database, and a
stopped Janusly application service. Managed credentials additionally require
the same JANUSLY_CREDENTIAL_MASTER_KEY used when the backup was created.
EOF
}

die() {
  printf 'postgres-local-recovery: %s\n' "$*" >&2
  exit 2
}

validate_name() {
  local label=$1 value=$2
  [[ "$value" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] ||
    die "$label contains unsupported characters"
}

validate_configuration() {
  validate_name "Compose project" "$compose_project"
  validate_name "database service" "$database_service"
  validate_name "application service" "$application_service"
  validate_name "database name" "$database_name"
  validate_name "database user" "$database_user"
  [[ -f "$compose_file" && ! -L "$compose_file" ]] ||
    die "Compose file must be a regular non-symlink: $compose_file"
}

compose() {
  docker compose -f "$compose_file" -p "$compose_project" "$@"
}

schema_source_sha256() {
  (
    cd "$root"
    while IFS= read -r -d '' file; do
      printf '%s\0' "$file"
      cat "$file"
    done < <(find internal/migrate/sql -type f -name '*.sql' -print0 | sort -z)
  ) | shasum -a 256 | awk '{print $1}'
}

sha256_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

credential_key_fingerprint() {
  [[ -n ${JANUSLY_CREDENTIAL_MASTER_KEY:-} ]] ||
    die "JANUSLY_CREDENTIAL_MASTER_KEY is required for managed credential recovery"
  printf '%s' "$JANUSLY_CREDENTIAL_MASTER_KEY" | shasum -a 256 | awk '{print $1}'
}

query_scalar() {
  local sql=$1
  compose exec -T "$database_service" \
    psql -XAt -v ON_ERROR_STOP=1 -U "$database_user" -d "$database_name" -c "$sql"
}

server_major() {
  local version_num
  version_num=$(query_scalar 'SHOW server_version_num')
  [[ "$version_num" =~ ^[0-9]+$ ]] || die "PostgreSQL returned an invalid server_version_num"
  printf '%s\n' "$((version_num / 10000))"
}

assert_expected_server() {
  local actual
  actual=$(server_major)
  [[ "$actual" == "$expected_postgres_major" ]] ||
    die "PostgreSQL major $actual is unsupported; expected $expected_postgres_major"
}

managed_credential_count() {
  query_scalar "SELECT count(*) FROM public.credentials WHERE secret_ref LIKE 'janusly-secret://%';"
}

migration_version() {
  query_scalar "SELECT max(version_id) FILTER (WHERE is_applied) FROM public.janusly_schema_version;"
}

backup_database() {
  [[ -n "$path" ]] || die "backup requires OUTPUT_DIR"
  [[ ! -e "$path" && ! -L "$path" ]] || die "backup output already exists: $path"
  assert_expected_server

  local version managed_count key_fingerprint source_sha created_at commit tree dirty parent base temporary
  version=$(migration_version)
  [[ "$version" =~ ^[0-9]+$ ]] || die "database is not migrated"
  managed_count=$(managed_credential_count)
  [[ "$managed_count" =~ ^[0-9]+$ ]] || die "managed credential count is invalid"
  if ((managed_count > 0)); then
    key_fingerprint=$(credential_key_fingerprint)
  else
    key_fingerprint=not-required
  fi
  source_sha=$(schema_source_sha256)
  created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  commit=$(git -C "$root" rev-parse HEAD)
  tree=$(git -C "$root" rev-parse 'HEAD^{tree}')
  if [[ -z $(git -C "$root" status --porcelain --untracked-files=normal) ]]; then dirty=false; else dirty=true; fi

  parent=$(dirname "$path")
  base=$(basename "$path")
  mkdir -p "$parent"
  temporary="$parent/.${base}.tmp.$$"
  [[ ! -e "$temporary" && ! -L "$temporary" ]] || die "temporary output already exists"
  mkdir "$temporary"
  trap 'rm -rf -- "$temporary"' EXIT INT TERM

  compose exec -T "$database_service" \
    pg_dump -U "$database_user" -d "$database_name" \
      --format=custom --compress=9 --no-owner --no-privileges \
      >"$temporary/$dump_name"
  [[ -s "$temporary/$dump_name" ]] || die "pg_dump produced an empty backup"
  local dump_sha
  dump_sha=$(sha256_file "$temporary/$dump_name")

  jq -n \
    --argjson formatVersion 1 \
    --arg format postgres-custom \
    --arg createdAt "$created_at" \
    --arg database "$database_name" \
    --argjson postgresMajor "$expected_postgres_major" \
    --argjson migrationVersion "$version" \
    --arg schemaSourceSha256 "$source_sha" \
    --arg dumpFile "$dump_name" \
    --arg dumpSha256 "$dump_sha" \
    --argjson managedCredentialCount "$managed_count" \
    --arg credentialKeyFingerprint "$key_fingerprint" \
    --arg commit "$commit" \
    --arg tree "$tree" \
    --argjson dirty "$dirty" \
    '{formatVersion:$formatVersion,format:$format,createdAt:$createdAt,database:$database,postgresMajor:$postgresMajor,migrationVersion:$migrationVersion,schemaSourceSha256:$schemaSourceSha256,dump:{file:$dumpFile,sha256:$dumpSha256},managedCredentials:{count:$managedCredentialCount,keyFingerprint:$credentialKeyFingerprint},git:{commit:$commit,tree:$tree,dirty:$dirty}}' \
    >"$temporary/$manifest_name"
  jq -e . "$temporary/$manifest_name" >/dev/null
  mv "$temporary" "$path"
  trap - EXIT INT TERM
  jq -n --arg status created --arg path "$path" --arg sha256 "$dump_sha" \
    '{status:$status,path:$path,dumpSha256:$sha256}'
}

assert_application_stopped() {
  if compose ps --status running --services | grep -Fxq "$application_service"; then
    die "application service $application_service is running; stop it before restore"
  fi
}

restore_database() {
  [[ ${CONFIRM:-} == restore ]] || die "restore requires CONFIRM=restore"
  [[ -n "$path" ]] || die "restore requires INPUT_DIR"
  [[ -d "$path" && ! -L "$path" ]] || die "backup input must be a non-symlink directory: $path"
  local manifest="$path/$manifest_name"
  [[ -f "$manifest" && ! -L "$manifest" ]] || die "backup manifest is missing"
  jq -e '
    .formatVersion == 1 and
    .format == "postgres-custom" and
    (.createdAt | type == "string") and
    (.database | type == "string") and
    (.postgresMajor | type == "number" and floor == . and . > 0) and
    (.migrationVersion | type == "number" and floor == . and . > 0) and
    (.schemaSourceSha256 | test("^[0-9a-f]{64}$")) and
    (.dump.file | type == "string") and
    (.dump.sha256 | test("^[0-9a-f]{64}$")) and
    (.managedCredentials.count | type == "number" and floor == . and . >= 0) and
    (.managedCredentials.keyFingerprint | type == "string")
  ' "$manifest" >/dev/null || die "backup manifest is invalid"

  local manifest_database manifest_major manifest_version source_sha dump_file expected_dump_sha actual_dump_sha
  local expected_managed_count expected_key_fingerprint actual_key_fingerprint
  manifest_database=$(jq -r '.database' "$manifest")
  manifest_major=$(jq -r '.postgresMajor' "$manifest")
  manifest_version=$(jq -r '.migrationVersion' "$manifest")
  source_sha=$(schema_source_sha256)
  dump_file=$(jq -r '.dump.file' "$manifest")
  expected_dump_sha=$(jq -r '.dump.sha256' "$manifest")
  expected_managed_count=$(jq -r '.managedCredentials.count' "$manifest")
  expected_key_fingerprint=$(jq -r '.managedCredentials.keyFingerprint' "$manifest")

  [[ "$manifest_database" == "$database_name" ]] || die "backup database does not match $database_name"
  [[ "$manifest_major" == "$expected_postgres_major" ]] || die "backup PostgreSQL major is unsupported"
  [[ "$(jq -r '.schemaSourceSha256' "$manifest")" == "$source_sha" ]] ||
    die "backup schema source does not match this checkout"
  [[ "$dump_file" == "$dump_name" ]] || die "backup dump filename is unsupported"
  [[ -f "$path/$dump_file" && ! -L "$path/$dump_file" ]] || die "backup dump is missing"
  actual_dump_sha=$(sha256_file "$path/$dump_file")
  [[ "$actual_dump_sha" == "$expected_dump_sha" ]] || die "backup dump checksum mismatch"
  if [[ "$expected_key_fingerprint" != not-required ]]; then
    [[ "$expected_key_fingerprint" =~ ^[0-9a-f]{64}$ ]] || die "credential key fingerprint is invalid"
    actual_key_fingerprint=$(credential_key_fingerprint)
    [[ "$actual_key_fingerprint" == "$expected_key_fingerprint" ]] ||
      die "credential master key does not match the backup"
  fi

  assert_application_stopped
  assert_expected_server
  local public_relations
  public_relations=$(query_scalar "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S','f');")
  [[ "$public_relations" == 0 ]] || die "restore target is not empty"

  compose exec -T "$database_service" \
    pg_restore -U "$database_user" -d "$database_name" \
      --exit-on-error --no-owner --no-privileges \
      <"$path/$dump_file"

  local restored_version restored_managed_count
  restored_version=$(migration_version)
  [[ "$restored_version" == "$manifest_version" ]] || die "restored migration version does not match manifest"
  restored_managed_count=$(managed_credential_count)
  [[ "$restored_managed_count" == "$expected_managed_count" ]] ||
    die "restored managed credential count does not match manifest"
  if ((restored_managed_count > 0)) && [[ "$expected_key_fingerprint" == not-required ]]; then
    die "restored managed credentials lack a key fingerprint"
  fi
  jq -n --arg status restored --arg path "$path" --argjson migrationVersion "$restored_version" \
    '{status:$status,path:$path,migrationVersion:$migrationVersion}'
}

validate_configuration
case "$action" in
  backup) backup_database ;;
  restore) restore_database ;;
  selftest)
    [[ -z "$path" ]] || die "selftest does not accept a path"
    jq -n \
      --arg project "$compose_project" \
      --argjson postgresMajor "$expected_postgres_major" \
      --arg schemaSourceSha256 "$(schema_source_sha256)" \
      '{project:$project,postgresMajor:$postgresMajor,schemaSourceSha256:$schemaSourceSha256}'
    ;;
  -h|--help) usage ;;
  *) usage >&2; die "unknown action: ${action:-<empty>}" ;;
esac
