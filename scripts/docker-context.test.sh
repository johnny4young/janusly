#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
docker_bin=${JANUSLY_E2E_DOCKER_BIN:-docker}
tmp=$(mktemp -d "${TMPDIR:-/tmp}/janusly-docker-context.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/context/.dev" "$tmp/context/.playwright-cli" \
  "$tmp/context/.playwright-mcp" "$tmp/context/web/feature/__screenshots__" \
  "$tmp/context/website" "$tmp/context/docs" \
  "$tmp/context/web/types" "$tmp/context/cmd/api" \
  "$tmp/context/contract"
cp "$root/.dockerignore" "$tmp/context/.dockerignore"
printf 'FROM scratch\nCOPY . /snapshot\n' > "$tmp/context/Dockerfile"
printf 'public sentinel\n' > "$tmp/context/public.txt"
printf 'source sentinel\n' > "$tmp/context/cmd/api/main.go"
printf 'contract sentinel\n' > "$tmp/context/contract/openapi.json"
printf 'example env\n' > "$tmp/context/.env.example"
printf 'fake secret\n' > "$tmp/context/.env"
printf 'fake nested secret\n' > "$tmp/context/web/.env"
printf 'fake nested secret\n' > "$tmp/context/website/.env.local"
printf 'fake nested secret\n' > "$tmp/context/web/feature/.env.production"
printf 'nested public example\n' > "$tmp/context/web/.env.example"
printf 'nested public example\n' > "$tmp/context/website/.env.example"
printf 'fake local plan\n' > "$tmp/context/docs/PLAN.md"
printf 'fake local roadmap\n' > "$tmp/context/docs/ROADMAP.md"
printf 'fake generated type\n' > "$tmp/context/web/index.d.ts"
printf 'fake generated type\n' > "$tmp/context/web/types/generated.d.ts"
for binary in admin api artifact loadgen mcp seed; do
  printf 'fake generated binary\n' > "$tmp/context/$binary"
done
printf 'fake credential\n' > "$tmp/context/.dev/credential-master-key"
printf 'fake browser state\n' > "$tmp/context/.playwright-cli/state.json"
printf 'fake browser state\n' > "$tmp/context/.playwright-mcp/state.json"
printf 'fake screenshot\n' > "$tmp/context/web/feature/__screenshots__/private.png"

"$docker_bin" buildx build --quiet --output "type=local,dest=$tmp/out" "$tmp/context" >/dev/null
[[ -f "$tmp/out/snapshot/public.txt" ]] || { echo 'docker-context: public source missing' >&2; exit 1; }
[[ -f "$tmp/out/snapshot/.env.example" ]] || { echo 'docker-context: public env example missing' >&2; exit 1; }
[[ -f "$tmp/out/snapshot/web/.env.example" ]] || { echo 'docker-context: nested public env example missing' >&2; exit 1; }
[[ -f "$tmp/out/snapshot/website/.env.example" ]] || { echo 'docker-context: website public env example missing' >&2; exit 1; }
[[ -f "$tmp/out/snapshot/cmd/api/main.go" ]] || { echo 'docker-context: source file missing' >&2; exit 1; }
[[ -f "$tmp/out/snapshot/contract/openapi.json" ]] || { echo 'docker-context: contract source missing' >&2; exit 1; }
for excluded in .env web/.env website/.env.local web/feature/.env.production \
  docs/PLAN.md docs/ROADMAP.md web/index.d.ts web/types/generated.d.ts \
  admin api artifact loadgen mcp seed \
  .dev/credential-master-key .playwright-cli/state.json \
  .playwright-mcp/state.json web/feature/__screenshots__/private.png; do
  if [[ -e "$tmp/out/snapshot/$excluded" ]]; then
    printf 'docker-context: excluded path entered build context: %s\n' "$excluded" >&2
    exit 1
  fi
done
printf 'docker-context: local-only files excluded\n'
