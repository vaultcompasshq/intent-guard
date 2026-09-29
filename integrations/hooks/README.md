# Intent Guard Hook Adapters

These examples wire Intent Guard into agent lifecycle hooks so intent checks
happen without relying on the agent to remember a markdown instruction.

## Shared Scripts

| Script | Purpose |
|--------|---------|
| `conductor-session-start.sh` | Prints `intent-guard-resume` output when an active contract exists |
| `conductor-stop-check.sh` | Runs `intent-guard-check` against changed paths; reports on stderr and exits **2** on a blocked gate |

The file names still say `conductor`. They are referenced by paths inside users'
own `.claude/settings.json` and `.codex/hooks.json`, so renaming them would break
every project that already wired them up. The commands they invoke are the new
`intent-guard-*` binaries.

Binary resolution: the scripts use the built CLI files under
`packages/skill/dist/` only when the repository is Intent Guard's own (its root
`package.json` names the package `intent-guard`). In every other repository
they use `intent-guard-resume` / `intent-guard-check` from `PATH`. `dist/` is
normally gitignored, so a file planted there never shows in a diff, and
trusting it anywhere would let the agent run its own judge.

## Install

From a project that has Intent Guard available:

```bash
pnpm build
chmod +x integrations/hooks/*.sh
```

Then copy the relevant sample config from `integrations/codex/`,
`integrations/claude-code/`, or `integrations/cursor/`.

## Behavior

- Session-start hooks are best effort. They do not block if no active contract
  exists, because new projects need to bootstrap with `intent-guard-extract`.
  Their stdout is deliberately left alone: both hosts read SessionStart stdout
  as session context, which is exactly what the brief is for.
- Stop hooks fail closed when `intent-guard-check` is unavailable or returns a
  blocking result: they exit **2**, not 1. Claude Code treats exit 1 as
  non-blocking on Stop, and exit 2 as preventing the stop, so the conversation
  continues. Codex reads the exit-2 reason from stderr and continues the agent
  with it, and it treats plain text on a Stop hook's stdout at exit 0 as
  invalid. The Stop adapter therefore sends everything `intent-guard-check`
  prints to stderr and leaves stdout empty on every path, pass or block. Git
  pre-commit still uses `intent-guard-check` directly, where exit 1 is the
  blocking code.
- The Stop check judges everything that changed since the session began, not
  only the working-tree diff: commits made during the session, staged and
  unstaged edits, and untracked new files. `conductor-session-start.sh` records
  `HEAD` (or the empty tree in a repository with no commit) in a file under the
  git directory, never in the tracked tree. A second SessionStart, as on a
  resume, keeps the earlier record while it is still an ancestor of `HEAD` and
  was taken under the same `contract_id`; a new contract or rewritten history
  starts a fresh one. With no record (SessionStart not wired), the check falls
  back to the upstream branch if there is one, otherwise to `HEAD`, and says on
  stderr that committed work cannot be seen. Wire SessionStart.
- Paths are read NUL-separated with `core.quotePath=false`, so names with
  quotes, backslashes, tabs or non-ASCII characters reach the budget literally.
  A git failure blocks the stop (exit 2, reason on stderr) instead of yielding
  an empty list, which would pass. `--paths` is comma-separated, so a changed
  path containing a comma cannot be passed faithfully; the hook refuses it and
  asks for a rename rather than guessing.
- Cursor has no committed lifecycle hook config here; use the project rule plus
  the Git pre-commit hook for enforcement.
