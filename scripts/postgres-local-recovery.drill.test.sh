#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
script="$root/scripts/postgres-local-recovery.drill.sh"

bash -n "$script"
result=$(
  JANUSLY_RECOVERY_DRILL_PROJECT=janusly-recovery-drill-selftest \
    bash "$script" selftest
)
jq -e '
  .sourceProject == "janusly-recovery-drill-selftest-source" and
  .targetProject == "janusly-recovery-drill-selftest-target" and
  .portRange.start < .portRange.end
' <<<"$result" >/dev/null

if bash "$script" run >/dev/null 2>&1; then
  echo 'recovery drill accepted a run without confirmation' >&2
  exit 1
fi
if JANUSLY_RECOVERY_DRILL_PROJECT=janusly bash "$script" selftest >/dev/null 2>&1; then
  echo 'recovery drill accepted the development project' >&2
  exit 1
fi
if JANUSLY_RECOVERY_DRILL_PORT_START=55538 JANUSLY_RECOVERY_DRILL_PORT_END=55538 \
  bash "$script" selftest >/dev/null 2>&1; then
  echo 'recovery drill accepted a one-port range' >&2
  exit 1
fi

fake_bin=$(mktemp -d "${TMPDIR:-/tmp}/janusly-recovery-drill-test.XXXXXX")
trap 'rm -rf -- "$fake_bin"' EXIT
cat >"$fake_bin/docker" <<'EOF'
#!/usr/bin/env bash
if [[ ${1:-} == ps && ${2:-} == -aq ]]; then
  echo preexisting-container
  exit 0
fi
echo "unexpected Docker operation: $*" >&2
exit 99
EOF
chmod +x "$fake_bin/docker"
if CONFIRM=drill PATH="$fake_bin:$PATH" \
  JANUSLY_RECOVERY_DRILL_PROJECT=janusly-recovery-drill-occupied \
  bash "$script" run >"$fake_bin/output" 2>&1; then
  echo 'recovery drill reused an existing project' >&2
  exit 1
fi
grep -Fq 'source project already owns resources' "$fake_bin/output" || {
  cat "$fake_bin/output" >&2
  echo 'recovery drill did not reject existing project resources' >&2
  exit 1
}

echo 'PostgreSQL local recovery drill selftest passed'
