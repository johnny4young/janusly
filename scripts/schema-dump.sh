#!/usr/bin/env bash
# Regenerate schema.sql from a freshly migrated PostgreSQL 18 database that
# runs under the given Compose project. pg_dump runs inside the container,
# so the host needs no PostgreSQL client. The file is generated output in
# pg_dump's object order; hand edits belong in the baseline migration.
#
# Usage: scripts/schema-dump.sh <compose-project> [output]
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
project=${1:?usage: scripts/schema-dump.sh <compose-project> [output]}
output=${2:-$root/schema.sql}
docker_bin=${JANUSLY_VERIFY_DOCKER_BIN:-docker}

tmp=$(mktemp "${TMPDIR:-/tmp}/janusly-schema.XXXXXX")
trap 'rm -f "$tmp"' EXIT

# pg_dump 18 brackets the file with \restrict/\unrestrict psql guards that
# mean nothing to sqlc; everything else is kept verbatim.
"$docker_bin" compose -f "$root/docker-compose.yml" -p "$project" exec -T postgres \
  pg_dump -U janusly -d janusly --schema-only --no-owner --no-privileges \
  | grep -Ev '^\\(un)?restrict ' >"$tmp"

grep -q 'CREATE TABLE public.runs (' "$tmp" || {
  echo "schema-dump: the dump from project $project does not look like a migrated Janusly database" >&2
  exit 1
}
mv "$tmp" "$output"
trap - EXIT
echo "schema-dump: wrote $output from project $project"
