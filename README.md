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
scope, or across a constraint the contract recorded. A constraint finding is
advisory and leaves the exit code alone when its source is a prose rules file
(`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, cursor rules); only a `user-stated`
constraint, or one added with `intent-guard correct --promote`, can block.
The second is the change
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

**Version:** `1.5.2`: stable CLI/API on npm (`@vaultcompass/intent-guard*`); see [docs/release/stability-policy.md](./docs/release/stability-policy.md)  
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

### Checking a pull request

On CI, pass `--trust-base` as well as `--base`. The
[GitHub Action](#github-action) below passes both for you and is the shape to
reach for first; this is what it runs:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- run: |
    npx intent-guard check --project . \
      --base origin/${{ github.base_ref }} \
      --trust-base origin/${{ github.base_ref }}
```

`--base` says which paths are judged. `--trust-base` says where the rules come
from: the contract, the config and the contracts archive are read from the base
ref, so a pull request cannot widen its own contract, delete its protected
paths, or write its own approval and have the gate agree. A control input the
branch changed is reported as a proposal and ignored for the run, and a
contract change that also grants itself a new approval is refused as
self-approval, as is one that turns the contract path into a symlink or deletes
it. Pass the base branch, not `github.sha`: on a `pull_request` event that SHA
is the merge commit, and a trust base that resolves to the head commit, or to a
different commit carrying an identical tree, is refused with exit 2 rather than
quietly putting the boundary back where it started.

For the pre-commit hook and a local run, behaviour is unchanged **except** that
a control input which is not a regular file at the path it is named at is now
refused everywhere: a symlinked contract, a symlinked `.intent-guard` directory,
or a symlinked `config.yaml`. Following any of those lets the files this gate
trusts live outside the path a reviewer reads, and lets a later edit to a link
target change them without the control path appearing in any diff. If your setup
links the state directory somewhere else, put the real directory back.

**Put the workflow itself on the protected side.** For a same-repo
`pull_request` event GitHub runs the workflow file from the pull request head,
so the job above is as editable as any other file in the branch until you
arrange otherwise: require the check by name in branch protection, or move the
gate into a reusable workflow held on a protected ref and call it with `uses:`.
Nothing in this tool can detect a job that a pull request deleted, so this is a
repository-configuration step you have to take, not one the flag takes for you.

**A genuine re-freeze on a branch trips the refusal, by design.** `freeze`
writes a new approval, and from the base ref that is indistinguishable from a
forged one. The way through is to land the contract change on the base branch
first, in its own reviewed pull request, or to set up the human-approval
tightening described below. Until then the branch shows drift against the old
contract, which is the honest description of work outside the scope anyone has
approved.

**Optional tightening: require a human approval too.** This is not a feature of
this tool and there is no flag for it. It is a way of configuring your own
repository, described here because it composes with the flag above. Base-ref
judgment is the floor and is not a setting. A team with reviewers can
additionally require that a contract change carry a human approval before it
takes effect on merge, using GitHub's own controls: a required pull-request
review, or a CODEOWNERS entry for `.intent-guard/**` plus branch protection that
requires code-owner review. Those live on the protected base side; never put such
a switch in the in-repo config, because a mode switch stored in a file the pull
request can edit is one the pull request sets to whichever mode is weaker, so a
knob that can only tighten is safe to offer and a knob that can loosen is the
vulnerability wearing a settings label. See
[docs/cli-reference.md](./docs/cli-reference.md) for the full behaviour.

### GitHub Action

The workflow above written out, with both refs decided from the event. This is
the recommended shape: a repository that uses it cannot forget `--trust-base`,
because the action passes it whether or not the workflow says anything.

```yaml
name: intent-guard
on: pull_request

jobs:
  intent:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0        # required: the base branch has to be present
      - uses: vaultcompasshq/intent-guard@v1.5.3
```

No `version` input, because the default is the scanner this action tag shipped
with. The action tag and the installed package are separate numbers.
`vaultcompasshq/intent-guard@v1.5.3` installs `@vaultcompass/intent-guard@1.5.2`:
1.5.3 moved the action and left the packages at 1.5.2. Read the tag as which
workflow step you pinned, not as which package version gets installed.

`fetch-depth: 0` is not optional on a pull request. Both `--base` and
`--trust-base` resolve a branch the default shallow checkout does not fetch, and
without it intent-guard exits 2 and the job fails rather than falling back to
judging the head against itself.

The install step refuses npm older than **10.5.2**. Below that floor
`npm audit signatures` reports a clean install of these packages as tampered,
because the client's own bundled keys are stale. A major-only Node 22 is not
enough: **Node 22.0.0 ships npm 10.5.1**. Node **20.13.0** and later, and
22.1.0 and later, carry a usable npm. The step checks the client it actually
found and names that version when it refuses.

The action installs `@vaultcompass/intent-guard` from the registry into a prefix
under the runner temp and calls that copy by absolute path. It never runs the
checkout's own `node_modules`, and never starts npm with the checkout as its
working directory, so neither a committed `.npmrc` nor a package the head's
lockfile put in `node_modules` can decide which program does the judging. What
that does not cover is the workflow file itself, which a pull request can edit
like any other CI step; branch protection on the base branch, with review
required for `.github/workflows/**`, is the control for that.

**Linux and macOS runners.** The action calls the installed binary at
`<prefix>/bin/intent-guard`, which is where a global npm install puts its shims
on those two. Windows puts them in the prefix directory itself, so the path
would not exist and the job would fail as could-not-run with a message about the
binary rather than about the change. Run this on `ubuntu-latest` or
`macos-latest`.

| Input | Default | What it does |
|-------|---------|--------------|
| `version` | `1.5.2` | Exact version of `@vaultcompass/intent-guard` to install, matching `^[0-9]+\.[0-9]+\.[0-9]+$`. A dist-tag is refused: with one, the program judging a pull request is whichever the registry served that morning. So is anything npm would read as a path rather than a version, such as a value starting with `.` or ending in `.tgz`. |
| `project` | `.` | Project root, relative to the workspace. No `..`, no absolute path, no leading `-`. |
| `base` | *(from the event)* | Ref the changed paths are measured against. On a `pull_request` event, `origin/$GITHUB_BASE_REF`. It decides which paths are judged, never where the rules are read from; the action warns on a run that has one and no trust base. |
| `paths` | *(empty)* | Explicit comma-separated paths instead of, or as well as, `base`. One line: a newline in the value is refused rather than read as another separator. |
| `trust-base` | *(from the event)* | Ref the contract, config and contracts archive are read from. An explicit value redirects pull-request mode; there is no value that turns it off, and `off` is refused. |
| `require-frozen` | `true` | `false` lets a project with no frozen contract pass instead of blocking. |
| `json-output` | *(empty)* | Write the JSON result to this path and expose it as the `result-file` output. Left empty, the verdict is plain text in the job log. Not under `.github/`, which holds the files that decide how this gate runs. |

Outputs are `exit-code` (intent-guard's own: 0 pass, 1 blocked, 2 could not run)
and `result-file`, which is set only when a JSON file was asked for and
something was written to it. Any other exit code means the gate never ran at
all, and the job fails with 2 and a message saying so rather than reporting a
verdict nobody produced.

`exit-code` has a fourth value: **empty**, when the run step never reached its
output lines, which is what a rejected input or a failed install looks like from
outside. The job still fails -- the report step reads an empty code as
could-not-run and exits 2 -- but a workflow that branches on this output should
treat empty as could-not-run too, rather than as a pass it did not get.

Off a `pull_request` event there is no ref to decide `base` from, so set `base`
or `paths` yourself. The action refuses a run that names neither rather than
running the gate on an empty path set, which would pass every time.

**There is no SARIF and nothing is uploaded to code scanning.** Intent Guard
reports one verdict about a change set rather than per-file findings with line
numbers, so there is nothing for the security tab to show that the job's own
pass or fail does not already say. The verdict and its reasons are in the job
log, under the run step; `json-output` is there for a workflow that wants to
post them somewhere itself.

To run this gate alongside dep-guard and vault-guard in a single job, use
[the Conductor action](https://github.com/vaultcompasshq/conductor) instead,
which installs and runs all three.

### Develop from source

```bash
pnpm install
pnpm build
pnpm intent-guard -- init --project .
pnpm intent-guard -- doctor --project .
pnpm intent-guard -- extract --project . --text "Add CSV export. Do not add new API endpoints. Verify the file downloads."
pnpm intent-guard -- import-spec --project . --from kiro --spec-dir .kiro/specs/export
pnpm intent-guard -- import-spec --project . --from superpowers   # docs/superpowers spec + plan
pnpm intent-guard -- freeze --project . --approved-by "<name>"
pnpm intent-guard -- check --project . --staged
pnpm intent-guard -- report --project . --staged
pnpm intent-guard -- rules audit --project .
```

## Development

```bash
pnpm install
pnpm test      # 523 tests (builds first, then schema + core + skill + cli + examples/integrations)
pnpm dogfood:cursor-hooks   # Cursor rule + hook install pass/fail fixture
pnpm dogfood:claude-hooks   # Claude Code SessionStart/Stop lifecycle fixture
pnpm build
pnpm release:smoke
pnpm validate:public-repos
pnpm intent-guard:install-skills   # copy skills to ~/.cursor/skills
```

`validate:public-repos` clones eight public repositories and runs the full
lifecycle against each. It measures layout compatibility, not drift-detection
accuracy: a pass means the CLI produced the expected verdicts on three
synthetic probes whose answers follow from the file path alone. It does not
measure whether drift detection is right on a real change, and identical rows
across the eight repositories are the expected shape of a good result rather
than eight independent confirmations. The generated report opens with the same
warning.

### Session lifecycle (CLIs)

```bash
pnpm intent-guard -- extract --project . --text "the ask"   # 1. draft (unfrozen)
pnpm intent-guard -- import-spec --project . --from auto    # optional spec import
pnpm intent-guard -- freeze  --project . --approved-by me   # 2. approve
pnpm intent-guard -- doctor  --project .                    # 3. diagnose setup
pnpm intent-guard -- check   --project . --staged           # 4. gate (exit 1 = blocked)
pnpm intent-guard -- report  --project . --staged           # PR/CI handoff
pnpm intent-guard -- rules   audit --project .              # project-rule hygiene
pnpm intent-guard -- pivot   --project . --change "..." --acknowledge
pnpm intent-guard -- correct --project . --wrong "..." --right "..." --rule "..." --acknowledge
pnpm intent-guard -- brief   --project .                    # clean re-injectable context
pnpm intent-guard -- resume  --project .                    # brief + recent history
```

Full flags: [docs/cli-reference.md](./docs/cli-reference.md).
The gate
(`intent-guard check`, or `intent-guard-check`) is the one place Intent Guard
*enforces* rather than *suggests*:
wire it via [integrations/git-hooks/pre-commit.sample](./integrations/git-hooks/pre-commit.sample)
locally, and the [GitHub Action](#github-action) on CI
([workflow samples](./integrations/github-actions) if you would rather write the
steps out yourself).
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
5. On 1.3.0, move project state from `.conductor/` to `.intent-guard/`. Run
   `git mv .conductor .intent-guard` yourself, or let the tool rename it on its
   next write. **If the tool renamed it, stage the rename before committing:**
   `git add -A .intent-guard .conductor`. Git did not see the rename happen, so
   until it is staged `git status` shows the contract deleted and a new
   untracked directory, and a `git commit -a` commits the deletion on its own.
   Then update the `.gitignore` entry and any script or CI step that names the
   old directory.

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
entry. If the tool did the rename for you, stage it with
`git add -A .intent-guard .conductor` so git records one rename rather than a
delete plus an untracked directory.

Anything reading the frozen contract by path (a CI step, another tool) should
read `.intent-guard/intent-contract.yaml`. The pre-1.3.0 path was
`.conductor/intent-contract.yaml`.

> **Upgrade `@vaultcompass/conductor` alongside this.** The published umbrella
> `@vaultcompass/conductor` 0.2.2 reads the frozen contract from
> `.conductor/intent-contract.yaml`, so after migration it stops finding one,
> falls back to spec discovery, and then to a no-contract advisory that passes.
> The intent gate goes quiet instead of failing, which means an upgrade here
> silently downgrades it there and nothing in either tool's output says so.
> `@vaultcompass/conductor` 0.2.3 reads `.intent-guard/intent-contract.yaml`
> first and `.conductor/intent-contract.yaml` second, so it works either side
> of the migration. Upgrade it in the same change, or check that the umbrella
> still reports the intent gate as running.

## Origin

Intent Guard grew out of repeated intent-drift failures in AI-assisted development workflows: vague prompts expanded scope, long sessions lost the original request, and reviews caught implementation quality more reliably than direction.

Adopter feedback is a row in [FINDINGS.md](FINDINGS.md). How to change this repository is in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT, see [LICENSE](./LICENSE)
