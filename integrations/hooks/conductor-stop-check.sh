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
#   stdout at exit 0 is invalid for this event, so the check's own output goes
#   to stderr, and stdout stays empty on a pass and on a block. The one
#   exception is could_not_run below, which on the loop-breaking exit 0 writes a
#   single JSON object with a `systemMessage` to stdout (JSON, not plain text).
# Git pre-commit uses intent-guard-check directly (exit 1).
lifecycle_block() {
  exit 2
}

# Loop policy. Two kinds of failure, treated differently:
# - A FINDING is something the agent can fix, so it blocks every time,
#   stop_hook_active or not. The gate exiting 1 (a budget violation, a hard
#   block) is one. So is a changed path the hook cannot pass on the command
#   line (a comma or a backslash in its name, an untracked nested repository,
#   or more paths than fit): staging it with "git add" sends it through the
#   gate's own --staged channel instead, and the rest of the change is judged
#   either way.
# - A COULD-NOT-RUN condition (no binary, no baseline, a git failure, the gate
#   itself exiting 2 or 127) is something the agent cannot fix. The first time
#   it blocks so the problem is seen; when stop_hook_active says it already
#   did, blocking again only loops and burns tokens, so the stop is allowed
#   with a loud message and nothing was judged.
#
# The message goes to stderr and also to stdout as a JSON object with a
# `systemMessage`, the documented Claude Code field for showing the user a
# warning on a non-blocking exit (plain stdout at exit 0 is only in the debug
# log). The only stdout this script ever writes is that object, escaped by
# intent_guard_json_escape in conductor-lib.sh.

could_not_run() {
  local reason="$1"
  local summary="${2:-the intent check COULD NOT RUN, so this change was NOT judged.}"
  if [[ "$STOP_HOOK_ACTIVE" != "true" ]]; then
    lifecycle_block
  fi
  local msg="Intent Guard: ${summary} Cause: ${reason} This stop was already blocked once, so it is being allowed to avoid a loop. A human must fix the cause (see integrations/hooks/README.md). CI running intent-guard check --base remains the enforcement boundary."
  printf '%s\n' "$msg" >&2
  printf '{"systemMessage":"%s"}\n' "$(intent_guard_json_escape "$msg")"
  exit 0
}

# Fail closed: a git failure must block the stop with the reason on stderr,
# never fall through as an empty path list (which passes). The call sits in an
# `if` so set -e does not exit with the helper's own status instead of the
# lifecycle block code.
#
# A baseline that cannot be used (an invalid record, or no record and no
# upstream) is the one partial case: everything else is still collected
# against a fallback and judged, so a finding there blocks every time, and
# only when nothing blocks is the unjudged committed part reported as
# could-not-run.
ERR_FILE="$(mktemp)"
ARGS_FILE="$(mktemp)"
ISSUES_FILE="$(mktemp)"
PARTIAL=""
if intent_guard_gate_args "$ROOT" "$ARGS_FILE" "$ISSUES_FILE" 2>"$ERR_FILE"; then
  :
else
  collect_status=$?
  DETAIL="$(cat "$ERR_FILE")"
  if [[ "$collect_status" -eq 3 ]]; then
    PARTIAL="${DETAIL:-the session baseline could not be used.}"
  else
    rm -f "$ERR_FILE" "$ARGS_FILE" "$ISSUES_FILE"
    [[ -n "$DETAIL" ]] && printf '%s\n' "$DETAIL" >&2
    echo "Intent Guard: could not collect the changed paths; blocking the stop." >&2
    could_not_run "the changed paths could not be collected: ${DETAIL:-unknown error.}"
  fi
fi
[[ -n "$(cat "$ERR_FILE")" ]] && cat "$ERR_FILE" >&2
rm -f "$ERR_FILE"

GATE_ARGS=()
while IFS= read -r -d '' arg; do
  GATE_ARGS+=("$arg")
done <"$ARGS_FILE"
rm -f "$ARGS_FILE"

