#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=conductor-lib.sh
source "$SCRIPT_DIR/conductor-lib.sh"

ROOT="$(intent_guard_git_root)"
CHECK_CMD="$(intent_guard_bin "$ROOT" intent-guard-check || true)"

# The host sends a JSON object on stdin. stop_hook_active is true when this stop
# is already the continuation of an earlier Stop block, which is how the hook
# knows it is in a loop. Read with a timeout so a host that leaves stdin open
# cannot hang the hook. Absent, unparseable or false all mean "not active", and
# not active means block.
STOP_HOOK_ACTIVE=false
if [[ ! -t 0 ]]; then
  INPUT=""
  IFS= read -r -t 2 -d '' INPUT || true
  if printf '%s' "$INPUT" | grep -Eq '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
    STOP_HOOK_ACTIVE=true
  fi
fi

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

# Loop policy. Two kinds of failure, treated differently:
# - A FINDING (the gate exits 1: a budget violation, a hard block) is something
#   the agent can fix, so it blocks every time, stop_hook_active or not.
# - A COULD-NOT-RUN condition (no binary, no baseline, a git failure, a path the
#   hook cannot pass, the gate itself exiting 2 or 127) is something the agent
#   cannot fix. The first time it blocks so the problem is seen; when
#   stop_hook_active says it already did, blocking again only loops and burns
#   tokens, so the stop is allowed with a loud message and nothing was judged.
#
# The message goes to stderr and also to stdout as a JSON object with a
# `systemMessage`, the documented Claude Code field for showing the user a
# warning on a non-blocking exit (plain stdout at exit 0 is only in the debug
# log). The only stdout this script ever writes is that object.
json_escape() {
  printf '%s' "$1" | tr '\n\t' '  ' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

could_not_run() {
  local reason="$1"
  if [[ "$STOP_HOOK_ACTIVE" != "true" ]]; then
    lifecycle_block
  fi
  local msg="Intent Guard: the intent check COULD NOT RUN, so this change was NOT judged. Cause: ${reason} This stop was already blocked once, so it is being allowed to avoid a loop. A human must fix the cause (see integrations/hooks/README.md). CI running intent-guard check --base remains the enforcement boundary."
  printf '%s\n' "$msg" >&2
  printf '{"systemMessage":"%s"}\n' "$(json_escape "$msg")"
  exit 0
}

if [[ -z "$CHECK_CMD" ]]; then
  echo "Intent Guard: intent-guard-check not found; cannot enforce intent gate." >&2
  could_not_run "intent-guard-check was not found on PATH."
fi

# Fail closed: a git failure or an unrepresentable path must block the stop with
# the reason on stderr, never fall through as an empty path list (which passes).
# The assignment sits in an `if` so set -e does not exit with the helper's own
# status instead of the lifecycle block code.
ERR_FILE="$(mktemp)"
if ! PATHS="$(intent_guard_changed_paths_csv "$ROOT" 2>"$ERR_FILE")"; then
  DETAIL="$(cat "$ERR_FILE")"
  rm -f "$ERR_FILE"
  [[ -n "$DETAIL" ]] && printf '%s\n' "$DETAIL" >&2
  echo "Intent Guard: could not collect the changed paths; blocking the stop." >&2
  could_not_run "the changed paths could not be collected: ${DETAIL:-unknown error.}"
fi
[[ -n "$(cat "$ERR_FILE")" ]] && cat "$ERR_FILE" >&2
rm -f "$ERR_FILE"

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

if [[ "$status" -eq 1 ]]; then
  # A finding: the agent can fix it, so it always blocks.
  lifecycle_block
elif [[ "$status" -ne 0 ]]; then
  # Exit 2, 127 or anything else: the gate did not produce a verdict.
  could_not_run "the gate exited with status ${status} instead of a verdict."
fi

exit 0
