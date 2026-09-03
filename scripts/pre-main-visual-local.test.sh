#!/usr/bin/env bash
set -Eeuo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
script="$root/scripts/pre-main-visual-local.sh"

bash -n "$script"
result=$(JANUSLY_VISUAL_RUN_ID=selftest-1 \
  JANUSLY_EVIDENCE_DIR=output/qualification/selftest-visual \
  JANUSLY_VISUAL_BEFORE_PORT=37331 JANUSLY_VISUAL_AFTER_PORT=37332 \
  bash "$script" selftest)
jq -e '
  .projects.before == "janusly-visual-before-selftest-1" and
  .projects.after == "janusly-visual-after-selftest-1" and
  .ports.beforeApplication == 37331 and
  .ports.afterApplication == 37332 and
  .evidenceRoot == $evidenceRoot
' --arg evidenceRoot "$root/output/qualification/selftest-visual" <<<"$result" >/dev/null

if JANUSLY_VISUAL_BEFORE_PROJECT=janusly-visual-before \
  bash "$script" selftest >/dev/null 2>&1; then
  echo 'historical shared before project was accepted' >&2
  exit 1
fi
if JANUSLY_VISUAL_AFTER_PROJECT=janusly-visual-after \
  bash "$script" selftest >/dev/null 2>&1; then
  echo 'historical shared after project was accepted' >&2
  exit 1
fi
if JANUSLY_VISUAL_BEFORE_PROJECT=janusly-visual-before-same \
  JANUSLY_VISUAL_AFTER_PROJECT=janusly-visual-before-same \
  bash "$script" selftest >/dev/null 2>&1; then
  echo 'identical before and after projects were accepted' >&2
  exit 1
fi
if JANUSLY_VISUAL_BEFORE_PROJECT=other-project \
  bash "$script" selftest >/dev/null 2>&1; then
  echo 'unowned visual project prefix was accepted' >&2
  exit 1
fi
if JANUSLY_VISUAL_AFTER_PORT=35434 JANUSLY_VISUAL_AFTER_POSTGRES_PORT=35434 \
  bash "$script" selftest >/dev/null 2>&1; then
  echo 'overlapping after ports were accepted' >&2
  exit 1
fi

grep -F 'project_has_resources "$active_project"' "$script" >/dev/null
grep -F 'if ((active_attempted))' "$script" >/dev/null
grep -F 'validate_visual_evidence "$phase"' "$script" >/dev/null

echo 'pre-main visual harness self-test passed'
