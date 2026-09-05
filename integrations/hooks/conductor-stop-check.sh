#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=conductor-lib.sh
source "$SCRIPT_DIR/conductor-lib.sh"

ROOT="$(intent_guard_git_root)"
CHECK_CMD="$(intent_guard_bin "$ROOT" intent-guard-check || true)"

# Both lifecycle hosts map a gate failure to exit 2, and both read the reason
# from stderr:
# - Claude Code: only exit 2 prevents the stop. Exit 1 is non-blocking (the
#   turn still ends), and stdout on exit 0 goes to the debug log only.
# - Codex: exit 2 continues the agent with the stderr reason. Plain text on
#   stdout at exit 0 is invalid for this event, so stdout stays empty on every
#   path and the check's own output goes to stderr.
# Git pre-commit uses intent-guard-check directly (exit 1).
lifecycle_block() {
  exit 2
}

if [[ -z "$CHECK_CMD" ]]; then
  echo "Intent Guard: intent-guard-check not found; cannot enforce intent gate." >&2
  lifecycle_block
fi

PATHS="$(intent_guard_changed_paths_csv "$ROOT")"

set +e
if [[ -n "$PATHS" ]]; then
  output="$(eval "$CHECK_CMD --project \"\$ROOT\" --paths \"\$PATHS\"" 2>&1)"
else
  output="$(eval "$CHECK_CMD --project \"\$ROOT\"" 2>&1)"
fi
status=$?
set -e

if [[ -n "$output" ]]; then
  printf '%s\n' "$output" >&2
fi

if [[ "$status" -ne 0 ]]; then
  lifecycle_block
fi

exit 0
