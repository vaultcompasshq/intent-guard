# Claude Code Hook Adapter

Claude Code supports project hooks in `.claude/settings.json`. Command hooks
receive event JSON on stdin. For **Stop**, Claude Code hard-blocks only on
**exit code 2** (exit 1 is a non-blocking error). Intent Guard's
`conductor-stop-check.sh` maps a blocked gate to exit 2 for that reason. The
hook script file names still say `conductor` because they are referenced from
users' own `.claude/settings.json`; the commands they run are `intent-guard-*`.

## Install

```bash
mkdir -p .claude
cp integrations/claude-code/settings.sample.json .claude/settings.json
chmod +x integrations/hooks/*.sh
# Mechanical gate (shared with Cursor): also install the Git pre-commit hook
npx @vaultcompass/intent-guard@latest hook install --project .
```

The lifecycle samples resume/brief and stop-check; the **blocking** gate is
`intent-guard-check` via `integrations/hooks/conductor-stop-check.sh`.

Prove the path locally:

```bash
pnpm dogfood:claude-hooks
# or: node scripts/dogfood-claude-hooks.mjs   # after pnpm build
```

This path and the Cursor one were both exercised against real sessions before
release; the hooks share the same mechanical gate.

## What It Does

- `SessionStart` on `startup|resume`: runs `conductor-session-start.sh` and
  prints the current `intent-guard-resume` brief when available.
- `Stop`: runs `conductor-stop-check.sh`; if `intent-guard-check` blocks, the
  script exits **2** so Claude Code treats it as a blocking Stop (not a
  non-blocking exit 1).

**Hard enforcement** for commits is still `intent-guard hook install` (Git
pre-commit). Lifecycle Stop is best-effort host wiring on top of the same gate.

## Source Notes

Claude Code documents project hooks in `.claude/settings.json`, `SessionStart`
and `Stop` lifecycle events, command hooks, `${CLAUDE_PROJECT_DIR}` for project
paths, and `timeout` in seconds. Stop policy hooks should use exit code **2**
to block ending the turn.
