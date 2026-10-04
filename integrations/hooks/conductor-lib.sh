#!/usr/bin/env bash
#
# Shared helpers for the Intent Guard lifecycle hook adapters.
#
# The file names in this directory still say "conductor". They are referenced by
# paths inside users' own .claude/settings.json and .codex/hooks.json, so
# renaming them would break every project that already wired them up. The
# commands they invoke are the new intent-guard-* binaries.

set -euo pipefail

# Replace objects (refs/replace/*) let anyone with write access to the
# repository make one commit stand in for another, so a commit made during the
# session could be shown to git as the baseline itself and every diff against
# the baseline would come back empty. Exported, so it holds for every git call
# the hooks make AND for the gate they run, whose own --base and --staged
# listings carry the session's committed and staged work. It is the
# environment form of git's --no-replace-objects.
export GIT_NO_REPLACE_OBJECTS=1

# Repository config (core.useReplaceRefs=true) would turn replace refs back on
# over that variable. Config passed through the environment the way `git -c`
# passes it sits above repository config, so it is added here, after any
# entries the host's environment already carries rather than over them.
intent_guard_config_index="${GIT_CONFIG_COUNT:-0}"
if [[ ! "$intent_guard_config_index" =~ ^[0-9]+$ ]]; then
  intent_guard_config_index=0
fi
export "GIT_CONFIG_KEY_${intent_guard_config_index}=core.useReplaceRefs"
export "GIT_CONFIG_VALUE_${intent_guard_config_index}=false"
export GIT_CONFIG_COUNT=$((intent_guard_config_index + 1))
unset intent_guard_config_index

