#!/usr/bin/env bash
set -Eeuo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
project=${JANUSLY_OCI_PROJECT:-janusly-qualification-oci-${UID}}
image=${IMAGE:-janusly:qualification}
app_port=${JANUSLY_OCI_APP_PORT:-7320}
postgres_port=${JANUSLY_OCI_POSTGRES_PORT:-7448}
metrics_port=${JANUSLY_OCI_METRICS_PORT:-7474}
origin=${JANUSLY_OCI_ORIGIN:-http://127.0.0.1:${app_port}}
stamp=$(date -u +%Y%m%dT%H%M%SZ)
evidence_dir=${JANUSLY_OCI_EVIDENCE_DIR:-$root/output/qualification/$stamp/oci_railway}
status=failed
started=0

umask 077

die() {
  printf 'oci-railway-local: %s\n' "$*" >&2
  exit 2
}

redact() {
  sed -E \
    -e 's/(eyJ[A-Za-z0-9._-]{20,})/[REDACTED_JWT]/g' \
    -e 's/(sb_(publishable|secret)_[A-Za-z0-9_-]+)/[REDACTED_SUPABASE_KEY]/g' \
    -e 's/(sk-ant-[A-Za-z0-9_-]+)/[REDACTED_ANTHROPIC_KEY]/g' \
    -e 's#(postgres(ql)?://[^:/[:space:]]+:)[^@[:space:]]+#\1[REDACTED]#g'
}

compose() {
  COMPOSE_PROJECT_NAME="$project" \
  IMAGE="$image" \
  JANUSLY_HOST_PORT="$app_port" \
  JANUSLY_POSTGRES_HOST_PORT="$postgres_port" \
  JANUSLY_INTERNAL_HOST_PORT="$metrics_port" \
  JANUSLY_ENV=production \
  PORT=3001 \
  JANUSLY_PORT=3001 \
  JANUSLY_RESUME_TOKEN_SECRET=qualification-resume-token-secret-not-for-production \
  JANUSLY_CREDENTIAL_MASTER_KEY=0a6ee99978435f3e242e19aa61839045c6c1a5f1f5e63558f9d40706702570c7 \
  JANUSLY_WEB_BASE_URL="$origin" \
  API_ALLOWED_ORIGINS="http://127.0.0.1:${app_port},http://localhost:${app_port}" \
  ALLOW_DEV_AUTH_HEADERS=true \
  SUPABASE_URL='' \
  SUPABASE_SERVICE_ROLE_KEY='' \
  VITE_SUPABASE_URL='' \
  VITE_SUPABASE_ANON_KEY='' \
  ANTHROPIC_API_KEY='' \
  OTEL_EXPORTER=none \
    docker compose -f "$root/docker-compose.yml" -p "$project" "$@"
}

validate_configuration() {
  [[ "$project" =~ ^janusly-qualification-oci-[a-zA-Z0-9-]+$ ]] ||
    die 'JANUSLY_OCI_PROJECT must start with janusly-qualification-oci-'
  [[ "$project" != janusly ]] || die 'refusing the ordinary Compose project'
  [[ "$image" =~ ^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9][A-Za-z0-9._-]*$ ]] ||
    die 'IMAGE must be an explicit local repository:tag reference'
  [[ "$origin" == "http://127.0.0.1:${app_port}" || "$origin" == "http://localhost:${app_port}" ]] ||
    die 'qualification origin must be the configured loopback port'
  for port in "$app_port" "$postgres_port" "$metrics_port"; do
    if [[ ! "$port" =~ ^[0-9]+$ ]] || ((port < 1024 || port > 65535)); then
      die 'qualification ports must be integers in 1024..65535'
    fi
  done
  [[ "$app_port" != "$postgres_port" && "$app_port" != "$metrics_port" && "$postgres_port" != "$metrics_port" ]] ||
    die 'qualification ports must be distinct'
}

wait_for_ready() {
  local _
  for _ in $(seq 1 120); do
    if curl --fail --silent --max-time 3 "$origin/readyz" >/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}

wait_for_not_ready() {
  local _
  for _ in $(seq 1 30); do
    if ready_status=$(curl --silent --show-error --max-time 3 \
      --output "$evidence_dir/readyz-database-down.json" --write-out '%{http_code}' \
      "$origin/readyz"); then
      if [[ "$ready_status" == 503 ]]; then return 0; fi
    else
      ready_status=000
    fi
    sleep 1
  done
  return 1
}

capture_diagnostics() {
  mkdir -p "$evidence_dir/logs"
  chmod 700 "$evidence_dir" "$evidence_dir/logs"
  compose ps --format json >"$evidence_dir/logs/compose-ps.json" 2>/dev/null || true
  compose logs --no-color --timestamps janusly postgres 2>&1 | redact \
    >"$evidence_dir/logs/compose.log" || true
}

finish() {
  local exit_status=$? checksum_tmp finished_at
  trap - EXIT INT TERM
  if ((started)); then capture_diagnostics; fi
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  if ((exit_status == 0)); then status=passed; fi
  mkdir -p "$evidence_dir"
  chmod 700 "$evidence_dir"
  finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  jq -n \
    --arg status "$status" \
    --arg commit "$(git -C "$root" rev-parse HEAD 2>/dev/null || printf unknown)" \
    --arg tree "$(git -C "$root" rev-parse 'HEAD^{tree}' 2>/dev/null || printf unknown)" \
    --arg image "$image" \
    --arg origin "$origin" \
    --arg finishedAt "$finished_at" \
    '{status:$status,profile:"oci_railway",git:{commit:$commit,tree:$tree},image:$image,appOrigin:$origin,finishedAt:$finishedAt,providerCalls:0,providerCostUsd:0,remoteDeployment:false}' \
    >"$evidence_dir/summary.json"
  checksum_tmp=$(mktemp "${TMPDIR:-/tmp}/janusly-oci-sums.XXXXXX")
  (
    cd "$evidence_dir"
    find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 shasum -a 256
  ) >"$checksum_tmp"
  mv "$checksum_tmp" "$evidence_dir/SHA256SUMS"
  exit "$exit_status"
}

