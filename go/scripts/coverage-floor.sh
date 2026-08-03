#!/usr/bin/env bash
# Coverage floors: per-package minimums pinned at the value each
# package had when its floor landed (rounded down) — floors only ratchet
# UP, never down. The unit (no-tag) lane only; DB-bound runtime coverage
# lives in the integration lane. migrate pins 0 honestly: its unit test
# guards the embedded-migration CONTRACT (shape/order), while Up() runs
# in every integration boot. (Plain list: macOS ships bash 3.2 — no
# associative arrays.)
set -u
cd "$(dirname "$0")/.."
floors="orgconfig:40 objectstore:87 packs:76 prompts:22 contract:100 migrate:0 webhooksig:92 grammar:85 domain:73"
failed=0
for entry in $floors; do
  pkg=${entry%%:*}
  floor=${entry##*:}
  line=$(go test -count=1 -cover "./internal/$pkg/" 2>/dev/null | grep -oE "coverage: [0-9.]+%" | head -1)
  actual=${line#coverage: }; actual=${actual%\%}
  actual_int=${actual%.*}
  if [ -z "$actual" ] || [ "${actual_int:-0}" -lt "$floor" ]; then
    echo "✗ $pkg coverage ${actual:-?}% is below the ${floor}% floor"
    failed=1
  else
    echo "✓ $pkg ${actual}% (floor ${floor}%)"
  fi
done
exit $failed
