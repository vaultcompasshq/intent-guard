# Changelog

All notable changes to Intent Guard (published as Conductor through 1.1.0) will
be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Security

- **The Action's version shape check now refuses leading-zero strings
  (01.5.3, 1.05.3, 1.5.03).** Those are invalid semver, so npm reads them
  as a dist-tag rather than a version. The shape check and the pull-request
  re-match both use the same no-leading-zero pattern the sibling actions
  already ship.

- **Hardened the GitHub Action's install step, matching the standard the
  three sibling actions (conductor, dep-guard, vault-guard) already enforce.**
  The install step now runs `npm install -g --ignore-scripts`, so a package
  in the resolved tree can no longer run arbitrary code on the runner that
  holds the job's token. It writes a synthetic root manifest at
  `$npm_config_prefix/lib/package.json` naming the installed package and
  version, without which `npm audit signatures` walks the tree's edges out,
  finds no edge to the gate itself, and silently skips checking it. It then
  runs `npm audit signatures` from inside that manifest directory, and
  refuses to proceed on an npm client older than 10.5.2, which reports a
  clean install of these packages as tampered with because its own bundled
  signing keys are stale.
- **Added a pull-request backward-pin rule to the `version` input.** On a
  `pull_request` event, GitHub runs the workflow file from the pull request's
  own head, so nothing previously stopped a pull request from pinning
  `version` to a gate older than the one the action tag ships, and being
  judged by whatever rules that older gate happened to enforce. The validate
  step now refuses a `version` below the tag's own gate (`IG_TAG`, currently
  1.5.2) on a pull request only, naming both versions and the remedy.
  Pinning forward is still accepted, on the rule's unenforced assumption that
  a newer gate is at least as strict.

### Tests

- Added a characterization test pinning that `checkGate` with `requireFrozen:
  false` and no contract found returns status ok, exit code 0. This is
  intended advisory behavior (a missing contract must not block when the
  caller did not ask for a hard gate) and is indistinguishable from a
  repository that has simply not adopted intent-guard yet, which is why no
  could-not-run check for a misrooted scan can be added in this mode.

## [1.5.2] - 2026-09-18

Patch bump on all four packages. It fixes one regression that 1.5.1 shipped:
`check`, `report` and `drift` refused an explicitly empty `--paths` or
`--signals`, which broke every caller that states an empty change set that way.

### Fixed

- **`--paths ""` and `--signals ""` are the empty list again, not a missing
  value.** 1.5.1 made every CLI refuse a known value flag that arrived without
  its value, which is right for a scalar, but the list-taking arms tested the
  next argument for truthiness. An explicit empty string is falsy, so it fell
  out of its own arm into the missing-value arm and the command answered
  `error: option '--paths' requires a value` plus the whole usage screen, exit
  1, no report. 1.5.0 dropped both tokens in silence, so the same command had
  worked by accident.

  The caller this broke is a pull-request runner. The umbrella that runs this
  gate builds the path list from `git diff --name-only base...HEAD` and passes
  `--paths ""` when that diff is empty, deliberately, so that the empty set is
  STATED rather than left for the gate to fill in from whatever else it can
  see. On 1.5.1 that run printed usage text and no JSON, the umbrella read it
  as could-not-run, and the pull request went red over a flag rather than over
  the change.

  From 1.5.2 an empty string after a list flag is a value meaning zero entries.
  Nothing after the flag, or another flag after it, is still the missing value
  1.5.1 set out to catch, and still exits 1 with the same sentence.

- **A list flag no longer swallows the flag that follows it.** The same
  truthiness test accepted `--paths --json`, took `--json` as the path list,
  and judged a path literally named `--json` while printing human output to a
  caller waiting for JSON. A token beginning with a dash is now a missing
  value, so that command is refused.

  Unchanged on purpose: scalar value flags. An empty `--project`, `--message`,
  `--previous-contract` or `--contract` is still a missing value, because there
  is no such thing as an empty project root, and `check --message --help` still
  scores the literal text `--help`.

## [1.5.1] - 2026-09-18

Patch bump on all four packages. It carries the two flag-parsing fixes merged
as #80 and #81: every CLI parser now refuses an argument it does not recognise
instead of dropping it in silence, which closes a fail-open where a mistyped
`--trust-base` left pull-request mode off and the gate reported a pass, and a
`hook install --with-vault-guard` that installed a pre-commit hook with no
secrets scan in it while exiting 0.

### Fixed

- **A mistyped flag is refused instead of silently ignored, on `check`,
  `report` and `drift`.** The argv loops were an if/else-if chain with no
  trailing `else`, so an unrecognised argument was dropped without a word. That
  turned a typo into a **quieter run** rather than an error: `--trust-bse
  origin/main` left pull-request mode off, so the gate read its control inputs
  from the head instead of the base ref, scored against whatever thresholds the
  head carried, and reported a pass — while the workflow that asked for
  pull-request mode looked like it had got it.

  The cost is measurable on one of this repo's own fixtures: the same `drift`
  run answers `hard_block` with `--trust-base` and `proceed` without it. A typo
  silently bought the second answer.

  A bare word is refused for the same reason — `intent-guard check src/foo.ts`
  looked like it checked that path and checked nothing, because paths arrive
  through `--paths`. `--base` and `--trust-base` already refused a *missing*
  value, so the parser had a refusal path and simply never reached it for an
  unknown name. The message now names the offending argument.

  Found while auditing a vault-guard defect of the same family and the opposite
  direction: that one exited 1 on an unknown option and was reported as a
  secrets finding, failing closed and loudly. This one failed open and said
  nothing.

- **`hook install` no longer installs a pre-commit hook with the secrets scan
  silently missing.** This is the security-relevant one in the sweep, and it is
  the reason the sweep happened rather than being filed as polish.
  `--with-vault-guard` pairs the generated hook with a `vault-guard scan
  --staged`. Mistyped, the flag was dropped without a word and the install
  still SUCCEEDED, exit 0, printing `installed: true`. What landed was a hook
  with no secrets scanning in it, while the user had every reason to believe
  they had just installed secrets scanning, so the next commit carrying
  credentials sails through a gate they think is armed. It cannot change a CI
  verdict the way `check` and `drift` can, which is why it was out of scope for
  the fix above, but a control that goes missing quietly is a downgrade
  wherever it sits.

