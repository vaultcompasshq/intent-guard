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
# The in-repo build (packages/skill/dist) is trusted ONLY when the repository is
# Intent Guard's own: its root package.json names the package "intent-guard".
# Anywhere else that directory is just a path an agent can write to, and dist is
# normally gitignored, so a planted file there never shows in a diff and the
# hook would run the agent's own judge. Every other repository gets the
# installed binary from PATH.
intent_guard_is_own_repo() {
  local root="$1"
  [[ -f "$root/package.json" ]] || return 1
  grep -Eq '^[[:space:]]*"name"[[:space:]]*:[[:space:]]*"intent-guard"[[:space:]]*,?[[:space:]]*$' \
    "$root/package.json"
}

intent_guard_bin() {
  local root="$1"
  local name="$2"
  local dist="$root/packages/skill/dist/${name#intent-guard-}-cli.js"

  if intent_guard_is_own_repo "$root" && [[ -f "$dist" ]]; then
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

# Called by SessionStart. A resume fires SessionStart again mid-session, and
# resetting the baseline there would let an agent commit, resume, and have the
# commit forgotten. So an existing baseline is kept while it is still an
# ancestor of HEAD and was taken under the same contract id; a new contract or a
# rewritten history starts a fresh baseline.
intent_guard_record_session_start() {
  local root="$1"
  local file head cid old_ref old_cid

  file="$(intent_guard_baseline_file "$root")" || return 1
  if head="$(git -C "$root" rev-parse --verify --quiet 'HEAD^{commit}')"; then
    :
  else
    head="$(intent_guard_empty_tree "$root")" || return 1
  fi
  cid="$(intent_guard_contract_id "$root")"

  if [[ -f "$file" ]]; then
    old_ref="$(sed -n '1p' "$file")"
    old_cid="$(sed -n '2p' "$file")"
    if [[ -n "$old_ref" && "$old_cid" == "$cid" ]]; then
      if [[ "$old_ref" == "$head" ]] \
        || git -C "$root" merge-base --is-ancestor "$old_ref" "$head" 2>/dev/null; then
        return 0
      fi
    fi
  fi

  printf '%s\n%s\n' "$head" "$cid" >"$file"
}

# Prints the ref to diff against, and says on stderr which fallback was used.
intent_guard_baseline_ref() {
  local root="$1"
  local file ref

  if file="$(intent_guard_baseline_file "$root")" && [[ -f "$file" ]]; then
    ref="$(sed -n '1p' "$file")"
    if [[ -n "$ref" ]] && git -C "$root" cat-file -e "${ref}^{tree}" 2>/dev/null; then
      printf '%s' "$ref"
      return 0
    fi
  fi

  # No usable record (SessionStart was not wired, or did not run). Fall back to
  # the upstream branch when there is one, so commits not yet pushed are still
  # judged, and otherwise to HEAD, which sees only uncommitted and untracked work.
  if ref="$(git -C "$root" rev-parse --verify --quiet '@{upstream}^{commit}')"; then
    echo "Intent Guard: no session-start record; judging changes since the upstream branch." >&2
    printf '%s' "$ref"
    return 0
  fi
  if ref="$(git -C "$root" rev-parse --verify --quiet 'HEAD^{commit}')"; then
    echo "Intent Guard: no session-start record and no upstream; work committed during this session cannot be seen, only uncommitted and untracked changes are judged." >&2
    printf '%s' "$ref"
    return 0
  fi
  intent_guard_empty_tree "$root"
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
    paths+=("$path")
  done < <(LC_ALL=C sort -zu "$tmp")
  rm -f "$tmp"

  if [[ "${#paths[@]}" -eq 0 ]]; then
    return 0
  fi

  local IFS=,
  printf '%s' "${paths[*]}"
}
