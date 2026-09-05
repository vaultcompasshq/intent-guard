# Intent Guard

Intent Guard freezes an approved request as a contract, then checks later
changes against it. What it reads is the set of paths a change touched: the
staged paths before a commit, or the paths a branch has changed since it
forked, together with any free-text signals and the latest user message the
caller chooses to pass in.

<!-- guardrails-family: shared block, keep it identical in dep-guard, vault-guard, intent-guard and conductor -->
The Vault & Compass guardrails are three gates over an AI-assisted coding
session: [dep-guard](https://www.npmjs.com/package/@vaultcompass/dep-guard)
checks what comes in (hallucinated package names, typosquats, tampered
lockfile entries),
[vault-guard](https://www.npmjs.com/package/@vaultcompass/vault-guard) checks
what goes out (credentials about to be committed), and
[intent-guard](https://www.npmjs.com/package/@vaultcompass/intent-guard)
checks the change against what was approved (drift from a frozen intent
contract, and change budgets). Each one installs, configures and runs on its
own;
[conductor](https://www.npmjs.com/package/@vaultcompass/conductor) is the
optional umbrella that runs them from one policy file, one hook and one
report.
<!-- /guardrails-family -->

The package is **`@vaultcompass/intent-guard`**, and it installs as
`npm install --save-dev @vaultcompass/intent-guard` (or
`pnpm add -D @vaultcompass/intent-guard`). An unrelated package named
`intentguard` also exists on npm; it is a different project and has nothing to
do with this one, so install the scoped name.

> **Renamed in 1.2.0.** This project shipped as **Conductor** through 1.1.0. The
> npm packages are now `@vaultcompass/intent-guard`,
> `@vaultcompass/intent-guard-core`, `@vaultcompass/intent-guard-schema`, and
> `@vaultcompass/intent-guard-skill`; the binary is `intent-guard`, and the
> per-command binaries are `intent-guard-check`, `intent-guard-report`, and so
> on. The old binary names are gone in this release, so a pre-commit hook or
> agent hook that still calls `conductor-check` needs updating: re-run
> `intent-guard hook install`. See [the upgrade
> notes](#upgrading-from-conductor-110).

> **State directory renamed in 1.3.0.** Per-project state now lives in
> `.intent-guard/`, not `.conductor/`. The old name belongs to a different
> product in this family, which writes `.guardrails.yaml` and `.guardrails/`
> into the same repositories, and two similarly named directories from two
> tools is a trap. An existing `.conductor/` is read as-is with a notice, and
> renamed to `.intent-guard/` on the first write. If both directories exist,
> every command fails closed rather than guessing which one is current.

Two kinds of finding come out of the gate. The first is drift: the change has
moved outside what the contract put in scope, into something it put out of
scope, or across a constraint the contract recorded. The second is the change
budget, an optional block on the contract that is evaluated from paths alone,
offline and without a model: a path matching `protected_paths` is a hard
block, and a path outside `allowed_paths`, a changed-file count over
`max_files`, or an edit to a manifest or lockfile when
`allow_new_dependencies` is false are soft blocks. A missing or unapproved
contract fails too, because a gate with nothing to check against is not a
gate that passed.

What it does not do is read the diff. It sees which files a change touched,
never what changed inside them, so work that stays within the approved paths
and does something the contract never sanctioned reads as clean. That is the
real gap in this design. The `--signals` and `--message` flags soften it
rather than close it: they are free text supplied by whatever is calling the
gate, so they are only as honest as the caller. Intent Guard does not plan,
write code, or review it either. `intent-guard import-spec` imports Spec Kit,
Kiro, and superpowers artifacts as a draft contract, and the contract itself
is plain YAML any model can read. See [integrations/](./integrations).

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

**Version:** `1.3.0`: stable CLI/API on npm (`@vaultcompass/intent-guard*`); see [docs/release/stability-policy.md](./docs/release/stability-policy.md)  
**Repository:** https://github.com/vaultcompasshq/intent-guard (public, MIT)

**Packages:** `packages/schema` · `packages/core` · `packages/skill` · `packages/cli`

## Start here

| Doc | Purpose |
|-----|---------|
| [docs/cli-reference.md](./docs/cli-reference.md) | Every command and flag |
| [docs/schemas/intent-contract.example.md](./docs/schemas/intent-contract.example.md) | What a contract looks like |
| [docs/schemas/directory-layout.md](./docs/schemas/directory-layout.md) | What the tool writes, and where |
| [integrations/](./integrations) | Hooks for Claude Code, Cursor, Codex, and CI |
| [docs/release/stability-policy.md](./docs/release/stability-policy.md) | What a version number promises |
| [AGENTS.md](./AGENTS.md) | Rules for agents working in this repository |

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
pnpm intent-guard --import-spec --project . --from superpowers   # docs/superpowers spec + plan
pnpm intent-guard --freeze --project . --approved-by "<name>"
pnpm intent-guard --check --project . --staged
pnpm intent-guard --report --project . --staged
pnpm intent-guard --rules audit --project .
```

## Development

```bash
pnpm install
pnpm test      # 359 tests (builds first, then schema + core + skill + cli + examples/integrations)
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

Full flags: [docs/cli-reference.md](./docs/cli-reference.md).
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
5. On 1.3.0, move project state from `.conductor/` to `.intent-guard/`. The
   tool does it for you on the first write, or you can run
   `git mv .conductor .intent-guard` yourself. Update the `.gitignore` entry
   and any script or CI step that names the old directory.

The name `conductor` is now used by a different product in this family, so pin
`@vaultcompass/intent-guard` rather than assuming the old name still points at
this tool.

## Project state directory

Per-project state lives in `.intent-guard/` at the root of the repository being
governed:

| Path | What it is |
|------|------------|
| `.intent-guard/intent-contract.yaml` | the active contract, and the frozen contract other tools read |
| `.intent-guard/contracts/` | archived frozen contracts, one file per contract id |
| `.intent-guard/config.yaml` | drift thresholds and coach settings |
| `.intent-guard/index.md` | the generated memory index |
| `.intent-guard/drift-log.jsonl` | append-only drift events |

Commit the directory so contracts are reviewable in pull requests, and ignore
`.intent-guard/drift-log.jsonl`, which is local noise. Before 1.3.0 the
directory was named `.conductor/`; if a `.gitignore` still names it, update the
entry.

Anything reading the frozen contract by path (the umbrella gate runner, a CI
step, another tool) should read `.intent-guard/intent-contract.yaml`. The
pre-1.3.0 path was `.conductor/intent-contract.yaml`.

## Origin

Intent Guard grew out of repeated intent-drift failures in AI-assisted development workflows: vague prompts expanded scope, long sessions lost the original request, and reviews caught implementation quality more reliably than direction. See [docs/brainstorming/01-context-and-problem.md](./docs/brainstorming/01-context-and-problem.md).

## License

MIT, see [LICENSE](./LICENSE)
