#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=conductor-lib.sh
source "$SCRIPT_DIR/conductor-lib.sh"

ROOT="$(intent_guard_git_root)"

# Record where the session began so the Stop check can judge work the agent
# commits during the turn. Done first, before any early exit below: a project
# with no contract yet can freeze one mid-session. Best effort: without the
# record the Stop check falls back and says so.
intent_guard_record_session_start "$ROOT" \
  || echo "Intent Guard: could not record the session start; the Stop check will fall back." >&2

RESUME_CMD="$(intent_guard_bin "$ROOT" intent-guard-resume || true)"

if [[ -z "$RESUME_CMD" ]]; then
  echo "Intent Guard: intent-guard-resume not found; skipping session brief." >&2
  exit 0
fi

# The state directory was renamed from .conductor to .intent-guard in 1.3.0.
# Accept either, so this hook keeps working on a project that has not been
# migrated yet.
if [[ ! -f "$ROOT/.intent-guard/intent-contract.yaml" && ! -f "$ROOT/.conductor/intent-contract.yaml" ]]; then
  echo "Intent Guard: no active intent contract found."
  exit 0
fi

echo "Intent Guard session brief:"
eval "$RESUME_CMD --project \"\$ROOT\""
