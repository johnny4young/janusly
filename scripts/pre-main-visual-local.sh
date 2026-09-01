#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
baseline_ref=${JANUSLY_VISUAL_BASELINE_REF:-a18a0478d547a956885b4187b1ead303ea021524}
profile=${1:-all}
stamp=$(date -u +%Y%m%dT%H%M%SZ)
evidence_root=${JANUSLY_EVIDENCE_DIR:-$root/output/qualification/pre-main-visual/$stamp}
current_project=janusly-visual-after
baseline_project=janusly-visual-before
current_app_port=${JANUSLY_VISUAL_AFTER_PORT:-37332}
baseline_app_port=${JANUSLY_VISUAL_BEFORE_PORT:-37331}
current_postgres_port=${JANUSLY_VISUAL_AFTER_POSTGRES_PORT:-35434}
baseline_postgres_port=${JANUSLY_VISUAL_BEFORE_POSTGRES_PORT:-35433}
current_metrics_port=${JANUSLY_VISUAL_AFTER_METRICS_PORT:-39464}
baseline_metrics_port=${JANUSLY_VISUAL_BEFORE_METRICS_PORT:-39463}
credential_master_key=visual0000000000000000000000000000000000000000000000000000000000
baseline_source=
active_source=
active_project=
active_app_port=
active_postgres_port=
active_metrics_port=
active_commit=
active_tree=
active_image=

usage() {
  cat <<'EOF'
usage: scripts/pre-main-visual-local.sh [all|before|after]

Captures a provider-free, isolated EN/ES x light/dark x desktop/tablet/mobile
matrix. "before" reconstructs JANUSLY_VISUAL_BASELINE_REF through git archive;
"after" uses the clean current HEAD. Every Compose project is isolated and is
removed with its own volumes after capture. Requires CONFIRM=reset.
EOF
}

die() {
  printf 'pre-main visual: %s\n' "$*" >&2
  exit 2
}

compose() {
  COMPOSE_PROJECT_NAME="$active_project" \
  IMAGE="$active_image" \
  JANUSLY_HOST_PORT="$active_app_port" \
  JANUSLY_POSTGRES_HOST_PORT="$active_postgres_port" \
  JANUSLY_INTERNAL_HOST_PORT="$active_metrics_port" \
  JANUSLY_BUILD_COMMIT="$active_commit" \
  JANUSLY_BUILD_TREE="$active_tree" \
  JANUSLY_BUILD_ID="${active_commit:0:8}" \
  JANUSLY_CREDENTIAL_MASTER_KEY="$credential_master_key" \
  ALLOW_PRIVATE_HTTP_TARGETS=true \
  ANTHROPIC_API_KEY= \
    docker compose -f "$active_source/docker-compose.yml" -p "$active_project" "$@"
}

stop_active_stack() {
  if [[ -n "$active_source" && -n "$active_project" ]]; then
    compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
}

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  stop_active_stack
  if [[ -n "$baseline_source" ]]; then
    rm -rf "$baseline_source"
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

validate() {
  case "$profile" in
    all|before|after) ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; die "unknown profile: $profile" ;;
  esac
  [[ ${CONFIRM:-} == reset ]] || die 'isolated volume cleanup requires CONFIRM=reset'
  git -C "$root" cat-file -e "${baseline_ref}^{commit}" 2>/dev/null ||
    die "baseline ref does not resolve: $baseline_ref"
  if [[ -n $(git -C "$root" status --porcelain --untracked-files=all) ]]; then
    die 'current source must be clean so after evidence has exact provenance'
  fi
  for port in \
    "$current_app_port" "$baseline_app_port" \
    "$current_postgres_port" "$baseline_postgres_port" \
    "$current_metrics_port" "$baseline_metrics_port"; do
    [[ "$port" =~ ^[0-9]+$ ]] && ((port >= 1024 && port <= 65535)) ||
      die "invalid port: $port"
  done
}

wait_for_app() {
  local origin=$1
  local _
  for _ in $(seq 1 120); do
    if curl --fail --silent "$origin/healthz" >/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}

prepare_baseline() {
  baseline_source=$(mktemp -d "${TMPDIR:-/tmp}/janusly-visual-before.XXXXXX")
  git -C "$root" archive --format=tar "$baseline_ref" | tar -xf - -C "$baseline_source"
}

