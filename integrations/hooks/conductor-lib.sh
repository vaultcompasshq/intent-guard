#!/usr/bin/env bash
#
# Shared helpers for the Intent Guard lifecycle hook adapters.
#
# The file names in this directory still say "conductor". They are referenced by
# paths inside users' own .claude/settings.json and .codex/hooks.json, so
# renaming them would break every project that already wired them up. The
# commands they invoke are the new intent-guard-* binaries.

set -euo pipefail

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
# this session's contract. resume and compact continue a session, and resetting
# there would let an agent commit, compact, and have the commit forgotten, so
# they keep the existing baseline while it is still valid and was taken under
# the same contract id. An absent or unrecognised source is treated as a
# continuation, the cautious reading: it can over-judge, never under-judge.
intent_guard_record_session_start() {
  local root="$1"
  local source="${2:-}"
  local file head cid old_ref old_cid

  file="$(intent_guard_baseline_file "$root")" || return 1
  if head="$(git -C "$root" rev-parse --verify --quiet 'HEAD^{commit}')"; then
    :
  else
    head="$(intent_guard_empty_tree "$root")" || return 1
  fi
  cid="$(intent_guard_contract_id "$root")"

  case "$source" in
    startup | clear) ;;
    *)
      if [[ -f "$file" ]]; then
        old_ref="$(sed -n '1p' "$file")"
        old_cid="$(sed -n '2p' "$file")"
        if [[ "$old_cid" == "$cid" ]] && intent_guard_baseline_valid "$root" "$old_ref"; then
          return 0
        fi
      fi
      ;;
  esac

  printf '%s\n%s\n' "$head" "$cid" >"$file"
}

# Prints the ref to diff against. Fails closed (non-zero, reason on stderr) when
# the recorded baseline is unusable, and when there is no record and nothing to
# stand in for one, unless the operator sets INTENT_GUARD_NO_BASELINE_OK=1.
intent_guard_baseline_ref() {
  local root="$1"
  local file ref

  if file="$(intent_guard_baseline_file "$root")" && [[ -f "$file" ]]; then
    ref="$(sed -n '1p' "$file")"
    if intent_guard_baseline_valid "$root" "$ref"; then
      printf '%s' "$ref"
      return 0
    fi
    echo "Intent Guard: the session baseline record ($file) is not a commit that is an ancestor of HEAD (or the empty tree); it was altered or history was rewritten. Refusing to judge against it. Delete it and start a new session." >&2
    return 1
  fi

  # No record (SessionStart was not wired, or did not run). A repository with no
  # commit yet has an obvious baseline: the empty tree.
  if ! git -C "$root" rev-parse --verify --quiet 'HEAD^{commit}' >/dev/null; then
    intent_guard_empty_tree "$root"
    return 0
  fi

  # The upstream branch stands in for it when there is one, so commits not yet
  # pushed are still judged.
  if ref="$(git -C "$root" rev-parse --verify --quiet '@{upstream}^{commit}')"; then
    echo "Intent Guard: no session-start record; judging changes since the upstream branch." >&2
    printf '%s' "$ref"
    return 0
  fi

  if [[ "${INTENT_GUARD_NO_BASELINE_OK:-}" == "1" ]]; then
    echo "Intent Guard: no session-start record and no upstream; INTENT_GUARD_NO_BASELINE_OK=1 is set, so only uncommitted and untracked changes are judged. Work committed during this session cannot be seen." >&2
    git -C "$root" rev-parse --verify --quiet 'HEAD^{commit}'
    return 0
  fi

  echo "Intent Guard: no session-start record and no upstream branch, so work committed during this session cannot be seen. Wire conductor-session-start.sh as the SessionStart hook, or set INTENT_GUARD_NO_BASELINE_OK=1 to judge only uncommitted and untracked changes." >&2
  return 1
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

# Prints the changed paths as a comma-separated list, for --paths.
#
# Everything changed since the session began: commits since the baseline,
# staged and unstaged edits, and untracked files. Paths are read NUL-separated
# (-z) because git C-quotes any name with a quote, backslash, tab or newline
# otherwise. A git failure returns non-zero with a message rather than an empty
# list, because an empty list makes the gate pass. --paths splits on commas, so
# a path containing one cannot be passed faithfully and is refused instead.
intent_guard_changed_paths_csv() {
  local root="$1"
  local base tmp path
  local -a paths=()

  base="$(intent_guard_baseline_ref "$root")" || {
    echo "Intent Guard: cannot determine the session baseline." >&2
    return 1
  }

  tmp="$(mktemp)" || {
    echo "Intent Guard: cannot create a temp file to list changed paths." >&2
    return 1
  }

  if ! {
    intent_guard_collect "$tmp" "$root" diff --no-renames --name-only -z "$base" &&
      intent_guard_collect "$tmp" "$root" diff --cached --no-renames --name-only -z "$base" &&
      intent_guard_collect "$tmp" "$root" ls-files --others --exclude-standard -z
  }; then
    rm -f "$tmp"
    return 1
  fi

  while IFS= read -r -d '' path; do
    [[ -n "$path" ]] || continue
    if [[ "$path" == *,* ]]; then
      rm -f "$tmp"
      printf 'Intent Guard: cannot judge the path "%s": --paths is comma-separated and this path contains a comma. Rename it and stop again.\n' "$path" >&2
      return 1
    fi
    # "./" keeps a name that starts with "-" from being read as a flag by the
    # CLI's argument parser (which would block every stop with a usage screen);
    # the budget matcher strips one leading "./".
    paths+=("./$path")
  done < <(LC_ALL=C sort -zu "$tmp")
  rm -f "$tmp"

  if [[ "${#paths[@]}" -eq 0 ]]; then
    return 0
  fi

  local IFS=,
  printf '%s' "${paths[*]}"
}
