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

The scripts first look for this repo's built CLI files under
`packages/skill/dist/`, then fall back to `intent-guard-resume` /
`intent-guard-check` on `PATH`.

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
- Cursor has no committed lifecycle hook config here; use the project rule plus
  the Git pre-commit hook for enforcement.
