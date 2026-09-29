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
#
# The host sends a JSON object on stdin whose `source` says why the session
# started (Claude Code: startup, resume, clear or compact). Read with a timeout
# so a host that leaves stdin open cannot hang the hook. No field is fine: see
# intent_guard_record_session_start for how an absent source is treated.
SOURCE=""
if [[ ! -t 0 ]]; then
  INPUT=""
  IFS= read -r -t 2 -d '' INPUT || true
  SOURCE="$(printf '%s' "$INPUT" | sed -n 's/.*"source"[[:space:]]*:[[:space:]]*"\([A-Za-z_]*\)".*/\1/p' | head -n 1)"
fi

intent_guard_record_session_start "$ROOT" "$SOURCE" \
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
