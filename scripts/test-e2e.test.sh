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
jq -e '.project == "janusly-e2e-selftest-1" and .ports == {application:33001,postgres:35432,internal:33002}' \
  <<<"$result" >/dev/null
jq -e --arg commit "$expected_commit" --arg tree "$expected_tree" --arg id "$expected_id" \
  '.build == {commit:$commit,tree:$tree,id:$id}' <<<"$result" >/dev/null
jq -e '.specs == [
  "e2e/janusly-smoke.spec.ts", "e2e/guided-authoring.spec.ts",
  "e2e/durable-authoring.spec.ts", "e2e/text-search.spec.ts",
  "e2e/flows-table.spec.ts",
  "e2e/operator-velocity.spec.ts", "e2e/workflow-rollouts.spec.ts",
  "e2e/recovery-confidence-passport.spec.ts", "e2e/responsive.spec.ts",
  "e2e/usability-study-readiness.spec.ts", "e2e/credential-revoke.spec.ts",
  "e2e/activity-workspace.spec.ts", "e2e/run-observability.spec.ts",
  "e2e/accessibility.spec.ts",
  "e2e/ai-efficiency-observability.spec.ts",
  "e2e/ai-studio-provider.spec.ts", "e2e/api-contract-v1.spec.ts",
  "e2e/approachable-ai-step.spec.ts",
  "e2e/approachable-authoring.spec.ts", "e2e/approachable-branch-rule.spec.ts",
  "e2e/approachable-human-form.spec.ts", "e2e/approachable-run-inputs.spec.ts",
  "e2e/approachable-tool-step.spec.ts",
  "e2e/auth-policy.spec.ts", "e2e/authoring-guidance.spec.ts",
  "e2e/bounded-waiting.spec.ts",
  "e2e/budget.spec.ts", "e2e/confirm-dialog-focus.spec.ts",
  "e2e/credential-rotation-focus.spec.ts", "e2e/css-system-contract.spec.ts",
  "e2e/demo-templates.spec.ts",
  "e2e/docs-capability.spec.ts", "e2e/external-runtime-shadow.spec.ts",
  "e2e/inbound-webhook-trigger.spec.ts", "e2e/loop-for-each.spec.ts",
  "e2e/prompt-drafting.spec.ts", "e2e/recovery-center.spec.ts",
  "e2e/recovery-drill-outcomes.spec.ts", "e2e/recovery-effectiveness.spec.ts",
  "e2e/recovery-exploration.spec.ts", "e2e/recovery-impact.spec.ts",
  "e2e/recovery-loop.spec.ts", "e2e/recovery-momentum.spec.ts",
  "e2e/replay-campaigns.spec.ts", "e2e/report-delivery.spec.ts",
  "e2e/run-explainability.spec.ts", "e2e/run-workspace.spec.ts",
  "e2e/settings-inventory.spec.ts", "e2e/solution-packs.spec.ts",
  "e2e/step-kind-change.spec.ts", "e2e/subworkflow-composition.spec.ts",
  "e2e/task-space-navigation.spec.ts", "e2e/technical-recovery-autonomy.spec.ts",
  "e2e/views.spec.ts", "e2e/web-control-plane-contract.spec.ts",
  "e2e/workflow.spec.ts", "e2e/workflow-data-contracts.spec.ts",
  "e2e/workflow-folders.spec.ts", "e2e/workflow-language.spec.ts",
  "e2e/workflow-tags.spec.ts", "e2e/workflow-trash.spec.ts",
  "e2e/compressed-assets.spec.ts",
  "e2e/publish-requests.spec.ts"
]' <<<"$result" >/dev/null || { echo "lane spec selection drifted from the expected list" >&2; exit 1; }
while IFS= read -r spec; do
  [[ -f "$root/web/$spec" ]] || { echo "lane selects a missing spec: $spec" >&2; exit 1; }
done < <(jq -r '.specs[], .experience.specs[]' <<<"$result")

jq -e '.experience == {
  specs:["e2e/authoring-experience.spec.ts"],
  profiles:["review","shadow","off","disabled"],
  baseline:{enabled:false,mode:"off",memoryEnabled:false}
}' <<<"$result" >/dev/null

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
internal=$(JANUSLY_E2E_PROJECT=janusly-e2e-selftest-3 JANUSLY_E2E_PORT=43118 JANUSLY_E2E_POSTGRES_PORT=45118 \
  bash "$script" selftest | jq -r '.ports.internal')
[[ $internal == 43119 ]] || { echo "internal port did not follow the application port: $internal" >&2; exit 1; }
if JANUSLY_E2E_PROJECT=janusly-e2e-selftest-4 JANUSLY_E2E_PORT=33001 JANUSLY_E2E_POSTGRES_PORT=35432 \
  JANUSLY_E2E_INTERNAL_PORT=35432 bash "$script" selftest >/dev/null 2>&1; then
  echo "internal port overlapping PostgreSQL was accepted" >&2
  exit 1
fi
if JANUSLY_E2E_PROJECT=other-project bash "$script" selftest >/dev/null 2>&1; then
  echo "unowned project prefix was accepted" >&2
  exit 1
fi

echo "test-e2e harness self-test passed"