select_phase() {
  local phase=$1
  stop_active_stack
  if [[ "$phase" == before ]]; then
    [[ -n "$baseline_source" ]] || prepare_baseline
    active_source=$baseline_source
    active_project=$baseline_project
    active_app_port=$baseline_app_port
    active_postgres_port=$baseline_postgres_port
    active_metrics_port=$baseline_metrics_port
    active_commit=$(git -C "$root" rev-parse "${baseline_ref}^{commit}")
    active_tree=$(git -C "$root" rev-parse "${baseline_ref}^{tree}")
  else
    active_source=$root
    active_project=$current_project
    active_app_port=$current_app_port
    active_postgres_port=$current_postgres_port
    active_metrics_port=$current_metrics_port
    active_commit=$(git -C "$root" rev-parse HEAD)
    active_tree=$(git -C "$root" rev-parse 'HEAD^{tree}')
  fi
  active_image="janusly:visual-${phase}-${active_commit:0:8}"
}

start_active_stack() {
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  compose up -d --wait postgres
  compose build janusly
  compose run --rm janusly migrate
  compose up -d janusly
  if ! wait_for_app "http://127.0.0.1:${active_app_port}"; then
    printf 'pre-main visual: %s runtime did not become healthy\n' "$active_project" >&2
    compose ps >&2 || true
    compose logs --no-color --tail=200 janusly postgres >&2 || true
    return 1
  fi
}

run_visual_phase() {
  local phase=$1
  local phase_dir="$evidence_root/$phase"
  local origin="http://127.0.0.1:${active_app_port}"
  mkdir -p "$phase_dir"
  chmod 700 "$evidence_root" "$phase_dir" || true
  (
    cd "$root/web"
    env \
      PLAYWRIGHT_SKIP_WEB_SERVER=1 \
      JANUSLY_PRE_MAIN_VISUAL_E2E=1 \
      JANUSLY_VISUAL_PHASE="$phase" \
      JANUSLY_E2E_RUNTIME_BASE_URL="$origin" \
      E2E_API_URL="$origin" \
      JANUSLY_EVIDENCE_DIR="$phase_dir" \
      ./node_modules/.bin/playwright test \
        e2e/pre-main-visual-matrix.spec.ts \
        --project=chromium --workers=1
  )
  if [[ "$phase" == after ]]; then
    (
      cd "$root/web"
      env \
        PLAYWRIGHT_SKIP_WEB_SERVER=1 \
        JANUSLY_SEMANTIC_OUTCOME_E2E=1 \
        JANUSLY_E2E_RUNTIME_BASE_URL="$origin" \
        E2E_API_URL="$origin" \
        JANUSLY_EVIDENCE_DIR="$phase_dir/governed-recovery" \
        ./node_modules/.bin/playwright test \
          e2e/semantic-outcome-recovery.spec.ts \
          --project=chromium --workers=1
    )
  fi
}

capture_phase() {
  local phase=$1
  printf 'pre-main visual: capturing %s\n' "$phase"
  select_phase "$phase"
  start_active_stack
  run_visual_phase "$phase"
  stop_active_stack
  active_source=
  active_project=
}

write_summary() {
  local current_commit current_tree baseline_commit baseline_tree
  current_commit=$(git -C "$root" rev-parse HEAD)
  current_tree=$(git -C "$root" rev-parse 'HEAD^{tree}')
  baseline_commit=$(git -C "$root" rev-parse "${baseline_ref}^{commit}")
  baseline_tree=$(git -C "$root" rev-parse "${baseline_ref}^{tree}")
  jq -n \
    --arg status passed \
    --arg profile "$profile" \
    --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg baselineCommit "$baseline_commit" \
    --arg baselineTree "$baseline_tree" \
    --arg currentCommit "$current_commit" \
    --arg currentTree "$current_tree" \
    --argjson beforeScreenshots "$(find "$evidence_root/before" -type f -name '*.png' 2>/dev/null | wc -l | tr -d ' ')" \
    --argjson afterScreenshots "$(find "$evidence_root/after" -type f -name '*.png' 2>/dev/null | wc -l | tr -d ' ')" \
    '{status:$status,profile:$profile,generatedAt:$generatedAt,providerCalls:0,providerCostUsd:0,baseline:{commit:$baselineCommit,tree:$baselineTree,screenshots:$beforeScreenshots},after:{commit:$currentCommit,tree:$currentTree,screenshots:$afterScreenshots}}' \
    >"$evidence_root/summary.json"
  (
    cd "$evidence_root"
    find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 shasum -a 256
  ) >"$evidence_root/SHA256SUMS"
}

validate
mkdir -p "$evidence_root"
case "$profile" in
  all)
    capture_phase before
    capture_phase after
    ;;
  before|after)
    capture_phase "$profile"
    ;;
esac
write_summary
printf 'pre-main visual: evidence written to %s\n' "$evidence_root"
