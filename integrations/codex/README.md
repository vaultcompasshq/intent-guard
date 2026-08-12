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
Project-local hooks load only when the project `.codex/` layer is trusted.

Hooks resolve `conductor-resume` / `conductor-check` (not the unified
`conductor` binary alone). Prefer PATH wrappers to a local
`packages/skill/dist` build, or install `@vaultcompass/conductor-skill` in
addition to `@vaultcompass/conductor-cli`.

## What It Does

- `SessionStart` on `startup|resume|compact`: runs
  `integrations/hooks/conductor-session-start.sh`, which prints the current
  `conductor-resume` brief when an active contract exists (plain stdout becomes
  session context).
- `Stop`: runs `integrations/hooks/conductor-stop-check.sh`, which invokes
  `conductor-check` against changed paths and exits **2** when the gate is
  blocked. On Codex, that continues the agent with the stderr reason — it is
  not Claude Code's hard-stop semantics.

## Source Notes

The current Codex manual documents hooks in `hooks.json`, project `.codex/`
trust, `SessionStart` matchers such as `startup`, `resume`, `compact`, and
`Stop` hooks. It also recommends resolving repo-local hook scripts from the git
root instead of relying on the process working directory.
