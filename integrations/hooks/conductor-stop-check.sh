#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=conductor-lib.sh
source "$SCRIPT_DIR/conductor-lib.sh"

ROOT="$(conductor_git_root)"
CHECK_CMD="$(conductor_bin "$ROOT" conductor-check || true)"

# Lifecycle hosts map gate failure to exit 2:
# - Claude Code: only exit 2 hard-blocks Stop (exit 1 is non-blocking).
# - Codex: exit 2 + stderr continues the agent with that reason (not a hard
#   reject). Codex Stop also treats plain-text stdout on exit 0 as invalid, so
#   keep human check output on stderr and leave stdout empty on success.
# Git pre-commit uses conductor-check directly (exit 1).
lifecycle_block() {
  exit 2
}

if [[ -z "$CHECK_CMD" ]]; then
  echo "Conductor: conductor-check not found; cannot enforce intent gate." >&2
  lifecycle_block
fi

PATHS="$(conductor_changed_paths_csv "$ROOT")"

set +e
if [[ -n "$PATHS" ]]; then
  out="$(eval "$CHECK_CMD --project \"\$ROOT\" --paths \"\$PATHS\"" 2>&1)"
else
  out="$(eval "$CHECK_CMD --project \"\$ROOT\"" 2>&1)"
fi
status=$?
set -e

if [[ -n "$out" ]]; then
  printf '%s\n' "$out" >&2
fi

if [[ "$status" -ne 0 ]]; then
  lifecycle_block
fi

exit 0
