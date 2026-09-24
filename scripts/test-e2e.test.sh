#!/usr/bin/env bash
set -Eeuo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
script="$root/scripts/test-e2e.sh"

zero_commit=0000000000000000000000000000000000000000
expected_commit=$zero_commit expected_tree=$zero_commit expected_id=local
if JANUSLY_SOURCE_ROOT="$root" bash "$root/scripts/assert-clean-source.sh" >/dev/null 2>&1; then
  expected_commit=$(git -C "$root" rev-parse HEAD)
  expected_tree=$(git -C "$root" rev-parse 'HEAD^{tree}')
  expected_id=$(git -C "$root" rev-parse --short HEAD)
fi

result=$(JANUSLY_SOURCE_ROOT=/not-this-checkout \
  JANUSLY_BUILD_COMMIT=ffffffffffffffffffffffffffffffffffffffff \
  JANUSLY_BUILD_TREE=ffffffffffffffffffffffffffffffffffffffff \
  JANUSLY_BUILD_ID=spoofed \
  JANUSLY_E2E_PROJECT=janusly-e2e-selftest-1 \
  JANUSLY_E2E_PORT=33001 JANUSLY_E2E_POSTGRES_PORT=35432 \
  bash "$script" selftest)
jq -e '.project == "janusly-e2e-selftest-1" and .ports.application == 33001 and .ports.postgres == 35432' \
  <<<"$result" >/dev/null
jq -e --arg commit "$expected_commit" --arg tree "$expected_tree" --arg id "$expected_id" \
  '.build == {commit:$commit,tree:$tree,id:$id}' <<<"$result" >/dev/null
jq -e '.specs == [
  "e2e/janusly-smoke.spec.ts", "e2e/text-search.spec.ts",
  "e2e/operator-velocity.spec.ts", "e2e/workflow-rollouts.spec.ts",
  "e2e/recovery-confidence-passport.spec.ts", "e2e/responsive.spec.ts",
  "e2e/usability-study-readiness.spec.ts"
]' <<<"$result" >/dev/null

if JANUSLY_E2E_PROJECT=janusly-e2e bash "$script" selftest >/dev/null 2>&1; then
  echo "historical shared project was accepted" >&2
  exit 1
fi
if JANUSLY_E2E_PROJECT=janusly-e2e-selftest-2 \
  JANUSLY_E2E_PORT=35432 JANUSLY_E2E_POSTGRES_PORT=35432 \
  bash "$script" selftest >/dev/null 2>&1; then
  echo "overlapping ports were accepted" >&2
  exit 1
fi
if JANUSLY_E2E_PROJECT=other-project bash "$script" selftest >/dev/null 2>&1; then
  echo "unowned project prefix was accepted" >&2
  exit 1
fi

echo "test-e2e harness self-test passed"
