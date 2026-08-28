#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
script="$root/scripts/oci-railway-local.sh"
bash -n "$script"
grep -F '"$origin/readyz"' "$script" >/dev/null
grep -F 'compose stop postgres' "$script" >/dev/null
grep -F 'readiness returned $ready_status while PostgreSQL was down' "$script" >/dev/null

result=$(JANUSLY_OCI_SELFTEST=1 "$script")
jq -e '.project | startswith("janusly-qualification-oci-")' <<<"$result" >/dev/null
jq -e '.providerCalls == 0 and .remoteDeployment == false' <<<"$result" >/dev/null

if JANUSLY_OCI_PROJECT=janusly JANUSLY_OCI_SELFTEST=1 "$script" >/dev/null 2>&1; then
  echo "OCI selftest accepted the ordinary Compose project" >&2
  exit 1
fi
if IMAGE="bad image" JANUSLY_OCI_SELFTEST=1 "$script" >/dev/null 2>&1; then
  echo "OCI selftest accepted an invalid image reference" >&2
  exit 1
fi
if JANUSLY_OCI_ORIGIN=https://remote.example JANUSLY_OCI_SELFTEST=1 "$script" >/dev/null 2>&1; then
  echo "OCI selftest accepted a remote origin" >&2
  exit 1
fi
if "$script" >/dev/null 2>&1; then
  echo "OCI harness accepted missing isolated reset confirmation" >&2
  exit 1
fi

echo "OCI/Railway harness selftest passed without Docker mutation"
