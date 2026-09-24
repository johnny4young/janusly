#!/usr/bin/env bash
# A required check must not pass because a needed job was skipped after a
# dependency failed. Only classifier-authorized skips are acceptable.
set -euo pipefail
: "${NEEDS_JSON:?NEEDS_JSON must contain the workflow needs object}"
jq -er '
  . as $needs |
  if .changes.result != "success" then error("path classification did not succeed") else . end |
  .changes.outputs as $flags |
  if (["web", "go", "website", "product"] | all(. as $key | $flags[$key] == "true" or $flags[$key] == "false"))
    then . else error("missing or invalid classification flags") end |
  if ($flags.product == "true") == ($flags.web == "true" or $flags.go == "true")
    then . else error("inconsistent product classification") end |
  {frontend: $flags.web, backend: $flags.go, integration: $flags.go,
   ha: $flags.go, parity: $flags.product, e2e: $flags.product, website: $flags.website} |
  to_entries | map(
    .key as $job | (if .value == "true" then "success" else "skipped" end) as $expected |
    if $needs[$job].result == $expected
      then "\($job): \($expected)"
      else error("\($job): expected \($expected), got \($needs[$job].result // "missing")") end
  ) | .[]
' <<< "$NEEDS_JSON"
