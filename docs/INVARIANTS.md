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

The default is `1.8.0` at `action.yml:41`.

## On a pull request, `version` may not pin older than this tag's scanner

`IG_TAG_SCANNER_MAJOR`, `IG_TAG_SCANNER_MINOR` and `IG_TAG_SCANNER_PATCH`
are `1`, `8` and `0` at `action.yml:257` through `action.yml:259`.
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

They are not right now: `README.md:265` pins `vaultcompasshq/intent-guard@v1.8.0`,
and `README.md:272` says that tag installs `@vaultcompass/intent-guard@1.8.0`,
because this release moved the action tag and the packages together. They
diverged briefly at 1.5.3, an action-only tag documented at
`CHANGELOG.md:237` that moved the workflow file without publishing new
packages; `CHANGELOG.md:264` still records that history, naming
`IG_TAG_SCANNER` as 1.5.2 on the 1.5.3 tag. The installed
version is the `version` input default at `action.yml:41`, the scanner
constant at `action.yml:257` through `action.yml:260`, and the package
version `1.8.0` in `package.json:4`, `packages/cli/package.json:3`,
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
`-z` (`packages/skill/src/changed-paths.ts:89` for `--staged`,
`packages/skill/src/changed-paths.ts:157` for `--base`). Without `-z`, git
C-quotes a name holding a double quote, backslash, tab or newline even with
`core.quotePath=false`, and the quoted string matches no protected glob. Pinned
by `packages/skill/tests/base-ref.test.ts`, the `NUL-separated path collection`
tests: `hard-blocks a double quote file name in a protected dir with --base`,
`... with --staged`, and the backslash and tab pairs of the same names. The
hook does the same, pinned by `passes a path with a double quote, a backslash,
a tab and non-ASCII characters literally` in
`examples/validate-integrations.test.ts`.

A newline in a name also has to match `**`. `packages/core/src/budget.ts:92`
builds the glob regexp with the `s` flag, so `.` (from `**`) matches a newline.
It is the only `RegExp` in `packages/*/src` built from a glob. Pinned by
`matches ** and * across a path containing a newline` in
`packages/core/tests/budget.test.ts`; by the `newline in a file name` tests in
`packages/skill/tests/base-ref.test.ts` (`hard-blocks --base`, `hard-blocks
--staged`, `hard-blocks --paths`, a staged rename and a committed rename out of
secrets/); and end to end through the hook by `blocks an untracked new file
with a newline in its name under secrets/`, `blocks a staged rename of such a
file out of secrets/` and `blocks a committed rename of such a file out of
secrets/` in `examples/validate-integrations.test.ts`.

`--staged` and `--base` never turn a git failure into an empty list.
`packages/skill/src/changed-paths.ts:55` raises `maxBuffer` to 256 MB (the 1 MB
default threw ENOBUFS, which used to pass), and `stagedPaths` returns empty only
when `git rev-parse --git-dir` says "not a git repository"
(`changed-paths.ts:70` through `:80`); every other failure exits 2
(`changed-paths.ts:102`). Pinned by `still blocks when the staged name list is
larger than 1 MB` (a real 1.3 MB list, not an injected size), `passes quietly
outside a git repository, as before` and `exits 2 on any other git failure`.

## The Stop hook judges untracked and session-committed work, and fails closed

`integrations/hooks/conductor-lib.sh:200` (`intent_guard_changed_paths_csv`)
diffs the working tree and the index against the session baseline and adds
`ls-files --others --exclude-standard` (`conductor-lib.sh:218`), all with `-z`.
A git failure returns non-zero (`conductor-lib.sh:182`) and
`conductor-stop-check.sh:78` routes that to `could_not_run` (see the loop policy
below) rather than an empty list.
A path containing a comma is refused (`conductor-lib.sh:228`), because `--paths`
splits on commas. Each path is passed as `./<path>` (`conductor-lib.sh:234`) so a
leading `-` is not read as a flag. Pinned in `examples/validate-integrations.test.ts`
by `judges an untracked new file`, `judges work committed since the session
began`, `does not judge work committed before the session began`, `fails closed
with a clear message when git cannot list the changes`, `refuses a path
containing a comma instead of splitting it`, `adds a leading ./ to every path so
a name starting with a dash is not read as a flag` and `does not block the stop
on a dash-prefixed name with the real gate`.

Stop hook loop policy, exactly. The gate's exit status is split at
`conductor-stop-check.sh:101`: status 1 is a finding and always blocks
(`lifecycle_block`, exit 2), regardless of `stop_hook_active`; any other non-zero
status is could-not-run (`conductor-stop-check.sh:106`). Every could-not-run
condition (gate exit 2 or 127, no binary at `:70`, path collection failure at
`:83`) calls `could_not_run` (`:57`): with `stop_hook_active` not true (read at
`:17` through `:22`, absent or unparseable counts as not true) it blocks with
exit 2, and with it true it exits 0 (`:65`) after writing the cause and "CI
`--base` is the enforcement boundary" to stderr and a `systemMessage` JSON object
to stdout. Stdout is empty on a pass and on every block. Pinned by, for the
existing stub tests, `blocks the stop when the gate exits 2` and `blocks the stop
when the gate exits 127` (no `stop_hook_active`, so they block); and by the
`stop hook loop policy` group, per class: `blocks on <class> when
stop_hook_active is false`, `blocks on <class> when the field is absent or
unparseable`, `allows the stop with a loud message on <class> when
stop_hook_active is true`, with `still blocks a finding when stop_hook_active is
true (stub gate exits 1)` and `still blocks a real budget hard_block when
stop_hook_active is true` for findings.

