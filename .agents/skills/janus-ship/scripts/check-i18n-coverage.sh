#!/usr/bin/env bash
set -euo pipefail

exec "$(dirname "$0")/../../../../apps/web/scripts/check-i18n-coverage.sh" "$@"
