#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/janusly-db-port-test.XXXXXX")
trap 'rm -rf -- "$tmp"' EXIT

# Exercise Make's exported Compose environment without starting Docker or
# touching a database. Commands that consume DB_URL are checked in dry-run mode.
cat >"$tmp/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == 'compose -p janusly-port-selftest up -d --wait postgres' ]]
printf '%s\n' "${JANUSLY_POSTGRES_HOST_PORT:?}"
EOF
chmod +x "$tmp/docker"

run_make() {
  env -u JANUSLY_POSTGRES_HOST_PORT -u DB_URL -u MAKEFLAGS -u MFLAGS \
    PATH="$tmp:$PATH" make --no-print-directory -s -C "$root" \
    COMPOSE_PROJECT_NAME=janusly-port-selftest "$@"
}

[[ $(run_make db-up) == 15473 ]]
[[ $(run_make db-up JANUSLY_POSTGRES_HOST_PORT=15474) == 15474 ]]
exported=$(env -u DB_URL -u MAKEFLAGS -u MFLAGS \
  JANUSLY_POSTGRES_HOST_PORT=15475 PATH="$tmp:$PATH" \
  make --no-print-directory -s -C "$root" COMPOSE_PROJECT_NAME=janusly-port-selftest db-up)
[[ "$exported" == 15475 ]]

for target in migrate test-integration dev; do
  default=$(run_make -n "$target")
  overridden=$(run_make -n "$target" JANUSLY_POSTGRES_HOST_PORT=15474)
  grep -F '127.0.0.1:15473/janusly?sslmode=disable' <<<"$default" >/dev/null
  grep -F '127.0.0.1:15474/janusly?sslmode=disable' <<<"$overridden" >/dev/null
done
explicit=$(run_make -n migrate DB_URL=postgres://custom:example@localhost:16473/custom)
grep -F 'postgres://custom:example@localhost:16473/custom' <<<"$explicit" >/dev/null

grep -F '"127.0.0.1:${JANUSLY_POSTGRES_HOST_PORT:-15473}:5432"' "$root/docker-compose.yml" >/dev/null
grep -F '@postgres:5432/janusly' "$root/docker-compose.yml" >/dev/null
grep -F 'JANUSLY_DATABASE_URL=postgres://janusly:janusly-local@127.0.0.1:15473/janusly?sslmode=disable' "$root/.env.example" >/dev/null
printf 'local database port contract passed (default, overrides, private container endpoint)\n'
