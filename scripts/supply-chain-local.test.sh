#!/usr/bin/env bash
set -Eeuo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)

bash -n "$root/scripts/supply-chain-local.sh"
result=$(JANUSLY_SUPPLY_CHAIN_SELFTEST=1 "$root/scripts/supply-chain-local.sh")
jq -e '
  .image == "janusly:supply-chain" and
  (.sbomGenerator | test("@sha256:[0-9a-f]{64}$")) and
  (.syftImage | test("@sha256:[0-9a-f]{64}$")) and
  .provenanceMode == "max" and
  .spdxVersion == "SPDX-2.3" and
  .signed == false and
  .published == false
' <<<"$result" >/dev/null

if JANUSLY_SUPPLY_CHAIN_SELFTEST=1 JANUSLY_SYFT_IMAGE=anchore/syft:latest \
  "$root/scripts/supply-chain-local.sh" >/dev/null 2>&1; then
  echo 'expected an unpinned Syft image to be refused' >&2
  exit 1
fi

echo 'supply chain harness selftest passed without Docker mutation'
