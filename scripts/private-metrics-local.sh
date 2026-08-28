#!/usr/bin/env bash
set -Eeuo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
project=${JANUSLY_PRIVATE_METRICS_PROJECT:-janusly-qualification-metrics-${UID:-0}-$$}
image=${IMAGE:-janusly:qualification}
postgres_image=${JANUSLY_PRIVATE_METRICS_POSTGRES_IMAGE:-pgvector/pgvector:pg18}
probe_image=${JANUSLY_PRIVATE_METRICS_PROBE_IMAGE:-alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc}
app_port=${JANUSLY_PRIVATE_METRICS_APP_PORT:-7330}
network=${project}-private
volume=${project}-postgres
postgres=${project}-postgres
app=${project}-janusly
origin=http://127.0.0.1:${app_port}
stamp=$(date -u +%Y%m%dT%H%M%SZ)
evidence_dir=${JANUSLY_PRIVATE_METRICS_EVIDENCE_DIR:-$root/output/qualification/$stamp/private_metrics}
status=failed
started=0

umask 077

die() {
  printf 'private-metrics-local: %s\n' "$*" >&2
  exit 2
}

validate_configuration() {
  [[ "$project" =~ ^janusly-qualification-metrics-[a-z0-9][a-z0-9_-]*$ ]] ||
    die 'JANUSLY_PRIVATE_METRICS_PROJECT must start with janusly-qualification-metrics-'
  [[ "$image" =~ ^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9][A-Za-z0-9._-]*$ ]] ||
    die 'IMAGE must be an explicit local repository:tag reference'
  [[ "$app_port" =~ ^[0-9]+$ ]] && ((app_port >= 1024 && app_port <= 65535)) ||
    die 'JANUSLY_PRIVATE_METRICS_APP_PORT must be in 1024..65535'
}

docker_resource_exists() {
  docker container inspect "$postgres" >/dev/null 2>&1 ||
    docker container inspect "$app" >/dev/null 2>&1 ||
    docker network inspect "$network" >/dev/null 2>&1 ||
    docker volume inspect "$volume" >/dev/null 2>&1
}

remove_owned_resources() {
  docker rm -f "$app" "$postgres" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
}

finish() {
  local exit_status=$? finished_at checksum_tmp
  trap - EXIT INT TERM
  if ((started)); then
    docker logs "$app" >"$evidence_dir/janusly.log" 2>&1 || true
    docker logs "$postgres" >"$evidence_dir/postgres.log" 2>&1 || true
  fi
  remove_owned_resources
  if ((exit_status == 0)); then status=passed; fi
  finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  jq -n \
    --arg status "$status" \
    --arg commit "$(git -C "$root" rev-parse HEAD 2>/dev/null || printf unknown)" \
    --arg tree "$(git -C "$root" rev-parse 'HEAD^{tree}' 2>/dev/null || printf unknown)" \
    --arg image "$image" \
    --arg finishedAt "$finished_at" \
    '{status:$status,profile:"private_metrics",git:{commit:$commit,tree:$tree},image:$image,finishedAt:$finishedAt,metricsPrivate:true,metricsPublished:false,providerCalls:0,providerCostUsd:0}' \
    >"$evidence_dir/summary.json"
  checksum_tmp=$(mktemp "${TMPDIR:-/tmp}/janusly-private-metrics-sums.XXXXXX")
  (
    cd "$evidence_dir"
    find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 shasum -a 256
  ) >"$checksum_tmp"
  mv "$checksum_tmp" "$evidence_dir/SHA256SUMS"
  exit "$exit_status"
}

