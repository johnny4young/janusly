#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
pnpm_command=${PNPM:-pnpm --ignore-workspace}

# The Go binary reads only real environment variables — it never parses
# .env files (and must not: production config is explicit). The DEV
# harness is where developer expectation lives, so it loads the
# repository root .env here, with variables already exported by the
# caller (the Makefile's JANUSLY_DATABASE_URL, a shell override) taking
# precedence over the file.
if [ -f "$root/.env" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    key=${line%%=*}
    value=${line#*=}
    case "$key" in *[!A-Za-z0-9_]*|'') continue ;; esac
    if [ -z "$(eval "printf %s \"\${$key+x}\"")" ]; then
      # Strip one layer of matching quotes, like docker compose does.
      case "$value" in
        \"*\") value=${value#\"}; value=${value%\"} ;;
        \'*\') value=${value#\'}; value=${value%\'} ;;
      esac
      export "$key=$value"
    fi
  done < "$root/.env"
fi

# Managed credentials need a 32-byte root key; without one every
# credential write is refused and the seeded demo cannot hold secrets.
# Development generates one once and reuses it across restarts so
# already-encrypted rows stay decryptable. Production still requires an
# explicit key — this file never applies there.
if [ -z "${JANUSLY_CREDENTIAL_MASTER_KEY:-}" ] && [ -z "${JANUSLY_CREDENTIAL_MASTER_KEY_FILE:-}" ]; then
  dev_key_file="$root/.dev/credential-master-key"
  if [ ! -s "$dev_key_file" ]; then
    mkdir -p "$root/.dev"
    umask_prev=$(umask); umask 177
    openssl rand -hex 32 > "$dev_key_file" 2>/dev/null \
      || od -vAn -N32 -tx1 /dev/urandom | tr -d ' \n' > "$dev_key_file"
    umask "$umask_prev"
    printf 'dev credential master key generated at .dev/credential-master-key\n'
  fi
  export JANUSLY_CREDENTIAL_MASTER_KEY_FILE="$dev_key_file"
fi

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  kill "${api_pid:-}" "${web_pid:-}" 2>/dev/null || true
  wait "${api_pid:-}" "${web_pid:-}" 2>/dev/null || true
  exit "$status"
}
trap cleanup EXIT INT TERM

(cd "$root" && go run ./cmd/api) &
api_pid=$!
(cd "$root/web" && $pnpm_command dev --host 127.0.0.1) &
web_pid=$!

printf 'Janusly API: http://127.0.0.1:3001\n'
printf 'Janusly web: http://127.0.0.1:5173\n'

while :; do
  if ! kill -0 "$api_pid" 2>/dev/null; then
    set +e
    wait "$api_pid"
    status=$?
    set -e
    exit "$status"
  fi
  if ! kill -0 "$web_pid" 2>/dev/null; then
    set +e
    wait "$web_pid"
    status=$?
    set -e
    exit "$status"
  fi
  sleep 1
done