- **The same refusal on the remaining flag-parsing commands: `brief`,
  `correct`, `doctor`, `extract`, `freeze`, `index`, `init`, `pivot`, `resume`
  and `rules audit`.** These are UX rather than security or gate correctness:
  the worst case is a command that runs with one flag's effect missing and says
  nothing, such as a mistyped `--json` printing markdown at a caller parsing
  JSON, a mistyped `--write` on `index` printing the index and writing nothing
  while exiting 0, or a mistyped `--project` on `init` scaffolding into the
  current directory instead of the one named. The parser shape was identical to
  the three above, so the fix is identical, and leaving ten of them behind
  would have left the same class half-closed.

  `import-spec` already refused an unknown argument; it just never said which
  one, and now it does.

  **`coach` is deliberately left as it was.** Everything after that command is
  the prompt text being scored, so there is no flag position to guard past the
  first token and a refusal there would reject the ordinary case of scoring a
  sentence. The two commands that take a word before their flags, `hook
  install` and `rules audit`, take that word off the front before the flag loop
  runs, so the refusal only ever sees flag-position tokens and cannot swallow a
  subcommand.

- **A documented flag that arrived without its value now says so, instead of
  being reported as a flag that does not exist.** Every value-taking arm in
  these parsers is shaped `arg === "--reason" && argv[i + 1]`, so a flag spelled
  correctly with nothing after it, or with an empty string after it, fell out of
  its own arm and into the refusal above: `intent-guard pivot --change x
  --reason ""` answered `unknown option '--reason'` about a flag printed a few
  lines lower in its own usage text, and sent the reader hunting a spelling
  mistake that was not there. All sixteen commands now answer `option
  '--reason' requires a value`, still exit 1, and the sentence is identical on
  every one of them.

- **Three ways this sweep changes what a published CLI does.** Each replaces a
  silent drop with exit 1, so anything scripted against 1.5.0 or earlier can
  see it:

  1. A known flag with a missing or empty value exits 1 where several of these
     commands used to exit 0 with the flag dropped. `--project ""` fell through
     to the default of `.` and ran against the current directory instead of the
     one the caller named; `pivot --reason ""` recorded a pivot with no reason
     on it.
  2. The `--flag=value` form, which no parser here has ever supported, exits 1
     instead of being dropped. This is the improvement of the three:
     `intent-guard init --project=/elsewhere` used to scaffold `.intent-guard/`
     into the current directory and report success.
  3. `hook install` takes the word `install` in first position only.
     `intent-guard hook --project . install` is now refused. No documentation
     ever wrote it that way, and the word is taken off the front before the
     flag loop runs, which is what keeps the loop from swallowing it.

  Unchanged on purpose: `intent-guard check --message --help` still scores the
  literal text `--help`, because that is a value the parser accepts rather than
  a missing one, and `--base` and `--trust-base` keep their own refusal of a
  value beginning with `--`.

- **The GitHub Actions samples no longer hand the gate an empty `--paths`.**
  Both samples build the path list from a `git diff` and passed the result
  straight to `check --paths "$CHANGED"`. On a run whose diff is empty that is
  `--paths ""`, which the gate now refuses, so the check would go red with a
  message about a flag rather than about the change under review. Both samples
  now skip the flag when the list is empty, the way
  `integrations/hooks/conductor-stop-check.sh` already did.

- **The two quickstart blocks in the README ran nothing.** Every invocation in
  them was written `pnpm intent-guard --doctor --project .`, which answers
  `Unknown intent-guard command: --doctor` and exits 1. The working form, the
  one `docs/cli-reference.md` uses, is `pnpm intent-guard -- doctor
  --project .`. Pre-existing rot rather than anything this sweep introduced,
  but it is the front page.

## [1.5.0] - 2026-09-11

Minor bump on all four packages. **The rule: a repository should not have to
remember `--trust-base`.** A composite action at the repository root now runs
the gate on a pull request and decides both refs from the event, so this is a
new feature rather than a fix.

### Added

- **A GitHub Action, `vaultcompasshq/intent-guard`.** Composite, so it adds no
  container and no second runner. On a `pull_request` event it runs
  `intent-guard check` with `--base origin/$GITHUB_BASE_REF` for the paths it
  judges and `--trust-base origin/$GITHUB_BASE_REF` for where the contract, the
  config and the contracts archive are read from. A workflow that uses it
  cannot enter a pull-request run without pull-request mode, which is the
  mistake a hand-written workflow makes by leaving one flag out.

  **The gate comes from outside the tree it judges.** The action installs
  `@vaultcompass/intent-guard` at the pinned version into a prefix under the
  runner temp, with npm started from the runner temp rather than the checkout,
  and calls the installed binary by absolute path with an absolute `--project`.
  Neither an `.npmrc` committed by the head nor a copy of the package sitting in
  the head's `node_modules` can decide which program does the judging. What the
  pin does not cover is the workflow file, which a pull request can edit like
  any other CI step; branch protection on the base branch, with review required
  for the workflow path, is the control for that.

  Inputs: `version` (an exact version, nothing else: a dist-tag hands the choice
  of program to the registry, and a value npm reads as a path lets the tree
  supply its own gate), `project`, `base`, `paths`, `trust-base`,
  `require-frozen`, `json-output`. Outputs: `exit-code` and `result-file`, the
  second set only when JSON was asked for and something was written. Every input
  is validated in a step of its own, through the environment rather than through
  an expression, because Actions substitutes an expression into a run script
  before the shell parses it. `trust-base: off` is refused by name in any
  capitalisation: on a same-repository `pull_request` event the workflow file
  runs from the pull request's own head, so an opt-out input would be settable
  by the pull request it governs.

  Only 0 and 1 are verdicts. 2 and every other code, including the ones the
  shell produces when the binary never ran, are reported as could-not-run and
  re-raised as 2, so a required check fails without claiming the change was
  blocked. A run that has a `base` and no trust base gets a warning, because
  `base` decides which paths are judged and never where the rules come from.

  Off a `pull_request` event the action refuses a run that names neither `base`
  nor `paths`, rather than running the gate on an empty path set, which passes
  every time.

  `require-frozen: false` passes `--no-require-frozen`. `json-output` runs the
  gate with `--json` and redirects stdout to that path; left empty, the verdict
  stays readable in the job log.

  There is no SARIF and nothing is uploaded to code scanning: the gate reports
  one verdict about a change set rather than per-file findings with locations,
  so the job's own pass or fail is the signal, and that is what a branch
  protection rule reads.

- **`examples/validate-action.test.ts`**, which runs the action's four bash
  scripts under the flags GitHub uses, with npm and the installed binary
  replaced by recorders, and asserts the argument vector and the directory each
  one was started in rather than matching the YAML. Each step's environment and
  working directory are derived from that step's own `env:` and
  `working-directory:`, so a variable a script reads but the file does not
  declare fails the suite instead of being quietly supplied by the harness.

## [1.4.0] - 2026-09-05

Minor bump on all four packages. **The rule: on a pull-request run, every
control input comes from the base ref and the head tree is the thing judged.**
A new flag and a new refusal, so this is a minor rather than a patch.

### Added