# One stderr line per path the hook could not pass. A name with a control
# character in it is printed with %q, so the character is visible rather than
# acted on by the terminal; any other name is printed as it is, in quotes.
UNPASSABLE=0
shown_path() {
  local LC_ALL=C
  if [[ "$1" == *[[:cntrl:]]* ]]; then
    printf '%q' "$1"
  else
    printf '"%s"' "$1"
  fi
}
# Two routes, two different facts. Normally only unstaged and untracked paths
# go on the command line, and staging one moves it to --staged. With the empty
# tree as the baseline (the session began before the first commit) every
# changed path, committed and staged ones too, goes on the command line, so
# nothing the agent does moves it, and the report says so instead.
EMPTY_TREE_ROUTE_NOTE="This session's baseline is the empty tree (it began before the repository's first commit), so every changed path, committed and staged ones included, has to be passed on the command line. A new session started after the first commit records a commit as the baseline and restores full judging."
UNPASSABLE_DETAIL=""
report_unpassable() {
  local path reason line
  while IFS= read -r -d '' path && IFS= read -r -d '' reason; do
    UNPASSABLE=1
    if [[ "${INTENT_GUARD_ALL_IN_PATHS:-0}" -eq 1 ]]; then
      if [[ -z "$path" ]]; then
        line="Intent Guard: ${reason}, so none of them was judged."
      else
        line="Intent Guard: cannot pass the path $(shown_path "$path") to the gate, so it was not judged: ${reason}."
      fi
      UNPASSABLE_DETAIL="${UNPASSABLE_DETAIL}${line#Intent Guard: } "
    elif [[ -z "$path" ]]; then
      line="Intent Guard: ${reason}. Stage them with \"git add\" (staged files reach the gate through --staged instead), or add generated output to .gitignore, then stop again."
    else
      line="Intent Guard: cannot pass the path $(shown_path "$path") to the gate: ${reason}. Stage it with \"git add\" (staged files reach the gate through --staged instead), or rename it, or add it to .gitignore, then stop again."
    fi
    printf '%s\n' "$line" >&2
  done <"$ISSUES_FILE"
  if [[ "$UNPASSABLE" -eq 1 && "${INTENT_GUARD_ALL_IN_PATHS:-0}" -eq 1 ]]; then
    printf 'Intent Guard: %s\n' "$EMPTY_TREE_ROUTE_NOTE" >&2
  fi
}

# A path that cannot be passed is a finding on the normal route, because
# staging it always clears it. On the empty-tree route nothing clears it, so
# there it is could-not-run: it blocks once, then the loud pass.
#
# On that route every path goes through --paths, so when no --paths argument
# was written (the whole list too long, or no path passable at all) the gate
# was handed nothing, passed an empty change, and judged NOTHING. The message
# says which of the two cases this is, never more than was judged.
unpassable_verdict() {
  if [[ "$UNPASSABLE" -ne 1 ]]; then
    return 0
  fi
  if [[ "${INTENT_GUARD_ALL_IN_PATHS:-0}" -eq 1 ]]; then
    local gate_got_paths=0 arg
    for arg in ${GATE_ARGS[@]+"${GATE_ARGS[@]}"}; do
      if [[ "$arg" == "--paths" ]]; then
        gate_got_paths=1
      fi
    done
    if [[ "$gate_got_paths" -eq 1 ]]; then
      could_not_run "${UNPASSABLE_DETAIL}${EMPTY_TREE_ROUTE_NOTE}" \
        "the intent check COULD NOT RUN on all of this change: some changed paths could not be passed to the gate and were NOT judged; the gate judged and passed only the paths it was given."
    fi
    could_not_run "${UNPASSABLE_DETAIL}${EMPTY_TREE_ROUTE_NOTE}" \
      "the intent check COULD NOT RUN on this change: no changed path could be passed to the gate, so NOTHING in this change was judged. To get it judged, make a first commit if there is none and start a new session: its baseline is then a commit, and committed and staged work reaches the gate through the gate's own --base and --staged listings. In that session, stage files with \"git add\" so they reach the gate through --staged."
  fi
  lifecycle_block
}

if [[ -z "$CHECK_CMD" ]]; then
  echo "Intent Guard: intent-guard-check not found; cannot enforce intent gate." >&2
  report_unpassable
  rm -f "$ISSUES_FILE"
  if [[ "$UNPASSABLE" -eq 1 && "${INTENT_GUARD_ALL_IN_PATHS:-0}" -ne 1 ]]; then
    lifecycle_block
  fi
  could_not_run "intent-guard-check was not found on PATH."
fi

# ${arr[@]+...} because bash 3.2 under set -u treats an empty array as unset.
set +e
output="$(eval "$CHECK_CMD --project \"\$ROOT\" \${GATE_ARGS[@]+\"\${GATE_ARGS[@]}\"}" 2>&1)"
status=$?
set -e

if [[ -n "$output" ]]; then
  printf '%s\n' "$output" >&2
fi

report_unpassable
rm -f "$ISSUES_FILE"
if [[ "$UNPASSABLE" -eq 1 && "${INTENT_GUARD_ALL_IN_PATHS:-0}" -ne 1 ]]; then
  # Whatever the gate said: a finding of its own, a pass, or no verdict.
  lifecycle_block
fi

if [[ "$status" -eq 1 ]]; then
  # A finding: the agent can fix it, so it always blocks.
  lifecycle_block
elif [[ "$status" -ne 0 ]]; then
  # Exit 2, 127 or anything else: the gate did not produce a verdict.
  could_not_run "the gate exited with status ${status} instead of a verdict."
fi

# Only reached on the empty-tree route, once the gate has passed what it was
# given: could-not-run for the paths it was not given.
unpassable_verdict

if [[ -n "$PARTIAL" ]]; then
  could_not_run "${PARTIAL}" \
    "the intent check COULD NOT RUN on all of this change: staged, unstaged and untracked changes were judged and passed, but work committed during this session could not be judged against the session's start, so some or all of it was NOT judged."
fi

exit 0
