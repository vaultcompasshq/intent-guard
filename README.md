# Intent Guard

**Approved Intent Contract + drift gate for AI-assisted development.**

> **Renamed in 1.2.0.** This project shipped as **Conductor** through 1.1.0. The
> npm packages are now `@vaultcompass/intent-guard`,
> `@vaultcompass/intent-guard-core`, `@vaultcompass/intent-guard-schema`, and
> `@vaultcompass/intent-guard-skill`; the binary is `intent-guard`, and the
> per-command binaries are `intent-guard-check`, `intent-guard-report`, and so
> on. The old binary names are gone in this release, so a pre-commit hook or
> agent hook that still calls `conductor-check` needs updating: re-run
> `intent-guard hook install`. Project state is untouched, so `.conductor/` and
> everything in it keeps working as-is. See [the upgrade
> notes](#upgrading-from-conductor-110).

Intent Guard turns an unstructured request into a frozen **Intent Contract**, then
blocks scope drift in pre-commit and CI before misaligned changes reach review.
It complements Spec Kit, Kiro, Cursor, Claude Code, Codex, and CodeRabbit; it
does not replace planning, coding agents, or PR review.

The contract is plain YAML any model can read. Pair with
[vault-guard](https://www.npmjs.com/package/@vaultcompass/vault-guard) when you
also want secret scanning as a separate gate. See [integrations/](./integrations).

```
User conversation
        |
   Intent Guard layer    intent contract, drift guard, prompt coach
        |
   Coding assistants     planning, TDD, build, review
        |
   Shipped product
```

## Status

**Version:** `1.2.0` — stable CLI/API on npm (`@vaultcompass/intent-guard*`); see [docs/release/stability-policy.md](./docs/release/stability-policy.md)  
**Repository:** https://github.com/vaultcompasshq/intent-guard (public, MIT)

**Packages:** `packages/schema` · `packages/core` · `packages/skill` · `packages/cli` (see [docs/NEXT.md](./docs/NEXT.md))

**Maintainers:** [docs/NEXT.md](./docs/NEXT.md) · [docs/TODO.md](./docs/TODO.md) · [docs/cli-reference.md](./docs/cli-reference.md)

## Start here

| Doc | Purpose |
|-----|---------|
| [AGENTS.md](./AGENTS.md) | Agent rules, phase status, verification |
| [docs/NEXT.md](./docs/NEXT.md) | Maintainer status and next work |
| [docs/product-positioning.md](./docs/product-positioning.md) | Competitive positioning and next product bets |
| [BRAINSTORMING.md](./BRAINSTORMING.md) | Design-session index |
| [docs/repo-strategy.md](./docs/repo-strategy.md) | Public scope, licensing, org placement |
| [docs/superpowers/specs/2026-06-17-conductor-design.md](./docs/superpowers/specs/2026-06-17-conductor-design.md) | Approved design spec (review gate) |
| [docs/release/v1-launch-checklist.md](./docs/release/v1-launch-checklist.md) | Beta → v1.0.0 launch gate |
| [docs/release/stability-policy.md](./docs/release/stability-policy.md) | Schema and package semver policy |
| [docs/superpowers/plans/2026-06-17-conductor-phase1.md](./docs/superpowers/plans/2026-06-17-conductor-phase1.md) | Phase 1 plan (complete) |

## What Intent Guard is / isn't

| Is | Isn't |
|----|-------|
| Governance layer for AI coding sessions | A foundation model or fine-tune |
| Intent Contract + drift detection | A full autonomous coding agent |
| User prompt coaching | Replacement for planning, review, or CI |
| Multi-model (Claude, Codex, Gemini) | Cursor-only or single-vendor lock-in |

## Packages

```
intent-guard/
├── packages/
│   ├── schema/          # @vaultcompass/intent-guard-schema
│   ├── core/            # @vaultcompass/intent-guard-core incl. history/index
│   ├── skill/           # Superpowers skills + per-command CLIs
│   ├── cli/             # unified intent-guard binary
│   └── memory/          # separate package deferred; file memory lives in core
├── integrations/
│   ├── superpowers/     # skills + install script
│   ├── git-hooks/       # pre-commit gate samples
│   ├── hooks/           # shared lifecycle hook scripts
│   ├── codex/           # Codex hooks.json sample
│   ├── claude-code/     # Claude Code settings sample
│   ├── github-actions/  # drift CI and optional vault-guard workflow samples
│   ├── cursor/          # Cursor rule + git hook setup
│   └── downstream-pipeline/  # design notes
└── docs/
```

The enforcement gate (`intent-guard check`, or `intent-guard-check`) returns a non-zero exit code when no
frozen contract exists or staged changes drift past a blocking threshold: the
one place Intent Guard *enforces* rather than *suggests*. Install it with
`intent-guard hook install` (add `--with-vault-guard` to pair secret scanning), or
wire the sample hooks
([pre-commit.sample](./integrations/git-hooks/pre-commit.sample),
[vault-guard hook](./integrations/git-hooks/pre-commit-with-vault-guard.sample))
or a CI step from a source checkout.

## Quickstart

### Install (npm)

```bash
npx @vaultcompass/intent-guard@latest init --project .
npx @vaultcompass/intent-guard@latest extract --project . --text "Add CSV export. Do not add new API endpoints."
npx @vaultcompass/intent-guard@latest freeze --project . --approved-by "<you>"
npx @vaultcompass/intent-guard@latest check --project . --staged
```

Install the pre-commit gate (and optionally pair [vault-guard](https://www.npmjs.com/package/@vaultcompass/vault-guard) secret scanning):

```bash
npx @vaultcompass/intent-guard@latest hook install --project . --with-vault-guard
```

This writes a self-contained `.git/hooks/pre-commit`; drop `--with-vault-guard` for intent-only enforcement.

### AI session guardrails

Intent Guard and vault-guard are independent gates for the same workflow:

| Gate | Tool | Blocks |
|------|------|--------|
| Intent drift | `intent-guard check --staged` | Work outside the approved contract |
| Secret leakage | `vault-guard scan --staged` | Credentials in staged files |

Use `intent-guard doctor` to verify setup, `intent-guard report --staged` for PR/agent handoffs, and `intent-guard report --staged --with-secrets` when vault-guard is installed.

### Develop from source

```bash
pnpm install
pnpm build
pnpm intent-guard --init --project .
pnpm intent-guard --doctor --project .
pnpm intent-guard --extract --project . --text "Add CSV export. Do not add new API endpoints. Verify the file downloads."
pnpm intent-guard --import-spec --project . --from kiro --spec-dir .kiro/specs/export
pnpm intent-guard --freeze --project . --approved-by "<name>"
pnpm intent-guard --check --project . --staged
pnpm intent-guard --report --project . --staged
pnpm intent-guard --rules audit --project .
```

## Development

```bash
pnpm install
pnpm test      # 180 tests (builds first, then schema + core + skill + cli + examples/integrations)
pnpm dogfood:cursor-hooks   # Cursor rule + hook install pass/fail fixture
pnpm dogfood:claude-hooks   # Claude Code SessionStart/Stop lifecycle fixture
pnpm build
pnpm release:smoke
pnpm validate:public-repos
pnpm intent-guard:install-skills   # copy skills to ~/.cursor/skills
```

### Session lifecycle (CLIs)

```bash
pnpm intent-guard --extract --project . --text "the ask"   # 1. draft (unfrozen)
pnpm intent-guard --import-spec --project . --from auto     # optional spec import
pnpm intent-guard --freeze  --project . --approved-by me    # 2. approve
pnpm intent-guard --doctor  --project .                     # 3. diagnose setup
pnpm intent-guard --check   --project . --staged            # 4. gate (exit 1 = blocked)
pnpm intent-guard --report  --project . --staged            # PR/CI handoff
pnpm intent-guard --rules   audit --project .               # project-rule hygiene
pnpm intent-guard --pivot   --project . --change "..." --acknowledge
pnpm intent-guard --correct --project . --wrong "..." --right "..." --rule "..." --acknowledge
pnpm intent-guard --brief   --project .                     # clean re-injectable context
pnpm intent-guard --resume  --project .                     # brief + recent history
```

Full flags: [docs/cli-reference.md](./docs/cli-reference.md). Release steps:
[docs/release/beta-release-checklist.md](./docs/release/beta-release-checklist.md).
The gate
(`intent-guard check`, or `intent-guard-check`) is the one place Intent Guard
*enforces* rather than *suggests*:
wire it via [integrations/git-hooks/pre-commit.sample](./integrations/git-hooks/pre-commit.sample)
or [integrations/github-actions/conductor-drift-ci.yml.sample](./integrations/github-actions/conductor-drift-ci.yml.sample).
Use [pre-commit-with-vault-guard.sample](./integrations/git-hooks/pre-commit-with-vault-guard.sample)
or [conductor-vault-guard-ci.yml.sample](./integrations/github-actions/conductor-vault-guard-ci.yml.sample)
when you want a separate secret-scanning gate beside Intent Guard.

## Upgrading from Conductor 1.1.0

1. Replace the dependency: `npm uninstall @vaultcompass/conductor-cli` then
   `npm install -D @vaultcompass/intent-guard`. Same for `-core`, `-schema`, and
   `-skill` if you depend on them directly.
2. Update import specifiers from `@vaultcompass/conductor-*` to
   `@vaultcompass/intent-guard-*`. The exported API is unchanged.
3. Re-run `intent-guard hook install --project .` so the generated pre-commit
   hook calls the new binary. The old hook calls `conductor-check`, which no
   longer exists, and the hook is fail-closed, so it will refuse commits until
   you do this. Add `--force` if the hook was hand-edited.
4. Update any CI step, agent hook, or script that calls `conductor` or a
   `conductor-*` binary.
5. Nothing under `.conductor/` changes. Contracts, config, history, and the
   drift log are all read from the same paths as before.

The name `conductor` may later be reused for a different package in this
family, so pin `@vaultcompass/intent-guard` rather than assuming the old name
still points at this tool.

## Origin

Intent Guard grew out of repeated intent-drift failures in AI-assisted development workflows: vague prompts expanded scope, long sessions lost the original request, and reviews caught implementation quality more reliably than direction. See [docs/brainstorming/01-context-and-problem.md](./docs/brainstorming/01-context-and-problem.md).

## License

MIT — see [LICENSE](./LICENSE)