# Text made safe to sit inside a JSON string literal. Every control character
# (0x01 to 0x1F) becomes a space, because JSON forbids them raw and the text is
# for a human; then backslash, then the double quote, are escaped. A NUL never
# reaches a shell variable. Under LC_ALL=C so tr works on bytes.
intent_guard_json_escape() {
  printf '%s' "$1" | LC_ALL=C tr '\001-\037' ' ' | LC_ALL=C sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

intent_guard_git_root() {
  git rev-parse --show-toplevel 2>/dev/null || pwd
}

# Resolve the binary that judges the change.
#
# The installed binary on PATH is the default and the only thing trusted. The
# in-repo build (packages/skill/dist) is used only when the OPERATOR sets
# INTENT_GUARD_DEV_DIST=1 in the hook's environment, which is what developing
# Intent Guard itself needs. Nothing inside the repository can switch it on:
# dist is normally gitignored, so a planted file there never shows in a diff, and
# anything the repo can say about itself (a package.json name, say) is one edit
# away for an agent. An environment variable the host process sets is not.
intent_guard_bin() {
  local root="$1"
  local name="$2"
  local dist="$root/packages/skill/dist/${name#intent-guard-}-cli.js"

  if [[ "${INTENT_GUARD_DEV_DIST:-}" == "1" && -f "$dist" ]]; then
    printf 'node %q' "$dist"
    return 0
  fi

  if command -v "$name" >/dev/null 2>&1; then
    printf '%q' "$name"
    return 0
  fi

  return 1
}

# ---------------------------------------------------------------------------
# Session baseline
#
# "Changed in this session" has to include work the agent COMMITTED, which
# leaves an empty working-tree diff. SessionStart therefore records HEAD, and
# the Stop check diffs against it. The record lives under the git directory
# (never in the tracked tree, so an agent cannot see it in a diff and it is
# never committed): line 1 is the ref, line 2 is the contract id it was taken
# under.

intent_guard_empty_tree() {
  # The empty tree, for a repository with no commit yet. Computed rather than
  # hard-coded so it is right for SHA-256 repositories too.
  git -C "$1" hash-object -t tree /dev/null
}

intent_guard_baseline_file() {
  local root="$1"
  local path
  path="$(git -C "$root" rev-parse --git-path intent-guard-session-start)" || return 1
  case "$path" in
    /*) printf '%s' "$path" ;;
    *) printf '%s/%s' "$root" "$path" ;;
  esac
}

intent_guard_contract_id() {
  local root="$1"
  local file
  for file in "$root/.intent-guard/intent-contract.yaml" "$root/.conductor/intent-contract.yaml"; do
    if [[ -f "$file" ]]; then
      local line
      line="$(grep -m1 '^contract_id:' "$file" || true)"
      if [[ -n "$line" ]]; then
        printf '%s' "$line"
        return 0
      fi
    fi
  done
  printf 'none'
}

# A recorded baseline is trusted only if it is a full object id that names
# either the empty tree (the widest possible baseline) or a COMMIT that is an
# ancestor of HEAD. A short name such as HEAD, a tree such as HEAD^{tree}, a
# tag, or a commit off this history would all narrow the diff, and the agent can
# write to this file, so anything else is refused.
intent_guard_baseline_valid() {
  local root="$1"
  local ref="$2"
  [[ "$ref" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || return 1
  if [[ "$ref" == "$(intent_guard_empty_tree "$root")" ]]; then
    return 0
  fi
  [[ "$(git -C "$root" cat-file -t "$ref" 2>/dev/null)" == "commit" ]] || return 1
  git -C "$root" merge-base --is-ancestor "$ref" HEAD 2>/dev/null
}

# Called by SessionStart with the hook's `source` field (may be empty).
#
# startup and clear begin a NEW session, so they always record a fresh baseline:
# keeping an old one would judge the human's commits between sessions against
# this session's contract. Every other source (resume, compact, absent or
# unrecognised) is treated as a continuation, and a continuation never touches
# a record that exists: resetting there would let an agent commit, compact, and
# have the commit forgotten. That holds for an INVALID record too, which the
# Stop check then reports rather than having it quietly replaced by HEAD, and
# it holds when the contract id has changed, so the session is judged from
# where it began. Only when there is no record at all is one written, since
# otherwise a host that never sends startup could never get a baseline.
#
# Line 2 (the contract id) is still written for older readers of the record;
# nothing here compares it any more.
intent_guard_record_session_start() {
  local root="$1"
  local source="${2:-}"
  local file head cid

  file="$(intent_guard_baseline_file "$root")" || return 1

  case "$source" in
    startup | clear)
      # Something other than a regular file at the record path (a directory, a
      # link) cannot be written over, and would leave every later stop without
      # a record. A new session removes it first.
      if [[ -L "$file" || (-e "$file" && ! -f "$file") ]]; then
        rm -rf -- "$file" || return 1
      fi
      ;;
    *)
      if [[ -f "$file" ]]; then
        if ! intent_guard_baseline_valid "$root" "$(sed -n '1p' "$file")"; then
          echo "Intent Guard: the session baseline record ($file) is not a commit that is an ancestor of HEAD (or the empty tree), so it was left as it is. Until a new session starts, the Stop check still collects staged, unstaged and untracked changes for the gate but cannot judge work committed during this session in full; start a new session to record a fresh baseline." >&2
        fi
        return 0
      fi
      ;;
  esac

  if head="$(git -C "$root" rev-parse --verify --quiet 'HEAD^{commit}')"; then
    :
  else
    head="$(intent_guard_empty_tree "$root")" || return 1
  fi
  cid="$(intent_guard_contract_id "$root")"
  printf '%s\n%s\n' "$head" "$cid" >"$file"
}

# What the change can still be judged against when the session baseline cannot
# be used: the upstream branch when there is one, else HEAD, else (no commit
# yet) the empty tree. Staged, unstaged and untracked work is all visible from
# any of them; only work committed during the session may not be.
intent_guard_fallback_ref() {
  local root="$1"
  local ref
  if ref="$(git -C "$root" rev-parse --verify --quiet '@{upstream}^{commit}' 2>/dev/null)"; then
    printf '%s' "$ref"
  elif ref="$(git -C "$root" rev-parse --verify --quiet 'HEAD^{commit}')"; then
    printf '%s' "$ref"
  else
    intent_guard_empty_tree "$root"
  fi
}

# Prints the ref to diff against, and returns:
#   0  the session baseline (or a full stand-in for it), judged as is;
#   3  a FALLBACK ref (intent_guard_fallback_ref), reason on stderr: the
#      recorded baseline is unusable, or there is no record and nothing to
#      stand in for it. The Stop check still judges everything the fallback
#      can see, and a finding there blocks; only if that passes does it report
#      that the committed part could not be judged;
#   1  nothing usable at all, reason on stderr.
intent_guard_baseline_ref() {
  local root="$1"
  local file ref

  if file="$(intent_guard_baseline_file "$root")" && [[ -f "$file" ]]; then
    ref="$(sed -n '1p' "$file")"
    if intent_guard_baseline_valid "$root" "$ref"; then
      printf '%s' "$ref"
      return 0
    fi
    echo "Intent Guard: the session baseline record ($file) is not a commit that is an ancestor of HEAD (or the empty tree); it was altered or history was rewritten. Refusing to judge against it, so work committed during this session cannot be judged in full; staged, unstaged and untracked changes are still collected for the gate. Delete it and start a new session." >&2
    intent_guard_fallback_ref "$root" || return 1
    return 3
  fi

  # No record (SessionStart was not wired, or did not run). A repository with no
  # commit yet has an obvious baseline: the empty tree.
  if ! git -C "$root" rev-parse --verify --quiet 'HEAD^{commit}' >/dev/null; then
    intent_guard_empty_tree "$root"
    return 0
  fi

  # The upstream branch stands in for it when there is one, so commits not yet
  # pushed are still judged.
  if ref="$(git -C "$root" rev-parse --verify --quiet '@{upstream}^{commit}' 2>/dev/null)"; then
    echo "Intent Guard: no session-start record; judging changes since the upstream branch." >&2
    printf '%s' "$ref"
    return 0
  fi

  if [[ "${INTENT_GUARD_NO_BASELINE_OK:-}" == "1" ]]; then
    echo "Intent Guard: no session-start record and no upstream; INTENT_GUARD_NO_BASELINE_OK=1 is set, so only uncommitted and untracked changes are judged. Work committed during this session cannot be seen." >&2
    git -C "$root" rev-parse --verify --quiet 'HEAD^{commit}'
    return 0
  fi

  echo "Intent Guard: no session-start record and no upstream branch, so work committed during this session cannot be seen; staged, unstaged and untracked changes are still collected for the gate. Wire conductor-session-start.sh as the SessionStart hook and start a new session, or set INTENT_GUARD_NO_BASELINE_OK=1 to judge only uncommitted and untracked changes." >&2
  intent_guard_fallback_ref "$root" || return 1
  return 3
}

# Appends the NUL-separated output of one git command to a file, or fails.
intent_guard_collect() {
  local out="$1"
  local root="$2"
  shift 2
  if ! git -C "$root" -c core.quotePath=false "$@" >>"$out"; then
    echo "Intent Guard: git failed while listing changed paths (git $*); refusing to treat the change as empty." >&2
    return 1
  fi
}

# ---------------------------------------------------------------------------
# What the Stop check hands the gate
#
# Three channels, so that as little as possible crosses the command line:
# - committed work since the baseline goes through the gate's own --base, and
# - staged work through its own --staged. The gate reads both from git with -z,
#   so no file name, and no number of them, can stop them reaching it.
# - Only what git cannot hand the gate itself, edits not yet staged and
#   untracked files, goes on the command line as --paths.
#
# A --paths entry that cannot be passed faithfully is not dropped and is not a
# reason to stop judging: it is reported back, the rest is judged, and the Stop
# check blocks on it every time. The agent can always clear it, because
# "git add" moves the file to the --staged channel.

# Why a path cannot go into --paths, printed, or a non-zero return when it can.
#
# Classified under LC_ALL=C, byte by byte. In a Shift-JIS locale bash reads the
# byte pair 0x95 0x5C as one character and misses the backslash, while the
# gate (node, which decodes its arguments as UTF-8) sees a backslash and
# refuses the whole run.
#
# Sets INTENT_GUARD_PATH_REASON rather than printing, so the per-path loop
# below needs no subshell; intent_guard_path_issue is the printing form.
intent_guard_path_reason() {
  local LC_ALL=C
  local path="$1"
  INTENT_GUARD_PATH_REASON=""
  if [[ "$path" == */ ]]; then
    INTENT_GUARD_PATH_REASON='it is an untracked directory that holds its own git repository, so git lists the directory and none of the files inside it'
  elif [[ "$path" == *,* ]]; then
    INTENT_GUARD_PATH_REASON='it contains a comma, and --paths is comma-separated'
  elif [[ "$path" == *\\* ]]; then
    INTENT_GUARD_PATH_REASON='it contains a backslash, which intent-guard-check refuses in --paths'
  fi
  [[ -n "$INTENT_GUARD_PATH_REASON" ]]
}

