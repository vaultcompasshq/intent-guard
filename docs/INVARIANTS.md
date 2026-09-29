# Invariants

Properties of the composite action and the public-repo hygiene gate, each
tied to the line that makes it true. This is not a complete list of the
repository. Open the cited line; the sentence is only as good as that line.

## The `version` input is an exact release, checked twice

The accepted shape is `^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`.
It is written in the input description at `action.yml:21`, and it is the
match at `action.yml:208` and again at `action.yml:278`. The second match
does not reuse `BASH_REMATCH` from the first: `action.yml:271` says the
array is read again on purpose. A leading-zero form does not match, which
is the point of `[1-9][0-9]*` rather than `[0-9]+`.

The drift check counts the shape three times in total and the executable
form `[[ ! "${IG_VERSION}" =~ <shape> ]]` twice
(`scripts/tests/action-hardening-drift.test.mjs`). The description is the
third copy. Removing one executable match drops both counts.

The default is `1.7.0` at `action.yml:41`.

## On a pull request, `version` may not pin older than this tag's scanner

`IG_TAG_SCANNER_MAJOR`, `IG_TAG_SCANNER_MINOR` and `IG_TAG_SCANNER_PATCH`
are `1`, `7` and `0` at `action.yml:257` through `action.yml:259`.
`IG_TAG_SCANNER` is assembled from those three at `action.yml:260`. The
comparison that refuses an older pin is `action.yml:300` through
`action.yml:307`, and the error that names both versions is
`action.yml:311`. The comparison runs only when `GITHUB_BASE_REF` is
non-empty (`action.yml:270`).

That constant is trusted only when the workflow names this action by owner
and ref (`vaultcompasshq/intent-guard@TAG`). A local-path reference, the
`./some/dir` form, reads `action.yml` out of the pull request's own tree, so
the constant is author-controlled and the rule protects nothing there.
`action.yml:251` through `action.yml:256` says so. Self-testing workflows
inside this repository are the usual reason to reference it that way. The
drift check pins the three assignment lines as executable lines, so a
comment that repeats `IG_TAG_SCANNER_MINOR=5` does not keep the pin green.

## npm older than 10.5.2 is refused before install

The floor is accept-only. `action.yml:538` accepts a major above 10.
`action.yml:540` accepts major 10, then `action.yml:541` accepts a minor
above 5, and `action.yml:543` accepts minor 5 with patch at least 2. Anything
else leaves `NPM_OK` at 0. The refusal text is `action.yml:549`: `npm 10.5.2
or newer`. The remediation is `action.yml:550`: Node 20.13.0 and later, and
22.1.0 and later, are fine; 22.0.0 ships npm 10.5.1.

README states the same floor at `README.md:281` and the same Node bound at
`README.md:284` through `README.md:285`. The drift check also pins the
remediation printf at `action.yml:550` as an executable line.

The drift check pins the five comparison fragments and the `npm 10.5.2 or
newer` sentence. The comment at `action.yml:490` says `OR NEWER` in
capitals, so it is not that sentence.

## The scanner is installed with `--ignore-scripts`

The install line is `action.yml:560`:

`npm install -g --ignore-scripts "@vaultcompass/intent-guard@${IG_VERSION}"`

The comment at `action.yml:554` names the flag. It is not that command. The
drift check pins the command.

## `npm audit signatures` runs in a subshell on the synthetic manifest

The invocation is `action.yml:602`:

`( cd "${npm_config_prefix}/lib" && npm audit signatures )`

`action.yml:493` and `action.yml:565` also contain the words `npm audit
signatures`. They are comments. The drift check pins the subshell, so those
comments do not keep it green. The synthetic manifest the command depends on
is written at `action.yml:575`.

## The action tag and the installed package can be different numbers

They are not right now: `README.md:265` pins `vaultcompasshq/intent-guard@v1.7.0`,
and `README.md:272` says that tag installs `@vaultcompass/intent-guard@1.7.0`,
because this release moved the action tag and the packages together. They
diverged briefly at 1.5.3, an action-only tag documented at
`CHANGELOG.md:149` that moved the workflow file without publishing new
packages; `CHANGELOG.md:176` still records that history, naming
`IG_TAG_SCANNER` as 1.5.2 on the 1.5.3 tag. The installed
version is the `version` input default at `action.yml:41`, the scanner
constant at `action.yml:257` through `action.yml:260`, and the package
version `1.7.0` in `package.json:4`, `packages/cli/package.json:3`,
`packages/core/package.json:3`, `packages/schema/package.json:3` and
`packages/skill/package.json:3`. Whenever a future action-only tag moves
`action.yml` without a package release, this section goes stale again the
same way, and the next package release is what re-converges it.

