# Codex Hook Adapter

Codex supports project-local hooks in `.codex/hooks.json` or inline `[hooks]`
tables in `.codex/config.toml` when the project `.codex/` layer is trusted.

## Install

```bash
mkdir -p .codex
cp integrations/codex/hooks.json.sample .codex/hooks.json
chmod +x integrations/hooks/*.sh
```

Then start Codex in the project and review/trust the hooks with `/hooks`.

## What It Does

- `SessionStart` on `startup|resume|compact`: runs
  `integrations/hooks/conductor-session-start.sh`, which prints the current
  `intent-guard-resume` brief when an active contract exists.
- `Stop`: runs `integrations/hooks/conductor-stop-check.sh`, which invokes
  `intent-guard-check` against changed paths and exits **2** when the gate is
  blocked. Codex reads that exit-2 reason from stderr and continues the agent
  with it, and it treats plain text on a Stop hook's stdout at exit 0 as
  invalid, so the script keeps the check's output on stderr and leaves stdout
  empty whether the gate passes or blocks. Claude Code reads the same exit 2 as
  preventing the stop. Git pre-commit is unaffected: it runs
  `intent-guard-check` directly, where exit 1 blocks the commit.

## Source Notes

The current Codex manual documents hooks in `hooks.json`, project `.codex/`
trust, `SessionStart` matchers such as `startup`, `resume`, `compact`, and
`Stop` hooks. It also recommends resolving repo-local hook scripts from the git
root instead of relying on the process working directory.
