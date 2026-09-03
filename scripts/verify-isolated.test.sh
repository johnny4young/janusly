#!/usr/bin/env bash
set -Eeuo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/janusly-verify-test.XXXXXX")
trap 'rm -rf -- "$tmp"' EXIT INT TERM

bash -n "$root/scripts/verify-isolated.sh"
summary=$(
  JANUSLY_VERIFY_DOCKER_BIN=true \
  JANUSLY_VERIFY_MAKE_BIN=true \
    "$root/scripts/verify-isolated.sh" selftest
)
jq -e '
  (.project | startswith("janusly-verify-")) and
  .portRange == {start:55438,end:55537}
' <<<"$summary" >/dev/null

if JANUSLY_VERIFY_PROJECT=janusly \
  JANUSLY_VERIFY_DOCKER_BIN=true JANUSLY_VERIFY_MAKE_BIN=true \
  "$root/scripts/verify-isolated.sh" selftest >/dev/null 2>&1; then
  printf 'verify selftest accepted the development project\n' >&2
  exit 1
fi
if JANUSLY_VERIFY_PORT_START=6000 JANUSLY_VERIFY_PORT_END=5000 \
  JANUSLY_VERIFY_DOCKER_BIN=true JANUSLY_VERIFY_MAKE_BIN=true \
  "$root/scripts/verify-isolated.sh" selftest >/dev/null 2>&1; then
  printf 'verify selftest accepted a reversed port range\n' >&2
  exit 1
fi

cat >"$tmp/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'docker %s\n' "$*" >>"$JANUSLY_VERIFY_TEST_LOG"
case " $* " in
  *" ps -aq "*|*" volume ls -q "*|*" network ls -q "*) exit 0 ;;
  *) exit 0 ;;
esac
EOF
cat >"$tmp/make" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'make %s\n' "$*" >>"$JANUSLY_VERIFY_TEST_LOG"
if [[ ${JANUSLY_VERIFY_TEST_FAIL:-0} == 1 && " $* " == *" verify-current-db "* ]]; then
  exit 7
fi
EOF
chmod +x "$tmp/docker" "$tmp/make"

run_fake() {
  local log=$1
  shift
  JANUSLY_VERIFY_TEST_LOG="$log" \
  JANUSLY_VERIFY_PROJECT=janusly-verify-selftest \
  JANUSLY_VERIFY_POSTGRES_PORT=55438 \
  JANUSLY_VERIFY_DOCKER_BIN="$tmp/docker" \
  JANUSLY_VERIFY_MAKE_BIN="$tmp/make" \
    "$@" "$root/scripts/verify-isolated.sh"
}

success_log="$tmp/success.log"
run_fake "$success_log" env >/dev/null
[[ $(grep -c ' migrate DB_URL=' "$success_log") == 2 ]]
[[ $(grep -c ' verify-current-db DB_URL=' "$success_log") == 1 ]]
grep -F 'compose -f' "$success_log" | grep -F 'down --volumes --remove-orphans' >/dev/null

failure_log="$tmp/failure.log"
if run_fake "$failure_log" env JANUSLY_VERIFY_TEST_FAIL=1 >/dev/null 2>&1; then
  printf 'verify selftest swallowed the acceptance failure\n' >&2
  exit 1
fi
grep -F 'down --volumes --remove-orphans' "$failure_log" >/dev/null

printf 'isolated verification harness selftest passed\n'
