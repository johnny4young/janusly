#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
script="$root/scripts/postgres-local-recovery.sh"

bash -n "$script"
result=$("$script" selftest)
jq -e '
  .project == "janusly" and
  .postgresMajor == 18 and
  (.schemaSourceSha256 | test("^[0-9a-f]{64}$"))
' <<<"$result" >/dev/null

if CONFIRM=restore "$script" restore "$root/output/does-not-exist" >/dev/null 2>&1; then
  echo "recovery selftest accepted a missing input" >&2
  exit 1
fi
if "$script" restore "$root/output/does-not-exist" >/dev/null 2>&1; then
  echo "recovery selftest accepted restore without confirmation" >&2
  exit 1
fi
if COMPOSE_PROJECT_NAME='unsafe/project' "$script" selftest >/dev/null 2>&1; then
  echo "recovery selftest accepted an unsafe Compose project" >&2
  exit 1
fi
if "$script" unknown >/dev/null 2>&1; then
  echo "recovery selftest accepted an unknown action" >&2
  exit 1
fi

echo "PostgreSQL local recovery selftest passed"