- **`--trust-base <ref>` on `check`, `report` and `drift`.** Pull-request mode.
  The frozen contract, `config.yaml`, and the contracts archive are read from
  `<ref>` with `git show`, and the head tree is judged against them. A control
  input the head changed never takes effect for the run and is reported on one
  line: `contract changed in this pull request`, or `config changed in this
  pull request`. Reads only: no checkout switch, no worktree, and nothing
  written into the repository. Fails closed, exit 2, when the ref will not
  resolve; a missing base is never a reason to fall back to trusting the head.
  Pass it alongside `--base`, which continues to decide only which paths are
  judged.
- **A self-approval refusal.** When the gate is enforcing a frozen contract and
  a pull request both changes the contract and gives it an approval that is not
  the base ref's, the run fails closed with a reason beginning `Self-approval
  refused:`. A contract change that leaves the approval block alone is not
  refused; it is reported as a proposal and judged against the base contract's
  scope and budgets.
- **A `Control input refused:` reason** for a pull request that changes what the
  contract path *is* rather than what the contract says: a symlink, a
  directory, a deletion, or a change to the file's mode bits. Reported as a
  proposal in every case, refused while the gate is enforcing a frozen
  contract.
- **A `Pull-request mode` section in the markdown report**, and a `trustBase`
  block in the JSON from `check` and `report`, naming the ref, every proposed
  control-input change, whether self-approval was refused, and how the head
  changed the contract file's type or mode.

### Security

- **A pull request could turn the gate off in the same commit that carried what
  the gate exists to catch.** The gate read its contract and its config out of
  the tree it was judging, so one commit could widen `in_scope`, delete
  `budget.protected_paths`, set `allowed_paths` to everything, and write its own
  `frozen_by: user` plus an `approval` block; the gate agreed with the rewritten
  contract and returned ok. Closed by `--trust-base`, which is how CI should now
  invoke the gate on a pull request. Local and pre-commit behaviour is unchanged
  except for the symlink refusal below, and is pinned byte for byte by a parity
  test for every control input that is a regular file at the path it names.
- **`config.yaml` now has a schema and floors, validated on every load.** It had
  neither, so `hard_block: 101` disabled drift blocking outright, since the
  drift score is capped at 100 and every band is tested with a
  greater-or-equal comparison. Thresholds must now be numbers from 0 to 100,
  `hard_block_on_critical_constraints` must be a boolean, `drift.mode` must be
  one of the three known modes, and an unknown key is refused by its full path
  rather than silently dropped. A refused config prints one line and exits 2,
  because nothing was judged. These bound what a value may be, not what a
  project may decide.
- **A trust base that resolves to the commit being judged is refused**, exit 2,
  even though it names a real commit. `--trust-base HEAD` was accepted and put
  the boundary back exactly where it started: every control input came from the
  tree under judgment, no contract change could ever differ from its own base,
  and the report said pull-request mode was on. The realistic way in is
  `--trust-base ${{ github.sha }}`, because on a `pull_request` event with the
  default `actions/checkout` that SHA is the merge commit, which is HEAD. The
  comparison is on resolved commits, so an alias, a tag or a raw SHA naming the
  head commit is refused alike.
- **A trust base whose TREE equals the head's is refused too**, exit 2, even
  when it is a different commit. The commit comparison alone let the forgery
  through in the ordinary pull-request shape: what GitHub publishes as
  `refs/pull/N/merge` is a merge commit whose tree, when the base has not moved
  since the fork, *is* the head branch's tree, and `actions/checkout` leaves that
  commit checked out, so `--trust-base ${{ github.event.pull_request.head.sha }}`
  named a different commit carrying an identical tree and every control input
  still came from the tree under judgment. Merging the base into the branch
  changes the head's tree, so a pull request that does that is judged normally.
- **A control input that is not a regular file at the path it names is refused,
  everywhere.** Replacing the contract with a link whose target holds the
  approved bytes changed nothing any content comparison could see, so
  pull-request mode reported "no control input changed"; once that landed, a
  second pull request editing only the link target widened the contract without
  the contract path appearing in its diff at all. All of it is closed, at three
  paths and on both sides:
  - the head side of the base-versus-head comparison is read through git rather
    than from the working tree, so a symlink is compared as the link target
    string it is and a type or mode change is visible at all;
  - `readContract` lstats the contract path and refuses to follow a link;
  - `stateDir` and `ensureStateDir` lstat the `.intent-guard` directory itself
    and refuse a symlinked state directory, which was the same trick one level
    up: `isDirectory` used `statSync`, which follows links, so the contract
    underneath looked like an ordinary file all the way down;
  - `loadConfig` lstats `config.yaml` for the same reason, so one rule covers
    every control input rather than one with an exception.

  The last three are a hardening **outside** pull-request mode: they apply to
  every local run and pre-commit hook, and they narrow behaviour that used to
  work, so a setup that deliberately links its state directory somewhere else
  has to put the real directory back. A dangling link now reports itself instead
  of reading as an absent contract.

### Changed

- **`mergeConductorConfig` validates.** It keeps its name and signature and
  moves from `config-types` to `config-schema`, and now throws where it used to
  silently accept. Leaving an unvalidated merge exported beside the validating
  one would have left the second door into the config open.
- **Exit 2 now also means a refused config, an unresolvable trust base, or a
  trust base that is the head commit or carries the head's tree**, in addition
  to an unresolvable `--base`. It has always meant could-not-run.
- **An unresolvable trust base is described in plain words.** `--quiet`
  suppresses git's own explanation, so the message fell back to the exception
  text and printed `Command failed: git rev-parse --verify --quiet ...` at the
  user, handing them a command line to run instead of a thing to fix.
- **A config value of `.nan` or `.inf` is named by the token the user typed.**
  It was reported as "got null", because `JSON.stringify` renders both that
  way, which sent a reader looking for an empty value that was nowhere in their
  file.

### Documentation

- **The workflow that passes `--trust-base` has to be put on the protected side
  deliberately.** For a same-repo `pull_request` event GitHub runs the workflow
  file from the pull request head, so the job is as editable as any other file
  in the branch unless the check is required by name in branch protection or the
  gate lives in a reusable workflow on a protected ref. The docs asserted the
  workflow was protected without saying it has to be arranged; both the README
  and the CLI reference now say so, and say that no flag can detect a job a pull
  request deleted.
- **A genuine re-freeze on a branch trips the self-approval refusal, by
  design**, because `freeze` writes a new approval and from the base ref that is
  indistinguishable from a forged one. The README and the CLI reference now say
  it plainly and give the two ways through: land the contract change on the base
  branch first, or set up the human-approval tightening.
- **The human-approval tightening is described as repository configuration, not
  as a feature.** It reads as GitHub's own controls, a required review or a
  CODEOWNERS entry with branch protection, because there is no flag for it and
  the previous wording invited readers to look for one.

## [1.3.1] - 2026-09-05

Patch bump on all four packages. Three security fixes. Two are in files this
package ships as samples or uses only at release time, and one is in the
`import-spec` code path.

### Security

- **`import-spec` no longer follows a symlink out of the project or reads an
  unbounded file.** The spec bridge resolved any path with no containment
  check and read it with a call that follows symlinks, with no size cap, and
  auto-discovery takes the newest markdown under `docs/superpowers/specs`. A
  pull request that dropped a symlink there pointing at any local file made a
  maintainer running `import-spec` read that file into the contract's
  `original_ask` and print it to stdout. Both discovered and explicitly passed
  spec and plan paths are now canonicalised and required to sit inside the
  project, and reads are capped at 2 MiB with a clear error. Contained-only is
  the default and the only mode today; a deliberate escape flag can widen it
  later.
- **The shipped GitHub Actions samples no longer interpolate untrusted text
  into a shell script.** Both samples in `integrations/github-actions` built a
  `run` body by substituting `github.base_ref` and a step output straight into
  the script with the GitHub expression syntax, which is textual substitution
  performed before the shell runs. A pull request that added a file whose name
  held a command substitution or backtick payload executed arbitrary commands
  on the runner of every repository that copied a sample. Both values now pass
  through the step `env` block and are read as quoted shell variables, and each
  sample declares a minimal `contents: read` permission block.
- **The release workflow refuses to publish a tag that is not on `main`.**
  `release.yml` fires on any `v*` tag and grants the release job
  `id-token: write` with no ancestry check, so anyone who could push a tag
  could publish arbitrary code to the latest dist-tag around branch
  protection. The workflow now refuses unless the tagged commit is an ancestor
  of `origin/main`, before install, build, and publish. This guard is first
  exercised on the next real tag push.

## [1.3.0] - 2026-09-05

Minor bump on all four packages. There is one user-visible change. The
per-project state directory is renamed from `.conductor/` to
`.intent-guard/`. Nothing about the contract schema, the gate, or any flag
changes.

### Changed

- **State directory renamed to `.intent-guard/`.** Through 1.2.1 this tool
  wrote its per-project state to `.conductor/`. The umbrella product that
  runs the three gates is now itself called conductor, and it writes
  `.guardrails.yaml` and `.guardrails/` into the same repositories. A
  repository that adopted both would show `.conductor/` and `.guardrails/`
  side by side with nothing to say which tool owns which. You would guess
  the wrong tool.

  The full migration rule:

  - If `.intent-guard/` exists, it is used, and `.conductor/` is not read.
  - Otherwise, if `.conductor/` exists and holds Intent Guard state, meaning
    any of `config.yaml`, `intent-contract.yaml`, `index.md`,
    `drift-log.jsonl`, or `contracts/`, it is read from, and one line goes
    to stderr per invocation saying the directory was renamed and how to
    migrate.
  - The first write migrates it. The directory is renamed with a single
    `rename`, which is atomic on one filesystem and carries across files
    this tool does not know about, and a line goes to stderr saying what
    happened. The rename only ever runs when `.intent-guard/` does not
    exist.
  - If both directories exist, every command fails closed with an error
    naming both, rather than picking one and silently orphaning the other.
  - A `.conductor/` holding none of those files belongs to something else.
    It is left alone, not read and not renamed.

  `doctor` reports which directory is in use, warns while a legacy directory
  is still the live one, and errors when both exist. Its finding ids are a
  machine-readable contract, so `conductor_not_initialized` and
  `conductor_dir_found` keep their names despite naming the old product. The
  ids added here are `state_dir_legacy` and `state_dir_conflict`.

  Anything that reads the frozen contract by path should now read
  `.intent-guard/intent-contract.yaml`. The pre-1.3.0 path was
  `.conductor/intent-contract.yaml`.

  **Upgrade `@vaultcompass/conductor` alongside this.** The published
  umbrella `@vaultcompass/conductor` 0.2.2 reads the frozen contract from
  `.conductor/intent-contract.yaml`. After migration it finds none there,
  falls back to spec discovery, and then to a no-contract advisory that
  passes. The intent gate goes quiet instead of failing, so upgrading here
  silently downgrades it there, and neither tool says so in its output.
  `@vaultcompass/conductor` 0.2.3 reads `.intent-guard/intent-contract.yaml`
  first and `.conductor/intent-contract.yaml` second, so it spans the
  migration. Upgrade it in the same change.

- **`.gitignore` and staging guidance.** `init --human` now prints what to
  commit and what to ignore, and the README says the same. Commit
  `.intent-guard/` so contracts are reviewable, ignore
  `.intent-guard/drift-log.jsonl`, and update a `.gitignore` entry that
  still names `.conductor/`. Git does not see a rename this tool performed,
  so the rename notice and the README both say to stage it with
  `git add -A .intent-guard .conductor`. Skip that and `git status` shows
  the contract deleted plus an untracked directory, and a `git commit -a`
  commits the deletion on its own.

- **A refused state directory prints one line, not a stack trace.** Both
  directories present, or a file or symlink where a directory belongs, are
  expected states. They now raise `StateDirError`, which every CLI turns
  into a single message and exit 1.

- **A `.conductor` symlink is ignored rather than treated as a second
  directory.** `ln -s .intent-guard .conductor` is the obvious workaround
  for a script that still names the old path. The legacy path is now tested
  with `lstat`, so a symlink is not a legacy state directory and does not
  trip the both-directories error. The error text also says to move
  `.conductor` aside rather than to delete `.conductor/`, because a
  trailing slash through a symlink makes BSD `rm -rf` delete the target's
  contents.

### Added

- `STATE_DIR`, `LEGACY_STATE_DIR`, `StateDirError`, `stateDir()`,
  `ensureStateDir()`, `inspectStateDir()`, and `resetStateDirNotices()`
  exported from `@vaultcompass/intent-guard-core`. `stateDir()` resolves the
  directory to read from; `ensureStateDir()` resolves the directory to
  write to, migrating first.
- `DoctorResult.stateDir` and `InitResult.state_dir`, plus
  `InitResult.gitignore_hint`.
- `DRIFT_LOG_FILE` and `INIT_GITIGNORE_HINT` exports.

### Deprecated

- `CONDUCTOR_DIR` and `conductorDir()` in `@vaultcompass/intent-guard-core`,
  and `DoctorResult.conductorDir` and `InitResult.conductor_dir`. All four
  are **frozen at their 1.2 meaning** and removed in 2.0. `CONDUCTOR_DIR`
  still holds `.conductor`, and it now aliases `LEGACY_STATE_DIR`.
  `conductorDir()` is still the plain join `<projectRoot>/.conductor`, and
  the two result fields still report that path. None of them resolves
  between the two directory names, writes to stderr, or throws. A
  deprecated symbol gets one minor release still behaving as it did, so use
  `STATE_DIR`, `stateDir()`, `DoctorResult.stateDir`, and
  `InitResult.state_dir` for the directory the tool actually uses.

### Fixed

- The `archived_path` on an archived contract summary is now derived from
  the project root instead of a hard-coded directory name, so it names
  whichever state directory is actually in use.

## [1.2.1] - 2026-09-03

Patch bump on all four packages. Two additive features, a README note, and one
change that is not additive: the rename fix under **Fixed** makes a rename count
as two paths, so a tight `max_files` budget that passed on a rename under 1.2.0
now blocks. Read that entry before upgrading a pre-commit hook. No schema
change and no removed flag.

### Added

- **`check --base <ref>` and `report --base <ref>`.** The gate can now be run
  against a base ref instead of the git index, which is what a pull request
  actually is: paths come from `git diff --name-only <ref>...HEAD`, the three-dot
  form, so commits that landed on the base branch after the fork are not
  attributed to the branch. `--staged` is still the pre-commit view, and it sees
  nothing in CI, where the index is empty.

  `--base` is additive with `--paths` and `--staged`; the combined list is
  de-duplicated and keeps first-seen order. It **fails closed**: an unknown ref,
  a directory that is not a repository, a shallow clone with no merge base, or a
  git that will not run each print one line to stderr naming the ref and exit
  **2**. There is no silent fallback to an empty path set, because an empty set
  makes the gate pass.

  In GitHub Actions, `actions/checkout` fetches a single commit by default, so
  check out with `fetch-depth: 0` or fetch the base ref explicitly; without a
  merge base the gate exits 2 rather than passing. `check` and `report` now share
  one path-collection module so they cannot see different paths for the same
  flags.

  Git lists paths relative to the repository root, not to `--project`, so run
  the gate from the repository root or write budget globs repo-relative when
  `--project` points at a subdirectory.

- **`import-spec --from superpowers`.** A fourth source format for the spec
  bridge. A superpowers feature is two markdown files rather than a directory of
  roles, so the design spec is imported as `requirements` and the plan as
  `tasks`; the `design` role stays empty unless `--design` is passed, because the
  design reasoning already lives in the spec.

  `--spec <path>` and `--plan <path>` name the two files. With neither,
  discovery takes the newest markdown file by mtime under
  `docs/superpowers/specs` and pairs it with the plan in
  `docs/superpowers/plans` whose filename stem matches after a trailing
  `-design` is stripped; the suffix is optional. A spec with no matching plan
  imports on its own, and `--plan` without `--spec` is an error, since a task
  list is not a contract. Under `--from auto`, superpowers is checked **after**
  spec-kit and kiro, so a repo with an existing layout resolves exactly as it did
  before.

  If the spec or the plan holds a fenced yaml block whose entire content is a
  single `budget` key, that value is validated against the contract schema and
  attached to the draft as its change budget. Any other yaml fence is ignored, so
  a document can show a config sample without declaring a budget by accident, and
  a `budget` block that does not validate is an error naming its file rather than
  a silent skip.

### Fixed

- **A rename no longer walks a file out of a protected directory unnoticed.**
  Both `--staged` and `--base` now pass `--no-renames` to git. Rename detection
  reports only a rename's destination, so moving `src/legacy/keeper.ts` to
  `src/new/keeper.ts` never named the protected path and a
  `protected_paths: ["**/legacy/**"]` budget passed. Both sides of a rename are
  now listed, so a deletion and a move both block. The cost, and it is
  deliberate: **a rename counts as two paths against `max_files`**.

### Changed

- The README now names the package at the top: this project is
  `@vaultcompass/intent-guard`. An unrelated package called `intentguard` exists
  on npm and is not this project.

## [1.2.0] - 2026-09-02

Minor bump on all four packages. The rename is the headline, but it renames
package and binary names only: the Intent Contract schema, the exported API, and
everything under `.conductor/` are unchanged, so an existing project keeps
working once its hooks and imports point at the new names.

### Changed

- **Renamed to Intent Guard.** `@vaultcompass/conductor-cli` is now
  `@vaultcompass/intent-guard`, and `-core`, `-schema`, and `-skill` are now
  `@vaultcompass/intent-guard-core`, `-schema`, and `-skill`. The unified binary
  `conductor` is now `intent-guard`, and each `conductor-<command>` binary is now
  `intent-guard-<command>`. The repository moves to
  `github.com/vaultcompasshq/intent-guard`.

  The old binary names are **not** kept as aliases. A pre-commit hook or agent
  hook that calls `conductor-check` will fail after upgrading; re-run
  `intent-guard hook install --project .`, and see the upgrade steps in the
  README. Because the generated hook is fail-closed as of this release, that
  failure blocks the commit rather than passing silently.

  Not renamed, deliberately: the `.conductor/` project directory and everything
  in it, the `conductor-managed-pre-commit` marker inside generated hooks, the
  lifecycle hook adapter scripts under `integrations/hooks/` (referenced by path
  from users' own editor settings), and the exported TypeScript symbol names.

- The pre-commit samples now read `INTENT_GUARD_CHECK`, falling back to
  `CONDUCTOR_CHECK`, so a hook copied from an older checkout keeps working.

### Added

- **Stable finding fingerprints.** Every finding emitted in JSON carries a
  `fingerprint`: sha256, hex, over a canonical string of the contract id, the
  rule or category id, and the sorted normalized matched paths. Nothing
  positional and nothing time-based is hashed, so the same finding on the same
  input has the same id across runs and machines, and reordering the matched
  paths does not change it. Budget violations gain the field directly; drift
  findings gain a parallel `finding_details` array carrying the fingerprint,
  category, rule id, message, and matched set, leaving `findings` a plain string
  array. The recipe is documented in `docs/cli-reference.md` so a baseline tool
  can reproduce an id without calling Intent Guard.

- `doctor` now detects the `dep-guard` binary and reports its version the way it
  already did for `vault-guard`: config-file check, hook and workflow evidence,
  and a warning when a project references dep-guard but the binary is not on
  PATH.

### Fixed

- **vault-guard scans read the right field.** `scanVaultGuardStaged` read
  `summary.secrets`, which counts every match at any severity and ignores the
  `fail_on` threshold vault-guard actually enforces, so Intent Guard could report
  a blocking result on findings vault-guard would let through. The verdict now
  comes from `run.blocking_matches`, the field vault-guard documents for
  integrators. `secrets` is still reported, labelled informational.

- **The generated pre-commit hook fails closed.** It returned 0 when a gate
  binary was missing, so a fresh clone or a CI box without the dev dependencies
  committed straight through the guard it had just installed. A missing binary
  now exits 127 with a one-line message. Nothing is skipped.

- **The hook keeps the first non-zero exit code.** It composed exit codes
  last-failure-wins, so a cheap gate failing after an expensive one masked the
  earlier code, in particular a scanner's exit 2 (could not complete, treat as
  blocking) being downgraded to exit 1 (policy violation). Every gate still runs
  after a failure and every gate's code is printed; the hook exits with the
  first non-zero one.

- **`--help` prints help.** `check --help` and `report --help` ran the gate
  against the current directory and exited with its result. Twelve other
  subcommands printed nothing at all, and two printed usage to stderr with exit
  1. Every subcommand now prints usage to stdout and exits 0 without reading a
  contract, running the gate, or writing a file. `--help` is read as a flag, not
  as a flag's value, so `check --message --help` still checks the literal
  message.

- `release:smoke` reads the expected version from the root manifest instead of
  hardcoding it, removing a fifth place a release had to remember to bump.

## [1.1.0] - 2026-07-29

### Added

- **Change Budget.** An optional `budget` block on the Intent Contract that the
  gate checks against the changed file paths. It is deterministic and path-only
  (no model, no network). Fields: `allowed_paths` (work must stay inside these
  globs), `protected_paths` (never touch), `max_files` (cap on changed files),
  and `allow_new_dependencies` (flag manifest/lockfile edits). Touching a
  protected path hard_blocks; the other breaches soft_block. `conductor check`
  and `conductor report` show budget violations. Globs support `*`, `**`, `?`,
  and a wildcard-free glob as a directory prefix. Example:
  [examples/intent-contracts/retry-with-budget.yaml](./examples/intent-contracts/retry-with-budget.yaml).

### Changed

- Docs hygiene: corrected test count and restored the CHANGELOG to descending
  version order.

## [1.0.10] - 2026-07-21

### Added

- **`pnpm dogfood:claude-hooks`** — repeatable Claude Code lifecycle fixture
  (settings sample + SessionStart brief + Stop-check block/pass + shared Git
  gate). Validation note:
  [docs/validation/claude-hook-dogfood-2026-07-21.md](./docs/validation/claude-hook-dogfood-2026-07-21.md).

### Fixed

- **`integrations/hooks/conductor-lib.sh` path CSV on macOS.**
  `conductor_changed_paths_csv` used `paste <<<`, which BSD paste rejects;
  it now pipes to `paste -sd, -` so Stop/Session hooks gather staged paths
  correctly on macOS.
- **Claude Code Stop hard-block:** `conductor-stop-check.sh` exits **2** when
  the gate blocks (or `conductor-check` is missing). Claude Code treats exit 1
  as a non-blocking Stop error; exit 2 prevents ending the turn. Git
  pre-commit still uses `conductor-check` exit 1.

## [1.0.9] - 2026-07-21

### Added

- **`pnpm dogfood:cursor-hooks`** — repeatable Cursor integration fixture
  (project rule + `hook install` + out-of-scope block / in-scope commit).
  Validation note: [docs/validation/cursor-hook-dogfood-2026-07-21.md](./docs/validation/cursor-hook-dogfood-2026-07-21.md).

### Fixed

- **`conductor hook install` respects machine-wide `core.hooksPath`.** When the
  configured hooks directory is outside the repo (common with global
  vault-guard installs), install sets local `core.hooksPath=.git/hooks` and
  writes the Conductor hook there instead of a no-op install into `.git/hooks`
  that Git never runs. In-repo paths such as `.githooks` are unchanged.

### Changed

- **Messaging:** README leads with approved Intent Contract + drift gate;
  status line tracks the current 1.0.x release.
- **Cursor / Claude Code integration docs** point at `hook install` and the
  dogfood validation note; clarify that project/lifecycle rules are advisory.
- **Prompt coach:** document the public-SaaS exemplar list used by
  `product_stack` (not a portfolio catalog).

## [1.0.8] - 2026-07-16

### Fixed

- **Extraction:** a multi-clause "X and Y" imperative ask no longer drops
  clause X from `in_scope` when its verb isn't in the curated action-verb
  list (found via local-repo validation).
- **Extraction:** out-of-scope prohibition matches are now bounded to their
  own sentence, so a long prohibition clause no longer bleeds into the
  following acceptance-criteria sentence or gets truncated mid-word.
- **Extraction:** compound "do not A or B, and do not C" prohibitions no
  longer produce a fabricated, spliced-together `out_of_scope` entry.
- **Constraints:** a bare code-span reference bullet (e.g. a file path)
  under a rules-style heading is no longer captured as a standalone rule.
- **Constraints:** the constraint loader no longer treats descriptive prose
  using the bare word "require" (e.g. progress notes like "N tests require
  X") as normative rule language.

## [1.0.7] - 2026-07-13

### Changed

- **Public hygiene pass:** hash-only portfolio guard; generic fixtures and doc
  names (`downstream-app-*`, `stub-detection-*`); remove internal jargon from
  tests; trim decorative source comments; `.cursor/` gitignored.
- **Portfolio guard:** SHA-256 hash blocklist only (vault-guard pattern); slim
  maintainer Cursor rule and CONTRIBUTING prose.
- **Tests:** longer timeouts on spawn-heavy doctor, report, and skill CLI cases.

## [1.0.6] - 2026-07-13

### Changed

- **Public content hygiene:** removed portfolio product names and private-repo links
  from docs, changelog history entries, and dogfood tests; renamed validation
  notes to generic `downstream-app-*` filenames.
- **CI guard:** `pnpm validate:portfolio-names` fails if blocked product names appear
  in tracked files (see [CONTRIBUTING.md](./CONTRIBUTING.md#public-repo-hygiene-portfolio-names)).
- **Cursor rule:** `integrations/cursor/no-portfolio-names.mdc` for maintainers (copy to
  `.cursor/rules/`).

## [1.0.5] - 2026-07-13

### Fixed

- **Drift:** out-of-scope path matching no longer fires on a lone integration token in a
  filename when the prohibition names sensitive qualifiers (e.g. `connect-link-button.tsx`
  vs “third-party production credentials”).
- **Drift:** constraint scoring ignores noise-only token overlaps (`task`, `hooks`,
  `component`, `web`, …) that caused false soft-blocks on large downstream PRs.
- **Extraction:** imperative clauses with embedded prohibitions (`Fix X … do not Y`)
  split correctly; colon-separated actions and `redirect` verbs land in `in_scope`;
  embedded `no config` no longer drops whole Fix sentences.

### Added

- **`conductor rules audit`** flags `drift_noisy_rule` for meta-rules likely to
  false-block path drift (refactor-beyond-task, skip hooks, design-system tokens).
- **Dogfood regression tests** for consuming-app onboarding, sync, and reconnect replay
  scenarios.

## [1.0.4] - 2026-07-12

### Fixed

- **`conductor doctor` respects `core.hooksPath`.** Repo-local hooks such as
  `.githooks/pre-commit` are detected instead of only `.git/hooks/pre-commit`.
- **Prohibition extraction:** no bare `without review` false positives; file
  paths in `do not modify …` clauses (e.g. `agents/registry.json`) are preserved.

## [1.0.3] - 2026-07-12

### Fixed

- **Compound file extensions end sentences correctly.** Periods after `.test.ts.`,
  `.spec.tsx.`, `.d.ts.`, etc. are sentence boundaries again; prompts no longer
  merge into a single >200-character clause that drops all `in_scope` items.
- **Extraction recognizes `Extract` as an action verb** so helper-extraction
  clauses land in `in_scope` (multi-clause extract prompts with an `Extract` verb).
- **Prohibition clause detection** no longer treats hyphenated words like
  `no-overwrite` as a `no …` prohibition when filtering `in_scope`.

## [1.0.2] - 2026-07-11

### Fixed

- **Extraction no longer breaks on `file.ts.` sentence boundaries.** Prompts like
  `itemFilter.ts. Verify…` no longer truncate `original_ask` at the extension
  period; the full first sentence is preserved.
- **Prohibition extraction false positives.** Bare `not …` matches inside verify
  clauses (e.g. "excludes strategies not in the selected preset") are no longer
  added to `out_of_scope`.

### Changed

- Cursor integration rule: one contract per feature branch; do not reuse stale
  contracts from unrelated tasks.

## [1.0.1] - 2026-07-09

### Added

- **Phase 3b (partial): brief correction dedup + cap.** Session Brief and generated
  `index.md` dedupe near-identical acknowledged correction rules (keep newest),
  drop entries older than 90 days from brief surfaces, and cap at 10 items. Full
  `correction_log` on the contract is unchanged. Promotion to constraints stays
  **explicit** (`conductor correct --promote` only).

### Changed

- **`conductor-extract --freeze` deprecation.** Removed flag now exits with a clear
  message pointing to `conductor-freeze`.
- Cursor integration rule references `conductor hook install` instead of the
  non-shipping `integrations/git-hooks` sample path.

## [1.0.0] - 2026-07-08

First stable release. The CLI surface and the `@vaultcompass/conductor-*` package
APIs are now covered by the [stability policy](./docs/release/stability-policy.md);
breaking changes require a major version bump.

### Added

- **Stable `1.0.0` line** for `@vaultcompass/conductor-{schema,core,skill,cli}`.

### Fixed

- **Intent extraction no longer shreds dotted file tokens.** `conductor extract`
  treated any `.` as a sentence boundary, so prompts mentioning paths like
  `.githooks`, `.github/workflows/conductor-drift.yml`, or `config.yaml` produced
  mangled `original_ask`/`in_scope` fragments (e.g. `"yml CI on pull requests"`).
  Periods now only end a sentence when followed by whitespace or end of input.

### Verified

- **consuming-app dogfood + real PR gate.** Conductor's pre-commit hook and CI drift job
  were exercised on a private downstream app repo: aligned changes pass,
  out-of-scope changes soft-block, and the `intent-drift` CI job is green.

## [0.3.0-beta.3] - 2026-07-07

### Fixed

- **Broken pre-commit guidance for npm installs.** `conductor init` previously
  told users to `cp integrations/git-hooks/...`, a path that does not ship in the
  published packages. `init` now points to `conductor hook install`.

### Added

- **`conductor hook install` / `conductor-hook`.** Writes a self-contained Git
  pre-commit hook that runs the enforcement gate on staged changes and resolves
  the CLI at commit time (no dependency on the Conductor source repo). Supports
  `--with-vault-guard`, `--force`, and refuses to clobber a foreign hook.

## [0.3.0-beta.2] - 2026-07-07

### Added

- **v1 launch path.** [v1-launch-checklist.md](./docs/release/v1-launch-checklist.md),
  [stability-policy.md](./docs/release/stability-policy.md), and
  `scripts/dogfood-app.sh` for consuming app dogfood before `1.0.0`.
- **npm package READMEs** for `@vaultcompass/conductor-{schema,core,skill,cli}` and
  keywords for registry discoverability.

### Changed

- Release workflow publishes with **`latest`** dist-tag (npm page shows current version).
- GitHub Actions integration samples use `@vaultcompass/conductor-cli@latest`.

## [0.3.0-beta.1] - 2026-07-07

### Fixed

- **`conductor init` from npm.** Default `config.yaml` is now generated from embedded
  defaults in `@vaultcompass/conductor-core` instead of reading
  `examples/conductor.config.example.yaml`, which is not shipped in published
  packages.

### Added

- **npm scope alignment.** Publishable packages now use the `@vaultcompass/*`
  scope (same org as vault-guard). GitHub org remains `vaultcompasshq`.
- **GitHub Actions release.** Tag `v*` triggers `.github/workflows/release.yml`
  for OIDC npm publish and post-publish CLI smoke.
  `--human` prints readable onboarding hints. `conductor report --with-secrets`
  appends an optional vault-guard staged scan when installed. Added offline
  lifecycle fixture tests for CI, `scripts/publish-beta.mjs`, and README npm
  install + AI session guardrails quickstart.
- **Drift handoff report.** Added `conductor report` / `conductor-report` for
  PR, CI, and agent handoffs. The report runs the gate, exits with the same
  status as `check`, and summarizes the active contract, drift score, blockers,
  acceptance criteria coverage, pivots, corrections, changed paths, signals,
  and recommended next action.
- **Rules audit.** Added `conductor rules audit` / `conductor-rules audit` to
  inspect `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursor/rules`,
  `.continue/rules`, and `.kiro/steering`. It reports loaded rules, duplicates,
  potential conflicts, stale or overbroad rules, and rules that may deserve
  critical priority.
- **Spec bridge.** Added `conductor import-spec` /
  `conductor-import-spec` to import Spec Kit or Kiro-style artifacts into an
  unfrozen Intent Contract draft. Supports auto-discovery plus explicit
  `--spec-dir`, `--requirements`, `--design`, and `--tasks` paths.
- **Path-only drift controls.** Drift scoring now derives generic source,
  manifest, API, documentation, and test signals from changed paths, so obvious
  out-of-scope source/package changes can block without requiring explicit
  `--signals`.
- **Setup doctor.** Added `conductor doctor` / `conductor-doctor` to diagnose
  local setup, active contract state, approval/freeze status, archive/index
  state, package version, and visible hook/workflow files. Supports readable
  output and `--json`.
- **Public repo validation harness.** Added
  `scripts/validate-public-repos.mjs` plus `pnpm validate:public-repos` for
  repeatable manual validation against public GitHub repositories, with optional
  markdown reports under `docs/validation/public-repos/`.
- **Optional vault-guard pairing.** `conductor doctor` now reports vault-guard
  config, binary, Git hook, and GitHub Actions references when present. Added a
  paired pre-commit sample and a paired CI sample for teams that want intent
  drift and secret scanning as independent gates.
- **Unified CLI beta package.** Added `@vaultcompass/conductor-cli` with the
  public `conductor <subcommand>` binary wrapping the existing command surface:
  `init`, `coach`, `extract`, `freeze`, `check`, `drift`, `correct`, `brief`,
  `resume`, `index`, and `pivot`. Added top-level `--help` and `--version`.
- **CI drift mode.** `conductor drift --ci` now exits `1` when the drift JSON has
  `block: true`, making lower-level drift scoring usable in GitHub Actions and
  other CI jobs.
- **Release smoke checks.** Added `pnpm release:smoke`, which packs schema,
  core, skill, and CLI tarballs locally and verifies required files plus packed
  dependency ranges.
- **Dependency audit cleanup.** Added a pnpm override for patched `esbuild` so
  `pnpm audit --audit-level low` is clean.
- **Production-readiness validation.** Added
  `docs/validation/production-readiness-2026-07-04.md`, covering unified CLI,
  resume, correction, pivot, archive, prior-contract drift, and `drift --ci`.
- **Release and CI docs.** Added a beta release checklist and a copyable GitHub
  Actions workflow sample for `conductor drift --ci`.

- **Real freeze/approval step (validation finding #2).** `conductor-extract` now
  writes an unfrozen draft only; approval is a separate `conductor-freeze`
  command that records an attributable `approval` block (approved_by /
  approved_at / method). On a TTY it shows a summary and asks to confirm;
  non-interactively it refuses unless `--approved-by <name>` is given, so an
  agent cannot self-approve. `isContractFrozen` now requires the approval
  record (not just `frozen_by: user`), closing the "hard gate" loophole.

- **Phase 3a — Correction Log + Session Brief.** `correction_log` on the Intent
  Contract (schema + types) captures agent mistakes the user corrected as
  durable rules. `conductor-correct` records them (pending by default;
  `--acknowledge` to confirm, `--promote` to mirror into `constraints[]` as a
  `user-correction` rule the drift scorer enforces — off by default).
  `conductor-brief` emits the minimal correct-methodology context (intent,
  scope, AC, constraints, acknowledged corrections, no failed code) to
  re-inject after a context reset. New `capture-correction` skill. Conservative
  defaults per the design spec: no auto-promote, separate from `pivot_log`,
  append-only. See `docs/superpowers/specs/2026-06-20-correction-log-and-brief.md`.
- Constraint-loader precision fix: `extractConstraintsFromMarkdown` now requires
  normative language / leading prohibitions / rules-section bullets and skips
  tables, links, and code fences (real AGENTS.md: 12 bogus rules → 4 real ones).
  Resolves validation finding #1.

- `conductor-check` CLI + `checkGate()` — a real enforcement gate that exits
  non-zero when no frozen contract exists or staged changes drift past a
  blocking threshold (vs. advisory SKILL.md). Sample git pre-commit hook in
  `integrations/git-hooks/pre-commit.sample`.
- `packages/core/src/tokenize.ts` — generic, domain-agnostic token matching.
- `packages/skill/tests/cli.test.ts` — integration tests for all five CLIs
  (previously zero coverage on the skill package).
- Drift generality tests (`packages/core/tests/drift-generality.test.ts`) on a
  novel contract the scorer was never tuned against.
- GitHub Actions CI (`.github/workflows/ci.yml`): typecheck + build + test.

### Changed

- **Drift scorer rebuilt** to be project-independent. Removed the five
  fixture-specific path regexes and four hardcoded signal strings that only
  fired on the sample desktop app example. Matching now derives entirely from the
  contract's own `in_scope` / `out_of_scope` / `constraints` text, with
  in-scope-token subtraction to suppress false positives and a severity floor
  so a single out-of-scope or critical-constraint hit can block. `--signals`
  is now documented as open-vocabulary free text.
- Root `pnpm test` now builds first (skill CLI tests run the compiled `dist/`).
- GitHub Actions integration docs now mark package-install workflow samples as
  post-publish templates until `@vaultcompass/conductor-cli` is available on
  npm.
- Constraint loading now deduplicates identical rules across loaded files and
  keeps the highest priority copy.
- Public repo validation now defaults to 8 repositories and checks both
  explicit-signal drift and path-only source/package drift.

### Fixed

- Prohibition lists such as "Do not change source code, package metadata, or
  runtime behavior" now expand into separate out-of-scope items, so path-only
  manifest changes have a contract item to match.
- Prohibition clauses such as "Do not add new API endpoints" no longer leak
  into `in_scope`, and overlapping prohibition matches are deduped in
  `out_of_scope`. This fixes a validation case where prior-contract drift was
  masked by in-scope token subtraction.
- Corrected test-count claims across README / NEXT / AGENTS (was "29"/"14",
  actual is 39: schema 3 + core 22 + skill 8 + examples 6).
- Tightened README multi-model / downstream pipeline language to reflect that those
  integrations are design-stage, not shipped.

## [0.2.0-beta] - 2026-06-17

### Added

- `@vaultcompass/conductor-skill` — Superpowers skills (`intent-contract`, `prompt-coach`, `drift-guard`)
- Helper CLIs: `conductor-coach`, `conductor-extract`, `conductor-drift`, `conductor-init`
- Root scripts: `pnpm conductor:coach`, `conductor:extract`, `conductor:drift`, `conductor:init`, `conductor:install-skills`
- Core runtime: `extract.ts`, `constraints.ts` (incl. `.cursor/rules`), `config.ts`, `init.ts`, `drift-log.ts`
- `.conductor/` directory spec — `docs/schemas/directory-layout.md`
- Phase 2 validation retrospective — `docs/validation/phase2-retrospective.md`
- Example contract `examples/intent-contracts/conductor-phase2.yaml`
- `integrations/superpowers/install-skills.sh`

### Changed

- Drift scorer: configurable thresholds, CLI path detection, keyword matching, critical hard-block at 86+

### Tests

- 29 passing (18 core + 3 schema + 6 examples)

## [0.1.0-alpha] - 2026-06-17

### Added

- `@vaultcompass/conductor-schema` package — Intent Contract JSON Schema v1.0.0 with Ajv validation
- `@vaultcompass/conductor-core` package — prompt coach and drift scoring engines
- 5 example intent contracts in `examples/intent-contracts/`
- sample desktop app retrospective exit gate (drift score 83)
- Phase 1 implementation plan (`docs/superpowers/plans/2026-06-17-conductor-phase1.md`)
- GitHub repository: https://github.com/vaultcompasshq/conductor
- Brainstorming session and design documentation (2026-06-17)
- Competitive analysis and repo strategy
- 14-week implementation roadmap
- Integration guides: Superpowers, downstream pipelines, Cursor

## [0.0.0] - 2026-06-17

- Repository initialized — design phase only
