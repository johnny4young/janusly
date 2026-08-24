#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
profile=${1:-all}
project=${JANUSLY_QUALIFICATION_PROJECT:-janusly-qualification-app}
auth_project=janusly-qualification-auth
app_port=${JANUSLY_QUALIFICATION_APP_PORT:-7310}
postgres_port=${JANUSLY_QUALIFICATION_POSTGRES_PORT:-7438}
metrics_port=${JANUSLY_QUALIFICATION_METRICS_PORT:-7464}
credential_master_key=0a6ee99978435f3e242e19aa61839045c6c1a5f1f5e63558f9d40706702570c7
origin="http://127.0.0.1:${app_port}"
supabase_public_url=http://127.0.0.1:7431
supabase_internal_url=http://host.docker.internal:7431
supabase_home=${JANUSLY_SUPABASE_HOME:-/tmp/janusly-supabase-home-${UID}}
supabase_bin="$root/web/node_modules/.bin/supabase"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
evidence_root=${JANUSLY_EVIDENCE_DIR:-$root/output/qualification/$stamp/$profile}
status=failed
started=0

usage() {
  cat <<'EOF'
usage: scripts/qualification-local.sh PROFILE

PROFILE: clean | identity | security | tenant | recovery | all | selftest

Destructive profiles require CONFIRM=reset. They may remove only the fixed
janusly-qualification-app Compose project and janusly-qualification-auth
Supabase project.
EOF
}

die() {
  printf 'qualification: %s\n' "$*" >&2
  exit 2
}

validate_configuration() {
  case "$profile" in
    clean|identity|security|tenant|recovery|all|selftest) ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown profile: $profile" ;;
  esac
  [[ "$project" =~ ^janusly-qualification-[a-z0-9-]+$ ]] ||
    die "JANUSLY_QUALIFICATION_PROJECT must start with janusly-qualification-"
  [[ "$project" != janusly ]] || die "refusing the ordinary development Compose project"
  for port in "$app_port" "$postgres_port" "$metrics_port"; do
    if [[ ! "$port" =~ ^[0-9]+$ ]] || ((port < 1024 || port > 65535)); then
      die "qualification ports must be integers in 1024..65535"
    fi
  done
  [[ "$app_port" != "$postgres_port" && "$app_port" != "$metrics_port" && "$postgres_port" != "$metrics_port" ]] ||
    die "qualification ports must be distinct"
  [[ -x "$supabase_bin" ]] ||
    die "Supabase CLI is missing; run make frontend-install"
}

supabase() {
  mkdir -p "$supabase_home"
  HOME="$supabase_home" \
  SUPABASE_TELEMETRY_DISABLED=1 \
  DO_NOT_TRACK=1 \
    "$supabase_bin" --workdir "$root" "$@"
}

compose() {
  COMPOSE_PROJECT_NAME="$project" \
  JANUSLY_HOST_PORT="$app_port" \
  JANUSLY_POSTGRES_HOST_PORT="$postgres_port" \
  JANUSLY_INTERNAL_HOST_PORT="$metrics_port" \
  JANUSLY_INTERNAL_HOST=0.0.0.0 \
  JANUSLY_ENV=production \
  JANUSLY_BUILD_COMMIT="$(git -C "$root" rev-parse HEAD)" \
  JANUSLY_BUILD_TREE="$(git -C "$root" rev-parse 'HEAD^{tree}')" \
  JANUSLY_BUILD_ID="$(git -C "$root" rev-parse --short HEAD)" \
  JANUSLY_RESUME_TOKEN_SECRET=qualification-resume-token-secret-not-for-production \
  JANUSLY_CREDENTIAL_MASTER_KEY="$credential_master_key" \
  JANUSLY_WEB_BASE_URL="$origin" \
  JANUSLY_BROWSER_CONNECT_ORIGINS="$supabase_public_url" \
  API_ALLOWED_ORIGINS="http://127.0.0.1:${app_port},http://localhost:${app_port}" \
  ALLOW_DEV_AUTH_HEADERS=false \
  SUPABASE_URL="$supabase_internal_url" \
  SUPABASE_SERVICE_ROLE_KEY="${SUPABASE_SERVICE_ROLE_KEY:-}" \
  VITE_SUPABASE_URL="$supabase_public_url" \
  VITE_SUPABASE_ANON_KEY="${VITE_SUPABASE_ANON_KEY:-}" \
  ANTHROPIC_API_KEY='' \
    docker compose -f "$root/docker-compose.yml" -p "$project" "$@"
}

redact() {
  sed -E \
    -e 's/(eyJ[A-Za-z0-9._-]{20,})/[REDACTED_JWT]/g' \
    -e 's/(sb_(publishable|secret)_[A-Za-z0-9_-]+)/[REDACTED_SUPABASE_KEY]/g' \
    -e 's/(sk-ant-[A-Za-z0-9_-]+)/[REDACTED_ANTHROPIC_KEY]/g'
}

