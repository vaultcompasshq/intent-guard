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

intent_guard_bin() {
  local root="$1"
  local name="$2"
  local dist="$root/packages/skill/dist/${name#intent-guard-}-cli.js"

  if [[ -f "$dist" ]]; then
    printf 'node %q' "$dist"
    return 0
  fi

  if command -v "$name" >/dev/null 2>&1; then
    printf '%q' "$name"
    return 0
  fi

  return 1
}

intent_guard_changed_paths_csv() {
  local root="$1"
  local paths

  paths=$(
    {
      git -C "$root" diff --name-only --cached 2>/dev/null || true
      git -C "$root" diff --name-only 2>/dev/null || true
    } | awk 'NF && !seen[$0]++'
  )

  if [[ -z "$paths" ]]; then
    return 0
  fi

  # BSD paste (macOS) requires a file operand; "-" reads stdin.
  # Avoid bash here-strings (`<<<`), which BSD paste rejects.
  printf '%s\n' "$paths" | paste -sd, -
}
