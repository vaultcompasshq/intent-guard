#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=conductor-lib.sh
source "$SCRIPT_DIR/conductor-lib.sh"

ROOT="$(intent_guard_git_root)"
RESUME_CMD="$(intent_guard_bin "$ROOT" intent-guard-resume || true)"

if [[ -z "$RESUME_CMD" ]]; then
  echo "Intent Guard: intent-guard-resume not found; skipping session brief." >&2
  exit 0
fi

if [[ ! -f "$ROOT/.conductor/intent-contract.yaml" ]]; then
  echo "Intent Guard: no active intent contract found."
  exit 0
fi

echo "Intent Guard session brief:"
eval "$RESUME_CMD --project \"\$ROOT\""