wait_for_postgres() {
  local _
  for _ in $(seq 1 60); do
    if docker exec "$postgres" pg_isready -U janusly -d janusly >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

wait_for_ready() {
  local _
  for _ in $(seq 1 120); do
    if curl --fail --silent --max-time 3 "$origin/readyz" >/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}

validate_configuration
if [[ ${JANUSLY_PRIVATE_METRICS_SELFTEST:-0} == 1 ]]; then
  jq -n --arg project "$project" --arg image "$image" --arg probeImage "$probe_image" \
    '{project:$project,image:$image,probeImage:$probeImage,metricsPrivate:true,metricsPublished:false}'
  exit 0
fi
[[ ${CONFIRM:-} == reset ]] || die 'isolated qualification requires CONFIRM=reset'
for command in curl docker git grep jq shasum; do
  command -v "$command" >/dev/null 2>&1 || die "required command is missing: $command"
done
docker image inspect "$image" >/dev/null 2>&1 || die "local image is missing: $image"
docker_resource_exists && die "refusing pre-existing resources for project $project"
[[ ! -e "$evidence_dir" && ! -L "$evidence_dir" ]] || die "evidence directory already exists: $evidence_dir"
mkdir -p "$evidence_dir"
chmod 700 "$evidence_dir"
trap finish EXIT INT TERM

commit=$(git -C "$root" rev-parse HEAD)
tree=$(git -C "$root" rev-parse 'HEAD^{tree}')
docker run --rm "$image" provenance >"$evidence_dir/provenance.json"
jq -e --arg commit "$commit" --arg tree "$tree" \
  '.commit == $commit and .tree == $tree and .verified == true' \
  "$evidence_dir/provenance.json" >/dev/null || die 'image provenance does not match the current commit and tree'

docker network create --label "io.janusly.qualification=$project" "$network" >/dev/null
docker volume create --label "io.janusly.qualification=$project" "$volume" >/dev/null
docker run -d --name "$postgres" --network "$network" --network-alias postgres \
  --env POSTGRES_USER=janusly \
  --env POSTGRES_PASSWORD=janusly-local \
  --env POSTGRES_DB=janusly \
  --mount "type=volume,src=$volume,dst=/var/lib/postgresql" \
  "$postgres_image" >/dev/null
started=1
wait_for_postgres || die 'PostgreSQL 18 did not become ready'

database_url='postgres://janusly:janusly-local@postgres:5432/janusly?sslmode=disable'
docker run --rm --network "$network" \
  --env JANUSLY_ENV=production \
  --env JANUSLY_DATABASE_URL="$database_url" \
  "$image" migrate >/dev/null

docker run -d --name "$app" --network "$network" --network-alias janusly \
  --publish "127.0.0.1:${app_port}:3001" \
  --env JANUSLY_ENV=production \
  --env JANUSLY_DATABASE_URL="$database_url" \
  --env JANUSLY_PORT=3001 \
  --env JANUSLY_INTERNAL_HOST=0.0.0.0 \
  --env JANUSLY_INTERNAL_PORT=9464 \
  --env JANUSLY_RESUME_TOKEN_SECRET=qualification-resume-token-secret-not-for-production \
  --env JANUSLY_CREDENTIAL_MASTER_KEY=0a6ee99978435f3e242e19aa61839045c6c1a5f1f5e63558f9d40706702570c7 \
  --env JANUSLY_WEB_BASE_URL="$origin" \
  --env API_ALLOWED_ORIGINS="$origin" \
  --env ALLOW_DEV_AUTH_HEADERS=false \
  --env ANTHROPIC_API_KEY= \
  --env OTEL_EXPORTER=none \
  "$image" >/dev/null
wait_for_ready || die 'Janusly did not become ready'

docker inspect "$app" --format '{{json .NetworkSettings.Ports}}' >"$evidence_dir/published-ports.json"
jq -e '.["3001/tcp"] | length == 1' "$evidence_dir/published-ports.json" >/dev/null ||
  die 'public application port was not bound as expected'
jq -e '.["9464/tcp"] == null' "$evidence_dir/published-ports.json" >/dev/null ||
  die 'internal metrics port was published to the host'

docker run --rm --network "$network" "$probe_image" \
  wget -qO- http://janusly:9464/metrics >"$evidence_dir/private-metrics.prom"
for metric in go_goroutines target_info workflow_queue_waiting_jobs; do
  grep -F "$metric" "$evidence_dir/private-metrics.prom" >/dev/null ||
    die "private scrape is missing $metric"
done
docker run --rm --network "$network" "$probe_image" \
  wget -qO- http://janusly:9464/build >"$evidence_dir/private-build.json"
jq -e --arg commit "$commit" --arg tree "$tree" \
  '.commit == $commit and .tree == $tree and .verified == true' \
  "$evidence_dir/private-build.json" >/dev/null || die 'private build identity does not match the image'

curl --silent --show-error "$origin/metrics" >"$evidence_dir/public-metrics-path.txt"
if grep -F 'go_goroutines' "$evidence_dir/public-metrics-path.txt" >/dev/null; then
  die 'public application listener exposed internal metrics'
fi

printf 'private-metrics-local: passed image=%s evidence=%s\n' "$image" "$evidence_dir"
