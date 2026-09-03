#!/usr/bin/env bash
set -euo pipefail

root=${JANUSLY_SOURCE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}

git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1 || {
  printf 'production image: %s is not a Git worktree\n' "$root" >&2
  exit 2
}

if [[ -n $(git -C "$root" status --porcelain --untracked-files=all) ]]; then
  cat >&2 <<'EOF'
production image: refusing to label a dirty source tree as the current commit.
Commit or remove local changes, then run make build again.
EOF
  exit 2
fi