## Public repository hygiene is a lint, and CI runs it

`scripts/check-public-hygiene.mjs:20` through `scripts/check-public-hygiene.mjs:24`
name the union across dep-guard, vault-guard, intent-guard and conductor.
The dash rule is built from code points at `scripts/check-public-hygiene.mjs:85`
and applied at `scripts/check-public-hygiene.mjs:142`, before the allowlist
return at `scripts/check-public-hygiene.mjs:158`, so an allowlisted file is
not exempt from a non-ASCII dash. `package.json:11` wires the script as
`pnpm lint`. `.github/workflows/ci.yml:37` runs that script in the
build-test job.

## A bot co-author trailer fails the pull request

`.github/workflows/ci.yml:58` is the step `Refuse pull requests with bot
co-author trailers`. The pattern is `.github/workflows/ci.yml:66`.
`scripts/tests/coauthor-trailer.test.mjs` reads that pattern from the
executable line only, skipping lines that begin with `#`, and matches a
planted `cursoragent@cursor.com` trailer, a `noreply@anthropic.com` trailer,
and a `[bot]` trailer. A message with no trailer does not match. A comment
that copies the strong pattern does not keep the check green if the
executable line is weaker.

## Changed paths are collected NUL-separated

`packages/skill/src/changed-paths.ts:30` splits on NUL, and both git calls pass
`-z` (`packages/skill/src/changed-paths.ts:65` for `--staged`,
`packages/skill/src/changed-paths.ts:101` for `--base`). Without `-z`, git
C-quotes a name holding a double quote, backslash, tab or newline even with
`core.quotePath=false`, and the quoted string matches no protected glob. Pinned
by `packages/skill/tests/base-ref.test.ts`, the `NUL-separated path collection`
tests: `hard-blocks a double quote file name in a protected dir with --base`,
`... with --staged`, and the backslash and tab pairs of the same names. The
hook does the same, pinned by `passes a path with a double quote, a backslash,
a tab and non-ASCII characters literally` in
`examples/validate-integrations.test.ts`.

## The Stop hook judges untracked and session-committed work, and fails closed

`integrations/hooks/conductor-lib.sh:170` (`intent_guard_changed_paths_csv`)
diffs the working tree and the index against the session baseline and adds
`ls-files --others --exclude-standard` (`conductor-lib.sh:188`), all with `-z`.
The baseline is recorded by `conductor-session-start.sh:15` through
`intent_guard_record_session_start` (`conductor-lib.sh:96`) under the git
directory, never the tracked tree. A git failure returns non-zero
(`conductor-lib.sh:152`) and `conductor-stop-check.sh:33` turns that into exit 2
rather than an empty list. A path containing a comma is refused
(`conductor-lib.sh:198`), because `--paths` splits on commas. Pinned in
`examples/validate-integrations.test.ts` by `judges an untracked new file`,
`judges work committed since the session began`, `does not judge work
committed before the session began`, `keeps the session baseline across a
resume under the same contract`, `starts a fresh baseline when the contract id
changes`, `fails closed with a clear message when git cannot list the changes`
and `refuses a path containing a comma instead of splitting it`. Every non-zero
gate status blocks the stop (`conductor-stop-check.sh`, the `-ne 0` test):
`blocks the stop when the gate exits 2` and `... exits 127`.

## The hook runs the in-repo dist only in intent-guard's own repository

`integrations/hooks/conductor-lib.sh:24` (`intent_guard_is_own_repo`) requires
the root `package.json` to name the package `intent-guard`, and
`conductor-lib.sh:31` uses `packages/skill/dist` only then; every other
repository resolves the binary on `PATH`. Pinned by `does not run an in-repo
dist in a repository that is not intent-guard's own`, `does not run an in-repo
dist when there is no package.json at all` and `runs the in-repo dist in
intent-guard's own repository` in `examples/validate-integrations.test.ts`.
The gitignored dist in the own repository is still trusted; the check narrows
who gets it, it does not sign it.

## A changed path with a `..` segment is refused

`packages/skill/src/changed-paths.ts:125` exits 2 for any `--paths` entry with a
`..` segment, before the budget sees it. It is refused, not normalized, because
`src/../secrets/k` never matched `secrets/**` while naming a protected file.
Pinned by `refuses a --paths entry with a .. segment instead of letting it slip
past a protected glob` and `refuses a leading .. segment too, in report` in
`packages/skill/tests/base-ref.test.ts`; `still accepts a name that merely
contains dots` guards against over-refusing `a..b`.
