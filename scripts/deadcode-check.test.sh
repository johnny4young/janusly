#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
bash -n "$root/scripts/deadcode-check.sh"
tmp=$(mktemp -d "${TMPDIR:-/tmp}/janusly-deadcode-test.XXXXXX")
trap 'rm -rf -- "$tmp"' EXIT

# A stub go replays fixture output so the diff logic runs without the real inventory.
mkdir "$tmp/bin"
cat >"$tmp/bin/go" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1 $2" == 'tool deadcode' && "${*: -1}" == './cmd/...' ]] || { echo "unexpected go $*" >&2; exit 2; }
cat "$DEADCODE_FIXTURE"
STUB
chmod +x "$tmp/bin/go"

printf '%s\t%s\n' \
  example.com/m/internal/a.Seam internal/a/a.go \
  example.com/m/internal/a.helper internal/a/helper_test.go \
  example.com/m/internal/b.Reset internal/b/b.go >"$tmp/clean.out"
cat >"$tmp/allow.txt" <<'LIST'
# comment

example.com/m/internal/a.Seam # test seam: a
example.com/m/internal/b.Reset   #   test seam: b
LIST

check() {
  DEADCODE_FIXTURE="$1" JANUSLY_DEADCODE_ALLOWLIST="$2" PATH="$tmp/bin:$PATH" \
    bash "$root/scripts/deadcode-check.sh" >"$tmp/stdout" 2>"$tmp/stderr"
}
expect_failure() {
  local fixture=$1 allow=$2 message=$3
  if check "$fixture" "$allow"; then
    echo "deadcode-check accepted: $message" >&2; exit 1
  fi
  grep -F -- "$message" "$tmp/stderr" >/dev/null || {
    echo "deadcode-check stderr lacks: $message" >&2; cat "$tmp/stderr" >&2; exit 1
  }
}

check "$tmp/clean.out" "$tmp/allow.txt"
grep -F '2 unreachable function(s)' "$tmp/stdout" >/dev/null

{ cat "$tmp/clean.out"; printf 'example.com/m/internal/c.Orphan\tinternal/c/c.go\n'; } >"$tmp/new.out"
expect_failure "$tmp/new.out" "$tmp/allow.txt" '  example.com/m/internal/c.Orphan # <reason>'

grep -v 'b.Reset' "$tmp/clean.out" >"$tmp/stale.out"
expect_failure "$tmp/stale.out" "$tmp/allow.txt" 'example.com/m/internal/b.Reset is no longer reported'

{ cat "$tmp/allow.txt"; printf 'example.com/m/internal/c.Orphan\n'; } >"$tmp/noreason.txt"
expect_failure "$tmp/clean.out" "$tmp/noreason.txt" 'noreason.txt:5: malformed entry'

{ cat "$tmp/allow.txt"; printf 'not an entry # reason\n'; } >"$tmp/malformed.txt"
expect_failure "$tmp/clean.out" "$tmp/malformed.txt" 'malformed.txt:5: malformed entry'

{ cat "$tmp/allow.txt"; printf 'example.com/m/internal/a.Seam # again\n'; } >"$tmp/dup.txt"
expect_failure "$tmp/clean.out" "$tmp/dup.txt" 'duplicate entry: example.com/m/internal/a.Seam'

echo 'deadcode-check tests passed (clean, new, stale, malformed, duplicate)'