intent_guard_path_issue() {
  intent_guard_path_reason "$1" || return 1
  printf '%s' "$INTENT_GUARD_PATH_REASON"
}

# Reads the NUL-separated paths on stdin. Writes each one that cannot be passed
# to $1 as "path NUL reason NUL" and each one that can, as "./path", to $2.
# Sets INTENT_GUARD_PASSABLE_COUNT and INTENT_GUARD_PASSABLE_BYTES (the length
# the comma-joined list will have). Under LC_ALL=C so lengths are in bytes.
intent_guard_classify_paths() {
  local LC_ALL=C
  local issues_out="$1"
  local passable_out="$2"
  local path
  INTENT_GUARD_PASSABLE_COUNT=0
  INTENT_GUARD_PASSABLE_BYTES=0
  while IFS= read -r -d '' path; do
    [[ -n "$path" ]] || continue
    if intent_guard_path_reason "$path"; then
      printf '%s\0%s\0' "$path" "$INTENT_GUARD_PATH_REASON" >>"$issues_out"
      continue
    fi
    # "./" keeps a name that starts with "-" from being read as a flag by the
    # CLI's argument parser (which would block every stop with a usage screen);
    # the budget matcher strips one leading "./".
    printf '%s\0' "./$path" >>"$passable_out"
    INTENT_GUARD_PASSABLE_COUNT=$((INTENT_GUARD_PASSABLE_COUNT + 1))
    INTENT_GUARD_PASSABLE_BYTES=$((INTENT_GUARD_PASSABLE_BYTES + ${#path} + 3))
  done
}

# Appends "--paths LIST" to $2 for the NUL-separated entries in $1, as many
# times as needed to keep each LIST under INTENT_GUARD_PATHS_CHUNK_BYTES.
intent_guard_write_paths_args() {
  local LC_ALL=C
  local passable="$1"
  local args_out="$2"
  local entry chunk="" chunk_bytes=0
  while IFS= read -r -d '' entry; do
    if [[ -n "$chunk" ]] && ((chunk_bytes + 1 + ${#entry} > INTENT_GUARD_PATHS_CHUNK_BYTES)); then
      printf '%s\0' --paths "$chunk" >>"$args_out"
      chunk=""
      chunk_bytes=0
    fi
    if [[ -z "$chunk" ]]; then
      chunk="$entry"
      chunk_bytes=${#entry}
    else
      chunk="$chunk,$entry"
      chunk_bytes=$((chunk_bytes + 1 + ${#entry}))
    fi
  done <"$passable"
  if [[ -n "$chunk" ]]; then
    printf '%s\0' --paths "$chunk" >>"$args_out"
  fi
}

# Prints the NUL-separated sorted list in $1 minus the one in $2. Both files
# must come from "LC_ALL=C sort -zu"; the comparison here is in the same byte
# order. A merge walk rather than a lookup table, because bash 3.2 (the macOS
# system bash) has no associative arrays.
intent_guard_subtract_sorted() {
  local LC_ALL=C
  local a b more_b=1
  {
    IFS= read -r -d '' -u 3 b || more_b=0
    while IFS= read -r -d '' a; do
      while [[ "$more_b" -eq 1 && "$b" < "$a" ]]; do
        IFS= read -r -d '' -u 3 b || more_b=0
      done
      if [[ "$more_b" -eq 1 && "$b" == "$a" ]]; then
        continue
      fi
      printf '%s\0' "$a"
    done <"$1"
  } 3<"$2"
}

# One --paths argument stays under this many bytes. Linux caps a SINGLE
# argument at 128 KiB (MAX_ARG_STRLEN), whatever the total limit is.
INTENT_GUARD_PATHS_CHUNK_BYTES=98304

# The whole --paths list stays under this many bytes, and under half of what
# the system leaves for arguments after the environment, whichever is smaller.
INTENT_GUARD_PATHS_TOTAL_BYTES=262144

intent_guard_paths_budget() {
  local budget="$INTENT_GUARD_PATHS_TOTAL_BYTES"
  local arg_max env_bytes room
  arg_max="$(getconf ARG_MAX 2>/dev/null || true)"
  if [[ "$arg_max" =~ ^[0-9]+$ ]]; then
    env_bytes="$(env | wc -c | tr -d ' ')"
    room=$(((arg_max - env_bytes) / 2))
    if ((room < budget)); then
      budget="$room"
    fi
  fi
  printf '%s' "$budget"
}

# Writes the gate's arguments for this stop to $2 and every path that cannot be
# passed to $3, both NUL-separated; $3 holds "path NUL reason NUL" records, and
# an empty path stands for the whole list being too long. Returns 1, with the
# reason on stderr, when the change cannot be collected at all; an empty list
# is never the answer to a git failure, because an empty list passes. Returns 3
# when everything was collected against a fallback ref (see
# intent_guard_baseline_ref), so work committed during the session may not be.
intent_guard_gate_args() {
  local root="$1"
  local args_out="$2"
  local issues_out="$3"
  local base empty candidates covered sorted_candidates sorted_covered passable
  local result=0
  # 1 when every changed path, committed and staged ones included, goes
  # through --paths (the empty-tree baseline). Read by the Stop check, because
  # there a path that cannot be passed is not one git add can move elsewhere.
  INTENT_GUARD_ALL_IN_PATHS=0

  if base="$(intent_guard_baseline_ref "$root")"; then
    :
  else
    result=$?
    if [[ "$result" -ne 3 ]]; then
      echo "Intent Guard: cannot determine the session baseline." >&2
      return 1
    fi
  fi
  empty="$(intent_guard_empty_tree "$root")" || return 1

  candidates="$(mktemp)" || {
    echo "Intent Guard: cannot create a temp file to list changed paths." >&2
    return 1
  }
  covered="$(mktemp)" || {
    rm -f "$candidates"
    echo "Intent Guard: cannot create a temp file to list changed paths." >&2
    return 1
  }

  # The trailing "--" ends the revisions: without it a file named exactly like
  # the baseline commit id makes git refuse with "ambiguous argument".
  #
  # --ignore-submodules: `ignore = all` for a submodule, in .gitmodules or in
  # git config, hides a moved submodule pointer from a plain diff, and the
  # command-line value overrides both. "none" for every comparison of commits
  # and the index. "untracked" for the work tree, which still lists a moved
  # pointer and an edit to a tracked file inside a submodule's checkout, but
  # not untracked build output in there, which would otherwise block every
  # stop for as long as it exists.
  if [[ "$base" == "$empty" ]]; then
    # The gate's --base takes a three-dot range, which git refuses for the
    # empty tree ("Invalid symmetric difference expression"). With nothing
    # committed to compare against, every path goes through --paths.
    INTENT_GUARD_ALL_IN_PATHS=1
    if ! {
      intent_guard_collect "$candidates" "$root" diff --no-renames --ignore-submodules=untracked --name-only -z "$base" -- &&
        intent_guard_collect "$candidates" "$root" diff --cached --no-renames --ignore-submodules=none --name-only -z "$base" -- &&
        intent_guard_collect "$candidates" "$root" ls-files --others --exclude-standard -z
    }; then
      rm -f "$candidates" "$covered"
      return 1
    fi
  else
    printf '%s\0' --base "$base" --staged >>"$args_out"
    # What --base and --staged will already carry, so it is not counted twice
    # against max_files. The same two listings the gate makes.
    if ! {
      intent_guard_collect "$covered" "$root" diff --no-renames --ignore-submodules=none --name-only -z "$base...HEAD" -- &&
        intent_guard_collect "$covered" "$root" diff --cached --no-renames --ignore-submodules=none --name-only -z -- &&
        intent_guard_collect "$candidates" "$root" diff --no-renames --ignore-submodules=untracked --name-only -z -- &&
        intent_guard_collect "$candidates" "$root" ls-files --others --exclude-standard -z
    }; then
      rm -f "$candidates" "$covered"
      return 1
    fi
  fi

  sorted_candidates=""
  sorted_covered=""
  if ! { sorted_candidates="$(mktemp)" && sorted_covered="$(mktemp)" && passable="$(mktemp)"; }; then
    rm -f "$candidates" "$covered" "$sorted_candidates" "$sorted_covered"
    echo "Intent Guard: cannot create a temp file to list changed paths." >&2
    return 1
  fi
  # Checked: a sort that fails leaves an empty list, and an empty list passes.
  if ! {
    LC_ALL=C sort -zu "$candidates" >"$sorted_candidates" &&
      LC_ALL=C sort -zu "$covered" >"$sorted_covered"
  }; then
    rm -f "$candidates" "$covered" "$sorted_candidates" "$sorted_covered" "$passable"
    echo "Intent Guard: sort failed while listing changed paths; refusing to treat the change as empty." >&2
    return 1
  fi
  rm -f "$candidates" "$covered"

  intent_guard_classify_paths "$issues_out" "$passable" \
    < <(intent_guard_subtract_sorted "$sorted_candidates" "$sorted_covered")
  rm -f "$sorted_candidates" "$sorted_covered"

  if ((INTENT_GUARD_PASSABLE_BYTES > $(intent_guard_paths_budget))); then
    local kind="unstaged and untracked"
    if [[ "$INTENT_GUARD_ALL_IN_PATHS" -eq 1 ]]; then
      kind="changed"
    fi
    printf '%s\0%s\0' "" "the $INTENT_GUARD_PASSABLE_COUNT $kind paths ($INTENT_GUARD_PASSABLE_BYTES bytes) are too many to pass to the gate on the command line" >>"$issues_out"
    rm -f "$passable"
    return "$result"
  fi

  intent_guard_write_paths_args "$passable" "$args_out"
  rm -f "$passable"
  return "$result"
}
