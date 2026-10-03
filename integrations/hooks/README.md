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
- Loop policy. A FINDING always blocks, including when the host's stdin JSON
  says `stop_hook_active` is true, because the agent can fix it. Two things are
  findings: the gate exiting 1 (a budget violation or hard block), and, on the
  normal route, an unstaged or untracked path the hook cannot put on the
  command line (see below). A COULD-NOT-RUN condition is one the agent cannot
  fix: no gate binary, a git failure while collecting paths, the gate itself
  exiting 2 or 127, a session baseline that cannot be used, or, with the empty
  tree as the baseline, a path the hook cannot put on the command line (see
  below). It blocks the first time. When `stop_hook_active` is true it
  lets the stop through (exit 0) instead of looping forever, and says loudly
  what was not judged, why, that a human must fix it, and that CI
  `intent-guard check --base` is the enforcement boundary. The message goes to
  stderr and to stdout as `{"systemMessage": "..."}`, the Claude Code JSON
  field that shows the user a warning on a non-blocking exit; control
  characters in it are replaced with spaces so the object always parses. On a
  pass or a block stdout stays empty. Codex rendering of `systemMessage` is
  not confirmed, so stderr carries the same text. An absent, unparseable or
  false `stop_hook_active` means block.
- The Stop check judges everything that changed since the session began, not
  only the working-tree diff: commits made during the session, staged and
  unstaged edits, and untracked new files. `conductor-session-start.sh` records
  `HEAD` (or the empty tree in a repository with no commit) in a file under the
  git directory, never in the tracked tree. The `source` field of the JSON the
  host sends on stdin decides what a SessionStart does: `startup` and `clear`
  always record a fresh baseline (so a commit the human made between sessions is
  not judged against the next session). Any other `source`, or none, is a
  continuation: it never changes a record that exists, and writes one only when
  there is none. The shipped Claude Code sample runs SessionStart on `startup`
  and `resume`, so starting a new session is what records a fresh baseline
  there. The recorded value must be a full object id that is the empty tree or
  a commit that is an ancestor of `HEAD`. When it is not (a tree, a name such
  as `HEAD`, an unrelated commit, or history rewritten under it), or when there
  is no record and no upstream branch, the check still judges staged, unstaged
  and untracked changes against the upstream branch or `HEAD`, and a finding
  there blocks every time; only when that passes does it report, as
  could-not-run, that work committed during the session was not judged. With
  no record but an upstream branch, the upstream stands in for the baseline.
  The operator can set `INTENT_GUARD_NO_BASELINE_OK=1` to accept judging only
  uncommitted and untracked changes, with a warning that committed work cannot
  be seen. Wire SessionStart instead.
- How the change reaches the gate. Committed work since the baseline goes
  through the gate's own `--base`, and staged work through its own `--staged`;
  the gate reads both from git NUL-separated, so no file name and no number of
  files keeps them from it. Only unstaged edits and untracked files go on the
  command line as `--paths`, each as `./<path>` so a name starting with `-` is
  not read as a flag, without repeating anything the other two already carry,
  and split into arguments under 128 KiB. Some paths cannot be passed that
  way: one containing a comma (`--paths` is comma-separated) or a backslash
  (the CLI refuses one in `--paths`), an untracked directory holding its own
  git repository (git lists the directory, not the files in it), or more paths
  than fit on a command line. Each is named on stderr, and the rest of the
  change is still judged on that stop. Such an unstaged or untracked path
  blocks the stop every time; staged and committed files never take this
  route, since they reach the gate through `--staged` and `--base`. The comma
  and backslash test runs under `LC_ALL=C`, byte by byte, whatever the user's
  locale.
- When the session began before the repository's first commit, the baseline
  is the empty tree, which `--base` cannot take, so every changed path,
  committed and staged ones included, goes through `--paths`. A finding in
  what is passed still blocks every time. A path that cannot be passed is
  could-not-run on this route: it blocks the first time, and the message names
  the paths that were not judged and says that a new session started after
  the first commit restores full judging. A git failure blocks the stop (exit
  2, reason on stderr) instead of yielding an empty list, which would pass.
- Submodules. Every diff the hook or the gate makes passes
  `--ignore-submodules=none` (the hook's work-tree diff passes `untracked`),
  so `ignore = all` for a submodule, in `.gitmodules` or in git config, does
  not hide a moved submodule pointer or an edit to a tracked file inside its
  checkout; untracked build output inside a submodule does not block. The
  hooks also export `GIT_NO_REPLACE_OBJECTS=1` to their own git calls and to
  the gate they run. Revisions are ended with `--`, so a file named like the
  baseline commit id is read as a file.
- Cursor has no committed lifecycle hook config here; use the project rule plus
  the Git pre-commit hook for enforcement.
