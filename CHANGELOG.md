# Changelog

All notable changes to Intent Guard (published as Conductor through 1.1.0) will
be documented in this file.

Format based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

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