The session baseline is written by `conductor-session-start.sh:27` through
`intent_guard_record_session_start` (`conductor-lib.sh:110`), which reads the
host's `source` (`conductor-session-start.sh:23`). `startup` and `clear` always
record a fresh baseline, `resume`, `compact` and an absent source keep a valid
one. Pinned by `starts a fresh baseline on a new session (source startup), so a
human commit between sessions is not judged` (and the `clear` twin), `keeps the
session baseline when SessionStart fires again with source resume` (and
`compact`, `absent`), and `starts a fresh baseline when the contract id
changes`. `intent_guard_baseline_valid` (`conductor-lib.sh:90`) accepts a
recorded ref only if it is a full object id naming the empty tree or a commit
that is an ancestor of HEAD, and `intent_guard_baseline_ref`
(`conductor-lib.sh:142`) fails closed otherwise. Pinned by the `baseline record
integrity` tests: `refuses a record that points at a tree, such as HEAD^{tree}`,
`refuses a record that is a name rather than an object id, such as HEAD`,
`refuses a record for a commit that is not an ancestor of HEAD`, `refuses a
garbage record`, and `accepts the empty tree, the widest baseline`. With no
record and no upstream it fails closed (`fails closed with no session-start
record and no upstream`), with the operator escape `INTENT_GUARD_NO_BASELINE_OK=1`
(`INTENT_GUARD_NO_BASELINE_OK=1 falls back to HEAD with a warning`) and the
upstream stand-in (`with no record but an upstream branch, judges changes since
the upstream`).

The Stop hook does not loop on what the agent cannot fix. `conductor-stop-check.sh`
reads `stop_hook_active` from stdin (absent or unparseable means false), and
`could_not_run` blocks unless it is true, when it exits 0 with a message on
stderr and a `systemMessage` on stdout; a gate exit of exactly 1 always blocks
(the `status -eq 1` branch), so a finding is never let through. Pinned in
`examples/validate-integrations.test.ts`, group `stop hook loop policy`, once per
class (no baseline and no upstream, an invalid baseline record, a git failure
during collection, a comma in a path, a backslash in a path, the gate exiting 2,
the gate exiting 127, no gate binary): `blocks on <class> when stop_hook_active
is false`, `blocks on <class> when the field is absent or unparseable`, `allows
the stop with a loud message on <class> when stop_hook_active is true`; and
findings: `still blocks a finding when stop_hook_active is true (stub gate exits
1)`, `still blocks a real budget hard_block when stop_hook_active is true`.

`allow_new_dependencies` sees manifests under directories with a newline in
their name and does not mistake `x` NEWLINE `package.json` for one. Pinned by
`still sees a manifest inside a directory whose name contains a newline` and
`does not treat a file named like a manifest with a newline prefix as one` in
`packages/core/tests/budget.test.ts`.

These hooks are a tripwire, not a boundary: the baseline file is writable by the
agent, and re-pointing it at a newer ancestor commit is not detectable. CI with
`--base` and `--trust-base` is the enforcement boundary.

## The hook runs the in-repo dist only on an operator opt-in

`integrations/hooks/conductor-lib.sh:30` uses `packages/skill/dist` only when the
hook's environment has `INTENT_GUARD_DEV_DIST=1`; otherwise it resolves the binary
on `PATH`. Nothing in the repository can set it (an earlier design keyed on the
root `package.json` name, which an agent can rename in the same edit that plants
the dist). Pinned by `does not run a planted in-repo dist by default`, `does not
run a planted dist when package.json is renamed to intent-guard`, `does not run
a planted dist when there is no package.json at all` and `runs the in-repo dist
only when the operator sets INTENT_GUARD_DEV_DIST=1` in
`examples/validate-integrations.test.ts`. An operator who sets the variable
trusts a gitignored dist the agent may be able to write.

## Explicit changed paths are refused when they could dodge a glob

`packages/skill/src/changed-paths.ts:187` calls `explicitPathIssue`
(`changed-paths.ts:115`) on every `--paths` entry and exits 2 (`changed-paths.ts:192`)
for a `..` segment, a `.` segment anywhere other than the one accepted leading
`./`, an empty segment (`a//b`, `.//x`), a leading `/`, or a backslash. They are
refused, not normalized, because `src/../secrets/k` never matched `secrets/**`
while naming a protected file. intent-guard's own git reads (`--staged`,
`--base`) are not subject to this. A caller that forwards paths through `--paths`
must read git with `-z` and never forward git's C-quoted form, which would
otherwise reach the budget quoted and match no glob. Pinned in
`packages/skill/tests/base-ref.test.ts` by `refuses a --paths entry with a ..
segment instead of letting it slip past a protected glob`, `refuses a leading ..
segment too, in report`, and the `explicit path shapes are refused like budget
globs` tests (`refuses a leading ./ followed by another . segment`, `refuses an
empty segment after ./`, `refuses an internal empty segment`, `refuses a leading
slash`, `refuses a backslash`); `still accepts a name that merely contains dots`
and `still accepts a single leading ./ and a trailing slash` guard against
over-refusing.