capture_diagnostics() {
  mkdir -p "$evidence_root/logs"
  chmod 700 "$evidence_root" "$evidence_root/logs" || true
  compose ps --format json >"$evidence_root/logs/compose-ps.json" 2>/dev/null || true
  compose logs --no-color --timestamps janusly postgres 2>&1 | redact >"$evidence_root/logs/compose.log" || true
}

write_summary() {
  local finished_at checksum_tmp
  finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  mkdir -p "$evidence_root"
  jq -n \
    --arg status "$status" \
    --arg profile "$profile" \
    --arg commit "$(git -C "$root" rev-parse HEAD)" \
    --arg tree "$(git -C "$root" rev-parse 'HEAD^{tree}')" \
    --arg finishedAt "$finished_at" \
    --arg appOrigin "$origin" \
    --arg supabaseVersion "$(HOME="$supabase_home" SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 "$supabase_bin" --version 2>/dev/null || printf unknown)" \
    '{status:$status,profile:$profile,git:{commit:$commit,tree:$tree},finishedAt:$finishedAt,appOrigin:$appOrigin,supabaseVersion:$supabaseVersion,providerCalls:0,providerCostUsd:0}' \
    >"$evidence_root/summary.json"
  checksum_tmp=$(mktemp "${TMPDIR:-/tmp}/janusly-qualification-sums.XXXXXX")
  if ! (
    cd "$evidence_root"
    find . -type f ! -name SHA256SUMS -print0 |
      sort -z |
      xargs -0 shasum -a 256
  ) >"$checksum_tmp"; then
    rm -f "$checksum_tmp"
    return 1
  fi
  mv "$checksum_tmp" "$evidence_root/SHA256SUMS"
}

cleanup() {
  local exit_status=$?
  trap - EXIT INT TERM
  if ((started)); then
    capture_diagnostics
  fi
  if [[ ${JANUSLY_QUALIFICATION_KEEP_STACK:-0} != 1 ]]; then
    compose down --volumes --remove-orphans >/dev/null 2>&1 || true
    supabase stop --project-id "$auth_project" --no-backup >/dev/null 2>&1 || true
  fi
  if ((exit_status == 0)); then status=passed; fi
  write_summary || true
  exit "$exit_status"
}

reset_stacks() {
  [[ ${CONFIRM:-} == reset ]] || die "destructive profiles require CONFIRM=reset"
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  supabase stop --project-id "$auth_project" --no-backup >/dev/null 2>&1 || true
}

start_supabase() {
  supabase start --exclude realtime,storage-api,imgproxy,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor >/dev/null
  local auth_status
  auth_status=$(supabase status -o json)
  VITE_SUPABASE_ANON_KEY=$(jq -er '.ANON_KEY // .PUBLISHABLE_KEY // .anon_key // .publishable_key' <<<"$auth_status")
  SUPABASE_SERVICE_ROLE_KEY=$(jq -er '.SERVICE_ROLE_KEY // .SECRET_KEY // .service_role_key // .secret_key' <<<"$auth_status")
  export VITE_SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY
}

wait_for_app() {
  local _
  for _ in $(seq 1 120); do
    if curl --fail --silent "$origin/healthz" >/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}

start_app() {
  compose up -d --wait postgres
  compose build janusly
  compose run --rm janusly migrate
  compose up -d janusly
  wait_for_app
}

run_spec() {
  local spec=$1
  shift
  mkdir -p "$evidence_root/screenshots"
  (
    cd "$root/web"
    env \
      PLAYWRIGHT_SKIP_WEB_SERVER=1 \
      JANUSLY_E2E_RUNTIME_BASE_URL="$origin" \
      E2E_API_URL="$origin" \
      JANUSLY_EVIDENCE_DIR="$evidence_root/screenshots" \
      "$@" \
      ./node_modules/.bin/playwright test "$spec" --project=chromium --workers=1
  )
}

