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

Binary resolution: the scripts use `intent-guard-resume` / `intent-guard-check`
from `PATH`, and nothing else, unless the operator sets `INTENT_GUARD_DEV_DIST=1`
in the hook's environment; then they use the built CLI files under
`packages/skill/dist/`, which is what developing Intent Guard itself needs.
Nothing inside the repository can turn that on. `dist/` is normally gitignored,
so a file planted there never shows in a diff, and any in-repo signal (a
`package.json` name, say) is one edit away for the agent, so only an environment
variable set by whoever launches the host is trusted.

**These hooks are a tripwire, not a boundary.** They run on the machine the
agent controls and the session baseline lives in a file the agent can write.
The enforcement boundary is CI running `intent-guard check --base <ref>
--trust-base <ref>` on the pull request. Use the hooks to stop honest mistakes
early, not to contain a hostile agent.

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
  git directory, never in the tracked tree. The `source` field of the JSON the
  host sends on stdin decides what a SessionStart does: `startup` and `clear`
  always record a fresh baseline (so a commit the human made between sessions is
  not judged against the next session), while `resume` and `compact` keep the
  existing one if it is still valid and was taken under the same `contract_id`.
  An absent or unknown `source` is treated as a continuation, which can only
  over-judge. The recorded value must be a full object id that is the empty
  tree or a commit that is an ancestor of `HEAD`; anything else (a tree, a name
  such as `HEAD`, an unrelated commit) blocks the stop with a message. With no
  record (SessionStart not wired) the check uses the upstream branch if there
  is one; with neither it fails closed with exit 2. The operator can set
  `INTENT_GUARD_NO_BASELINE_OK=1` to accept judging only uncommitted and
  untracked changes, with a warning that committed work cannot be seen. Wire
  SessionStart instead.
- Paths are read NUL-separated with `core.quotePath=false`, so names with
  quotes, backslashes, tabs or non-ASCII characters reach the budget literally.
  A git failure blocks the stop (exit 2, reason on stderr) instead of yielding
  an empty list, which would pass. `--paths` is comma-separated, so a changed
  path containing a comma cannot be passed faithfully; the hook refuses it and
  asks for a rename rather than guessing. Each path is passed as `./<path>` so a
  name starting with `-` is not read as a flag. A changed file whose name
  contains a backslash is refused by the CLI's explicit-path check (`--paths`
  refuses a backslash, a leading `/`, and `..`, `.` or empty segments) and so
  blocks the stop; rename it. `--staged` and `--base` read from git directly and
  accept such names.
- Cursor has no committed lifecycle hook config here; use the project rule plus
  the Git pre-commit hook for enforcement.
