#!/usr/bin/env bash
# make verify: the one-command truth ladder — fail on the FIRST
# broken stage, print per-stage timing. Assumes the pilot DB is up
# (make db-up + make migrate once per checkout).
set -u
cd "$(dirname "$0")/.."
DB_URL="${JANUSLY_GO_DATABASE_URL:-postgres://janusly:janusly-go-local@127.0.0.1:4632/janusly_go}"
total_start=$(date +%s)

stage() {
  local name="$1"; shift
  local start elapsed
  start=$(date +%s)
  echo "== verify: $name =="
  if ! "$@"; then
    elapsed=$(( $(date +%s) - start ))
    echo "✗ $name failed after ${elapsed}s — stopping (stages after this did not run)"
    exit 1
  fi
  elapsed=$(( $(date +%s) - start ))
  echo "✓ $name (${elapsed}s)"
}

drift_check() {
  make generate > /dev/null && git diff --quiet -- internal/store \
    || { echo "sqlc output drifted: run make generate and commit"; return 1; }
}
unit_tests() { go test -race ./... > /dev/null; }
integration_tests() { JANUSLY_GO_DATABASE_URL="$DB_URL" go test -race -tags integration -p 1 ./... > /dev/null; }
parity_tests() {
  JANUSLY_GO_DATABASE_URL="$DB_URL" go test -race -tags integration -count=1 -run TestSemanticParity ./internal/parity/ > /dev/null
}

stage "generate + drift" drift_check
stage "build" go build ./...
stage "lint" golangci-lint run ./...
stage "unit" unit_tests
stage "integration" integration_tests
stage "parity" parity_tests

echo "== verify green in $(( $(date +%s) - total_start ))s =="