validate_configuration
if [[ ${JANUSLY_OCI_SELFTEST:-0} == 1 ]]; then
  jq -n --arg project "$project" --arg image "$image" --arg origin "$origin" \
    '{project:$project,image:$image,origin:$origin,providerCalls:0,remoteDeployment:false}'
  exit 0
fi
[[ ${CONFIRM:-} == reset ]] || die 'isolated qualification requires CONFIRM=reset'
for command in curl docker git jq make shasum; do
  command -v "$command" >/dev/null 2>&1 || die "required command is missing: $command"
done
bash "$root/scripts/assert-clean-source.sh"
[[ ! -e "$evidence_dir" && ! -L "$evidence_dir" ]] ||
  die "evidence directory already exists: $evidence_dir"
mkdir -p "$evidence_dir/screenshots"
chmod 700 "$evidence_dir" "$evidence_dir/screenshots"
trap finish EXIT INT TERM

compose down --volumes --remove-orphans >/dev/null 2>&1 || true
make -C "$root" build IMAGE="$image"

commit=$(git -C "$root" rev-parse HEAD)
tree=$(git -C "$root" rev-parse 'HEAD^{tree}')
docker image inspect "$image" >"$evidence_dir/image-inspect.json"
if docker history --no-trunc "$image" |
  grep -Eq 'sk-ant-[A-Za-z0-9_-]+|ANTHROPIC_API_KEY=.{8,}'; then
  die 'image history contains provider credential material'
fi
docker history --no-trunc --format '{{json .}}' "$image" | redact \
  >"$evidence_dir/image-history.jsonl"
docker run --rm "$image" provenance >"$evidence_dir/provenance.json"

jq -e --arg commit "$commit" --arg tree "$tree" \
  '.commit == $commit and .tree == $tree and .verified == true and (.artifactSha256 | test("^[0-9a-f]{64}$"))' \
  "$evidence_dir/provenance.json" >/dev/null
jq -e --arg commit "$commit" --arg tree "$tree" '
  .[0].Config.User == "nonroot:nonroot" and
  .[0].Config.Entrypoint == ["/janusly"] and
  .[0].Config.Labels["org.opencontainers.image.title"] == "Janusly" and
  .[0].Config.Labels["org.opencontainers.image.revision"] == $commit and
  .[0].Config.Labels["io.janusly.source-tree"] == $tree and
  .[0].Size > 0 and .[0].Size <= 134217728
' "$evidence_dir/image-inspect.json" >/dev/null

compose up -d --wait postgres
started=1
compose run --rm --no-deps janusly migrate
compose up -d --no-build janusly
wait_for_ready || die 'production OCI did not become ready'

curl --fail --silent --show-error "$origin/healthz" >"$evidence_dir/healthz.json"
curl --fail --silent --show-error "$origin/readyz" >"$evidence_dir/readyz.json"
curl --fail --silent --show-error "$origin/health" >"$evidence_dir/health.json"
curl --fail --silent --show-error "$origin/" >"$evidence_dir/index.html"
grep -F '<div id="root"></div>' "$evidence_dir/index.html" >/dev/null ||
  die 'production OCI did not serve the React shell'

# Prove the operational contract: liveness reports the process while
# readiness removes it from traffic until PostgreSQL recovers.
compose stop postgres >/dev/null
curl --fail --silent --show-error "$origin/healthz" >"$evidence_dir/healthz-database-down.json"
wait_for_not_ready || die "readiness returned $ready_status while PostgreSQL was down"
jq -e '.ok == false and length == 1' "$evidence_dir/readyz-database-down.json" >/dev/null ||
  die 'readiness failure leaked details or returned the wrong envelope'
compose up -d --wait postgres >/dev/null
wait_for_ready || die 'production OCI readiness did not recover after PostgreSQL restart'
curl --fail --silent --show-error "$origin/readyz" >"$evidence_dir/readyz-recovered.json"

curl --fail --silent --show-error \
  -H 'Content-Type: application/json' \
  -H 'x-org-id: oci-no-key' \
  -H 'x-user-id: oci-operator' \
  -H 'x-janusly-csrf: 1' \
  --data '{"prompt":"Create a flow with human approval before writing"}' \
  "$origin/ai/generate-workflow" >"$evidence_dir/no-key-fallback.json"
jq -e '.mode == "fallback" and (has("aiError") | not) and any(.nodes[]?; .type == "approval")' \
  "$evidence_dir/no-key-fallback.json" >/dev/null

(
  cd "$root/web"
  env \
    PLAYWRIGHT_SKIP_WEB_SERVER=1 \
    JANUSLY_E2E_RUNTIME_BASE_URL="$origin" \
    E2E_API_URL="$origin" \
    JANUSLY_EVIDENCE_DIR="$evidence_dir/screenshots" \
    JANUSLY_LOCAL_OCI_E2E=1 \
    ./node_modules/.bin/playwright test e2e/local-oci-railway.spec.ts \
      --project=chromium --workers=1
)

printf 'oci-railway-local: passed image=%s evidence=%s\n' "$image" "$evidence_dir"
