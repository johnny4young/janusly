#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
docker_bin=${JANUSLY_E2E_DOCKER_BIN:-docker}
tmp=$(mktemp -d "${TMPDIR:-/tmp}/janusly-docker-context.XXXXXX")
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/context/.dev" "$tmp/context/.playwright-cli" \
  "$tmp/context/.playwright-mcp" "$tmp/context/web/feature/__screenshots__"
cp "$root/.dockerignore" "$tmp/context/.dockerignore"
printf 'FROM scratch\nCOPY . /snapshot\n' > "$tmp/context/Dockerfile"
printf 'public sentinel\n' > "$tmp/context/public.txt"
printf 'example env\n' > "$tmp/context/.env.example"
printf 'fake secret\n' > "$tmp/context/.env"
printf 'fake credential\n' > "$tmp/context/.dev/credential-master-key"
printf 'fake browser state\n' > "$tmp/context/.playwright-cli/state.json"
printf 'fake browser state\n' > "$tmp/context/.playwright-mcp/state.json"
printf 'fake screenshot\n' > "$tmp/context/web/feature/__screenshots__/private.png"

"$docker_bin" buildx build --quiet --output "type=local,dest=$tmp/out" "$tmp/context" >/dev/null
[[ -f "$tmp/out/snapshot/public.txt" ]] || { echo 'docker-context: public source missing' >&2; exit 1; }
[[ -f "$tmp/out/snapshot/.env.example" ]] || { echo 'docker-context: public env example missing' >&2; exit 1; }
for excluded in .env .dev/credential-master-key .playwright-cli/state.json \
  .playwright-mcp/state.json web/feature/__screenshots__/private.png; do
  if [[ -e "$tmp/out/snapshot/$excluded" ]]; then
    printf 'docker-context: excluded path entered build context: %s\n' "$excluded" >&2
    exit 1
  fi
done
printf 'docker-context: local secret and browser state excluded\n'