run_profile() {
  case "$1" in
    clean)
      run_spec e2e/local-clean-install.spec.ts JANUSLY_LOCAL_CLEAN_INSTALL_E2E=1
      ;;
    identity)
      run_spec e2e/local-identity-stack.spec.ts JANUSLY_LOCAL_IDENTITY_E2E=1
      compose stop janusly
      supabase stop --project-id "$auth_project" >/dev/null
      start_supabase
      compose up -d janusly
      wait_for_app
      run_spec e2e/local-identity-stack.spec.ts \
        JANUSLY_LOCAL_IDENTITY_E2E=1 \
        JANUSLY_LOCAL_IDENTITY_PERSISTENCE_ONLY=1
      ;;
    security)
      run_spec e2e/local-security.spec.ts JANUSLY_LOCAL_SECURITY_E2E=1 JANUSLY_SECURITY_API_URL="$origin"
      ;;
    tenant)
      run_spec e2e/local-tenant-isolation.spec.ts JANUSLY_LOCAL_TENANT_ISOLATION_E2E=1 JANUSLY_TENANT_API_URL="$origin"
      ;;
    recovery)
      run_spec e2e/local-backup-restore.spec.ts \
        JANUSLY_LOCAL_BACKUP_RESTORE_E2E=1 \
        JANUSLY_BACKUP_RESTORE_PHASE=seed \
        JANUSLY_BACKUP_RESTORE_API_URL="$origin"
      local backup_dir="$evidence_root/database-backup"
      COMPOSE_PROJECT_NAME="$project" \
      JANUSLY_RECOVERY_COMPOSE_FILE="$root/docker-compose.yml" \
      JANUSLY_CREDENTIAL_MASTER_KEY="$credential_master_key" \
        "$root/scripts/postgres-local-recovery.sh" backup "$backup_dir" \
        >"$evidence_root/backup-result.json"
      compose down --volumes --remove-orphans
      compose up -d --wait postgres
      if COMPOSE_PROJECT_NAME="$project" \
        JANUSLY_RECOVERY_COMPOSE_FILE="$root/docker-compose.yml" \
        JANUSLY_CREDENTIAL_MASTER_KEY=qualification-wrong-key \
        CONFIRM=restore \
          "$root/scripts/postgres-local-recovery.sh" restore "$backup_dir" \
          >"$evidence_root/wrong-key-refusal.log" 2>&1; then
        die "restore accepted a mismatched credential key"
      fi
      grep -F "credential master key does not match the backup" \
        "$evidence_root/wrong-key-refusal.log" >/dev/null ||
        die "restore failed for an unexpected reason with the wrong key"
      local tampered_dir="$evidence_root/tampered-backup"
      cp -R "$backup_dir" "$tampered_dir"
      printf 'tampered\n' >>"$tampered_dir/database.dump"
      if COMPOSE_PROJECT_NAME="$project" \
        JANUSLY_RECOVERY_COMPOSE_FILE="$root/docker-compose.yml" \
        JANUSLY_CREDENTIAL_MASTER_KEY="$credential_master_key" \
        CONFIRM=restore \
          "$root/scripts/postgres-local-recovery.sh" restore "$tampered_dir" \
          >"$evidence_root/checksum-refusal.log" 2>&1; then
        die "restore accepted a tampered dump"
      fi
      grep -F "backup dump checksum mismatch" \
        "$evidence_root/checksum-refusal.log" >/dev/null ||
        die "restore failed for an unexpected reason with the tampered dump"
      COMPOSE_PROJECT_NAME="$project" \
      JANUSLY_RECOVERY_COMPOSE_FILE="$root/docker-compose.yml" \
      JANUSLY_CREDENTIAL_MASTER_KEY="$credential_master_key" \
      CONFIRM=restore \
        "$root/scripts/postgres-local-recovery.sh" restore "$backup_dir" \
        >"$evidence_root/restore-result.json"
      if COMPOSE_PROJECT_NAME="$project" \
        JANUSLY_RECOVERY_COMPOSE_FILE="$root/docker-compose.yml" \
        JANUSLY_CREDENTIAL_MASTER_KEY="$credential_master_key" \
        CONFIRM=restore \
          "$root/scripts/postgres-local-recovery.sh" restore "$backup_dir" \
          >"$evidence_root/nonempty-refusal.log" 2>&1; then
        die "restore accepted a non-empty target"
      fi
      grep -F "restore target is not empty" \
        "$evidence_root/nonempty-refusal.log" >/dev/null ||
        die "restore failed for an unexpected reason on a non-empty target"
      compose run --rm janusly migrate
      compose up -d janusly
      wait_for_app
      run_spec e2e/local-backup-restore.spec.ts \
        JANUSLY_LOCAL_BACKUP_RESTORE_E2E=1 \
        JANUSLY_BACKUP_RESTORE_PHASE=restored \
        JANUSLY_BACKUP_RESTORE_API_URL="$origin"
      ;;
  esac
}

validate_configuration
if [[ "$profile" == selftest ]]; then
  printf '{"project":"%s","authProject":"%s","origin":"%s"}\n' "$project" "$auth_project" "$origin"
  exit 0
fi

mkdir -p "$evidence_root"
chmod 700 "$evidence_root"
trap cleanup EXIT INT TERM
reset_stacks
start_supabase
started=1
start_app

if [[ "$profile" == all ]]; then
  for selected in clean identity security tenant recovery; do run_profile "$selected"; done
else
  run_profile "$profile"
fi
